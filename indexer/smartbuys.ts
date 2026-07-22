// Smart-buys tape — "what did the profitable wallets just buy?"
//
// Wallet list: the Birdeye leaderboard already cached in wallet_pnl (so this
// module wakes up only when BIRDEYE_API_KEY exists). The BUYS themselves come
// from Blockscout token-transfer logs — free, uncapped, and on-chain truth —
// so the Birdeye quota is spent only on the 30-min leaderboard sync, never on
// per-wallet polling (HOODRADAR burns Birdeye calls for this; we don't).
//
// Filters, in order:
//   bot cut   — leaderboard rows with volume > $2M or 500+ trades are MEV/arb
//               churners, their "buys" are noise
//   dust cut  — buys under $20 (when priced) are ignored entirely
//   sec gate  — GMGN honeypot/alert/50%-tax verdict drops the token
//   alert bar — telegram only for priced buys ≥ $100, or the same token hit
//               by ≥2 smart wallets in one cycle (consensus beats size)
// Cooldown: one alert per token per 6h. Everything ≥$20 lands in smart_buys
// (7d) for /api/smartbuys + the ANALYZE table either way.
import { ADDR, BLOCKSCOUT, log, now, sleep } from './config'
import { birdeyeEnabled } from './birdeye'
import { ensureSecurity, isUnsafe, securityOf } from './gmgn'
import {
  allWalletPnl,
  bestPoolOf,
  insertSmartBuy,
  kvGet,
  kvSet,
  pruneSmartBuys,
  recentSmartBuys,
  tokenRows,
} from './store'
import { sendTg, tgEnabled } from './watch'

const TUNE = {
  topToday: 15,
  top1w: 10,
  botMaxVolume: 2_000_000, // leaderboard volume above this = arb bot, skip
  botMaxTrades: 500,
  minBuyUsd: 20, // store bar (priced buys)
  alertUsd: 100, // single-wallet alert bar
  consensusWallets: 2, // unpriced/small buys alert when N wallets converge
  tokenCooldownSecs: 6 * 3_600,
  firstRunLookbackSecs: 1_800, // fresh cursor: only look 30 min back, not history
  keepDays: 7,
  paceMs: 350, // between Blockscout wallet queries
}

const ANCHORS = new Set([ADDR.WETH.toLowerCase(), ADDR.USDG.toLowerCase()])

export const smartBuysEnabled = (): boolean => birdeyeEnabled()

type BsTokenTx = {
  hash: string
  to: string
  from: string
  contractAddress: string
  value: string
  tokenDecimal: string
  tokenSymbol: string
  timeStamp: string
  blockNumber: string
}

async function tokenTxs(wallet: string, startBlock: number): Promise<BsTokenTx[] | null> {
  try {
    const r = await fetch(
      `${BLOCKSCOUT}/api?module=account&action=tokentx&address=${wallet}&startblock=${startBlock}&sort=asc`,
      { headers: { accept: 'application/json', 'user-agent': 'alphast-indexer/0.1' }, signal: AbortSignal.timeout(20_000) },
    )
    const j = (await r.json()) as { status?: string; message?: string; result?: BsTokenTx[] }
    if (j.status === '1' && Array.isArray(j.result)) return j.result
    if (/no transactions/i.test(String(j.message))) return []
    return null
  } catch {
    return null
  }
}

type Candidate = {
  tx: string
  wallet: string
  token: string
  symbol: string
  ts: number
  amount: number
  usd: number | null
  win: string
  rank: number
  pnl: number | null
}

