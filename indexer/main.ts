// UP33 LP-terminal pool indexer — catalog (factory events/enumeration) +
// on-chain state sweeps + GT enrichment, served over a tiny read-only API.
// Run: `npm run indexer` (tsx). Data lives in indexer/data/index.db (SQLite).
//
// Boot: backfill → token meta → full state sweep → GT cycle → reprice → ready.
// Loops: tail 10s · hot sweep 60s · full sweep 60min · GT stats 5min.
// The API starts listening immediately; `ready:false` in responses tells the
// frontend to keep using its client-side fallback until the first pass lands.
import { log, PORT, TUNE } from './config'
import { usingPrivateRpc } from './rpc'
import { birdeyeCycle, birdeyeEnabled } from './birdeye'
import { backfillV3, syncV2, tailV3 } from './catalog'
import { dipCycle } from './dips'
import { computeTvlFor, ensureTokenMeta, reprice, sweepState } from './state'
import { gtCycle } from './stats'
import { activeAddrs, allPoolAddrs, db, hotAddrs, kvGet, kvSet, poolCounts } from './store'
import { startApi } from './api'
import { startTgBot } from './tgbot'
import { tgEnabled, watchAddrs, watchCycle, watchEnabled } from './watch'

/** setTimeout-chained loop — never overlaps itself, logs failures and keeps going */
function loop(name: string, ms: number, fn: () => Promise<void>): void {
  const tick = async () => {
    try {
      await fn()
    } catch (e) {
      log(`[${name}] error:`, String(e).slice(0, 200))
    }
    setTimeout(tick, ms)
  }
  setTimeout(tick, ms)
}

const timed = async <T,>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = Date.now()
  const r = await fn()
  return [r, Date.now() - t0]
}

async function boot(): Promise<void> {
  log('up33 lp-indexer starting —', usingPrivateRpc ? 'rpc: private (.env)' : 'rpc: public')
  startApi()

  const [addedV3, msV3] = await timed(backfillV3)
  if (addedV3 > 0 || !kvGet('v3_boot_logged')) {
    log(`[catalog] univ3 backfill done: +${addedV3} pools (${(msV3 / 1000).toFixed(0)}s)`)
    kvSet('v3_boot_logged', '1')
  }
  const [freshV2, msV2] = await timed(syncV2)
  if (freshV2.length) log(`[catalog] univ2 sync: +${freshV2.length} pairs (${(msV2 / 1000).toFixed(0)}s)`)
  log('[catalog]', poolCounts().map((c) => `${c.proto}=${c.n}`).join(' '))

  const [metaN, msMeta] = await timed(ensureTokenMeta)
  if (metaN) log(`[tokens] metadata fetched for ${metaN} tokens (${(msMeta / 1000).toFixed(0)}s)`)

  const all = allPoolAddrs()
  const [, msSweep] = await timed(() => sweepState(all))
  log(`[sweep] full ${all.length} pools (${(msSweep / 1000).toFixed(0)}s)`)

  await gtCycle().catch((e) => log('[stats] gt cycle failed:', String(e).slice(0, 120)))
  const pr = reprice()
  log(`[price] ${pr.priced} tokens priced · tvl on ${pr.tvlPools} pools`)

  kvSet('ready', '1')
  log(`READY — http://localhost:${PORT}/api/health`)

  loop('tail', TUNE.tailMs, async () => {
    const fresh = [...(await tailV3()), ...(await syncV2())]
    if (fresh.length) {
      log(`[tail] ${fresh.length} new pools`)
      await ensureTokenMeta()
      await sweepState(fresh)
      computeTvlFor(fresh)
    }
  })
  loop('hot', TUNE.hotSweepMs, async () => {
    const hot = hotAddrs()
    await sweepState(hot)
    computeTvlFor(hot)
  })
  loop('active', TUNE.fullSweepMs, async () => {
    const addrs = activeAddrs()
    const [, ms] = await timed(() => sweepState(addrs))
    const p = reprice()
    log(`[sweep] active ${addrs.length} pools (${(ms / 1000).toFixed(0)}s) · ${p.priced} tokens priced · tvl on ${p.tvlPools}`)
  })
  loop('census', TUNE.censusMs, async () => {
    const addrs = allPoolAddrs()
    const [, ms] = await timed(() => sweepState(addrs))
    const p = reprice()
    log(`[sweep] census ${addrs.length} pools (${(ms / 1000).toFixed(0)}s) · tvl on ${p.tvlPools}`)
  })
  loop('stats', TUNE.statsMs, async () => {
    await gtCycle()
    reprice()
  })
  await dipCycle().catch((e) => log('[dips] first cycle failed:', String(e).slice(0, 160)))
  loop('dips', 600_000, dipCycle)
  if (birdeyeEnabled()) {
    log('[birdeye] smart-money sync on (key found)')
    await birdeyeCycle().catch((e) => log('[birdeye] first cycle failed:', String(e).slice(0, 160)))
    loop('birdeye', 1_800_000, birdeyeCycle)
  } else {
    log('[birdeye] disabled — set BIRDEYE_API_KEY in .env for smart-money PnL')
  }
  if (watchEnabled()) {
    log(`[watch] tracking ${watchAddrs().length} wallet(s) · telegram ${tgEnabled() ? 'on' : 'off (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)'}`)
    await watchCycle().catch((e) => log('[watch] first cycle failed:', String(e).slice(0, 200)))
    loop('watch', TUNE.watchMs, watchCycle)
  } else {
    log('[watch] disabled — set WATCH_ADDRESSES in .env to track positions')
  }
  startTgBot()
}

process.on('SIGINT', () => {
  log('shutting down')
  db.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  db.close()
  process.exit(0)
})

boot().catch((e) => {
  log('FATAL boot:', e)
  process.exit(1)
})