export async function smartBuysCycle(): Promise<void> {
  if (!smartBuysEnabled()) return
  const t = now()

  // smart set = top-N per window minus obvious bots, deduped
  const rows = allWalletPnl().filter(
    (r) =>
      (r.win === 'today' ? r.rank <= TUNE.topToday : r.rank <= TUNE.top1w) &&
      (r.volume ?? 0) <= TUNE.botMaxVolume &&
      (r.trade_count ?? 0) <= TUNE.botMaxTrades,
  )
  const wallets = new Map<string, (typeof rows)[number]>()
  for (const r of rows) if (!wallets.has(r.address)) wallets.set(r.address, r)
  if (!wallets.size) return

  const candidates: Candidate[] = []
  for (const [w, lb] of wallets) {
    const ck = `sb_cursor:${w}`
    const cursor = Number(kvGet(ck) ?? 0)
    const txs = await tokenTxs(w, cursor > 0 ? cursor + 1 : 0)
    await sleep(TUNE.paceMs)
    if (txs === null) continue // flake — same cursor retries next cycle
    let maxBlock = cursor
    for (const x of txs) {
      const blk = Number(x.blockNumber)
      if (blk > maxBlock) maxBlock = blk
      const ts = Number(x.timeStamp)
      if (cursor === 0 && ts < t - TUNE.firstRunLookbackSecs) continue // no history dump on first run
      if (x.to.toLowerCase() !== w) continue // incoming transfers only
      const token = x.contractAddress.toLowerCase()
      if (ANCHORS.has(token)) continue // receiving WETH/USDG = a sell, not a buy
      const dec = Number(x.tokenDecimal || 18)
      const amount = Number(x.value) / 10 ** dec
      if (!Number.isFinite(amount) || amount <= 0) continue
      const [tr] = tokenRows([token])
      const usd = tr?.price_usd != null && tr.price_usd > 0 ? amount * tr.price_usd : null
      if (usd !== null && usd < TUNE.minBuyUsd) continue
      candidates.push({
        tx: x.hash.toLowerCase(),
        wallet: w,
        token,
        symbol: tr?.symbol && tr.symbol !== '?' ? tr.symbol : x.tokenSymbol || '?',
        ts,
        amount,
        usd,
        win: lb.win,
        rank: lb.rank,
        pnl: lb.pnl,
      })
    }
    if (maxBlock > cursor) kvSet(ck, String(maxBlock))
  }
  if (!candidates.length) {
    pruneSmartBuys(t - TUNE.keepDays * 86_400)
    return
  }

  // security gate before anything is stored or said
  await ensureSecurity([...new Set(candidates.map((c) => c.token))])
  const safe = candidates.filter((c) => !isUnsafe(securityOf(c.token)))
  const droppedN = candidates.length - safe.length
  if (droppedN) log(`[smartbuys] dropped ${droppedN} unsafe buy(s)`)

  // consensus count per token (this cycle)
  const byToken = new Map<string, Set<string>>()
  for (const c of safe) {
    const s = byToken.get(c.token) ?? new Set<string>()
    s.add(c.wallet)
    byToken.set(c.token, s)
  }

  let alerts = 0
  for (const c of safe) {
    const consensus = (byToken.get(c.token)?.size ?? 0) >= TUNE.consensusWallets
    const worthAlert = (c.usd !== null && c.usd >= TUNE.alertUsd) || consensus
    const cooled = t - Number(kvGet(`sb_alert:${c.token}`) ?? 0) >= TUNE.tokenCooldownSecs
    const shouldAlert = worthAlert && cooled && tgEnabled()
    const fresh = insertSmartBuy(c, shouldAlert)
    if (!fresh || !shouldAlert) continue
    kvSet(`sb_alert:${c.token}`, String(t))
    alerts++
    const pool = bestPoolOf(c.token)
    const usdTxt = c.usd !== null ? `$${Math.round(c.usd).toLocaleString('en-US')}` : `${c.amount.toPrecision(3)} ${c.symbol}`
    const who = consensus
      ? `${byToken.get(c.token)!.size} smart wallets`
      : `#${c.rank} ${c.win} gainer${c.pnl != null ? ` (PnL $${Math.round(c.pnl).toLocaleString('en-US')})` : ''}`
    await sendTg(
      `🟢 <b>SMART BUY</b> ${c.symbol} · ${usdTxt}\n` +
        `by ${who}\n` +
        (pool ? `liq $${Math.round(pool.tvl_usd).toLocaleString('en-US')} · ` : '') +
        `sec ✓ gmgn\n<code>${c.token}</code>\n` +
        `https://gmgn.ai/robinhood/token/${c.token}\n` +
        `alphast.xyz → POOLS → VOL · DYOR`,
    )
  }
  const stored = safe.length
  if (stored) log(`[smartbuys] ${stored} buy(s) from ${wallets.size} wallets · ${alerts} alert(s)`)
  pruneSmartBuys(t - TUNE.keepDays * 86_400)
}

export function smartBuysLatest() {
  const rows = recentSmartBuys(now() - 48 * 3_600)
  const toks = tokenRows([...new Set(rows.map((r) => r.token))])
  const sym = (a: string) => toks.find((x) => x.address === a)?.symbol ?? '?'
  return {
    enabled: smartBuysEnabled(),
    asof: now(),
    buys: rows.map((r) => ({ ...r, symbol: sym(r.token) })),
  }
}
