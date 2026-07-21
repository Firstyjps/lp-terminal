// Position watcher — tracks the CL positions (UP33 + univ3) of the wallets in
// `.env WATCH_ADDRESSES`, snapshots them for the PnL panel, and pushes range /
// fee alerts to Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID; silently
// disabled without them, like the DeepSeek key). Read-only: this process holds
// no keys that can move funds — it only watches and notifies.
import type { Address } from 'viem'
import {
  clFactoryAbi,
  clGaugeAbi,
  clPmAbi,
  clPoolAbi,
  erc20Abi,
  uniV3FactoryAbi,
  uniV3PmAbi,
  uniV3PoolAbi,
  voterAbi,
} from '../src/abi'
import { getAmountsForLiquidity, getSqrtRatioAtTick, MAX_UINT128 } from '../src/lib/clmath'
import { ADDR, TUNE, UNI, envVal, log, now } from './config'
import { mc, ok, pc, type Call } from './rpc'
import {
  insSnapQ,
  kvGet,
  kvSet,
  lastSnapTs,
  pruneSnaps,
  tokenRows,
  tx,
  upsertWatchPos,
  watchPosByOwner,
  type WatchPosRow,
} from './store'

const HEX40 = /^0x[0-9a-f]{40}$/

export function watchAddrs(): string[] {
  return (envVal('WATCH_ADDRESSES') ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => HEX40.test(s))
}
export const watchEnabled = (): boolean => watchAddrs().length > 0

// ---- telegram ----
function tgConf(): { token: string; chat: string } | null {
  const token = envVal('TELEGRAM_BOT_TOKEN')
  const chat = envVal('TELEGRAM_CHAT_ID')
  return token && chat ? { token, chat } : null
}
export const tgEnabled = (): boolean => tgConf() !== null

export async function sendTg(text: string): Promise<void> {
  const conf = tgConf()
  if (!conf) return
  try {
    const r = await fetch(`https://api.telegram.org/bot${conf.token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: conf.chat,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    if (!r.ok) log('[watch] telegram send failed:', r.status, (await r.text()).slice(0, 120))
  } catch (e) {
    log('[watch] telegram send failed:', String(e).slice(0, 120))
  }
}

const feeAlertUsd = (): number => {
  const n = Number(envVal('FEE_ALERT_USD'))
  return Number.isFinite(n) && n > 0 ? n : 25
}

// ---- formatting ----
const fmtUsd = (n: number | null): string =>
  n === null ? '?' : n >= 1000 ? `$${Math.round(n).toLocaleString('en-US')}` : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`
const fmtPx = (n: number): string =>
  n === 0 ? '0' : n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toPrecision(5) : n.toExponential(3)

// ---- up33 pool catalog (in-memory, refreshed when the factory grows) ----
type Up33Pool = { addr: string; token0: string; token1: string; tickSpacing: number; gauge: string | null }
let up33Pools: Up33Pool[] | null = null
let up33Len = -1

async function refreshUp33Pools(): Promise<Up33Pool[]> {
  const head = await mc([{ abi: clFactoryAbi, address: ADDR.CL_FACTORY, functionName: 'allPoolsLength' }])
  const n = Math.min(Number(ok<bigint>(head[0]) ?? 0n), 1000)
  if (up33Pools && n === up33Len) return up33Pools
  const addrRes = await mc(
    Array.from({ length: n }, (_, i) => ({
      abi: clFactoryAbi,
      address: ADDR.CL_FACTORY,
      functionName: 'allPools',
      args: [BigInt(i)],
    })),
  )
  const addrs = addrRes.map((r) => ok<Address>(r)).filter((x): x is Address => !!x)
  const det = await mc(
    addrs.flatMap((p): Call[] => [
      { abi: clPoolAbi, address: p, functionName: 'token0' },
      { abi: clPoolAbi, address: p, functionName: 'token1' },
      { abi: clPoolAbi, address: p, functionName: 'tickSpacing' },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [p] },
    ]),
  )
  const pools: Up33Pool[] = []
  addrs.forEach((p, i) => {
    const token0 = ok<Address>(det[i * 4])
    const token1 = ok<Address>(det[i * 4 + 1])
    const tickSpacing = ok<number>(det[i * 4 + 2])
    const gauge = ok<Address>(det[i * 4 + 3])
    if (!token0 || !token1 || tickSpacing === undefined) return
    pools.push({
      addr: p.toLowerCase(),
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      tickSpacing,
      gauge: gauge && !/^0x0{40}$/.test(gauge) ? gauge : null,
    })
  })
  up33Pools = pools
  up33Len = n
  log(`[watch] up33 catalog: ${pools.length} CL pools, ${pools.filter((p) => p.gauge).length} gauged`)
  return pools
}

// ---- token meta (symbol/decimals) — db first, chain fallback, cached ----
const tokMeta = new Map<string, { symbol: string; decimals: number }>()
async function ensureMeta(addrs: string[]): Promise<void> {
  const need = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => !tokMeta.has(a))
  if (!need.length) return
  for (const r of tokenRows(need)) if (r.meta_ok) tokMeta.set(r.address, { symbol: r.symbol, decimals: r.decimals })
  const still = need.filter((a) => !tokMeta.has(a))
  if (still.length) {
    const res = await mc(
      still.flatMap((t): Call[] => [
        { abi: erc20Abi, address: t as Address, functionName: 'symbol' },
        { abi: erc20Abi, address: t as Address, functionName: 'decimals' },
      ]),
    )
    still.forEach((t, i) => {
      tokMeta.set(t, {
        symbol: ok<string>(res[i * 2]) ?? t.slice(0, 6) + '…',
        decimals: ok<number>(res[i * 2 + 1]) ?? 18,
      })
    })
  }
}
const meta = (addr: string) => tokMeta.get(addr.toLowerCase()) ?? { symbol: addr.slice(0, 6) + '…', decimals: 18 }

// ---- live position reads ----
type RawPos = readonly [bigint, Address, Address, Address, number, number, number, bigint, bigint, bigint, bigint, bigint]

type LivePos = {
  npm: 'up33' | 'univ3'
  id: bigint
  pool: string
  token0: string
  token1: string
  tickLower: number
  tickUpper: number
  liquidity: bigint
  staked: boolean
  fees0: bigint
  fees1: bigint
  earnedUp: bigint
  tick: number | null
  sqrtP: bigint | null
  amount0: bigint
  amount1: bigint
}

async function livePositions(owner: Address): Promise<LivePos[]> {
  const pools = await refreshUp33Pools()
  const gauged = pools.filter((p) => p.gauge)
  const poolByKey = new Map(pools.map((p) => [`${p.token0}|${p.token1}|${p.tickSpacing}`, p]))

  // pass 1: wallet counts + staked ids per gauge
  const r1 = await mc([
    { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'balanceOf', args: [owner] },
    { abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'balanceOf', args: [owner] },
    ...gauged.map((p): Call => ({ abi: clGaugeAbi, address: p.gauge as Address, functionName: 'stakedValues', args: [owner] })),
  ])
  const upN = Math.min(Number(ok<bigint>(r1[0]) ?? 0n), 100)
  const uniN = Math.min(Number(ok<bigint>(r1[1]) ?? 0n), 100)
  const stakedFlat: { pool: Up33Pool; id: bigint }[] = []
  gauged.forEach((p, i) => {
    for (const id of ok<readonly bigint[]>(r1[2 + i]) ?? []) stakedFlat.push({ pool: p, id })
  })

  // pass 2: wallet token ids
  const r2 = await mc([
    ...Array.from({ length: upN }, (_, i): Call => ({ abi: clPmAbi, address: ADDR.CL_PM, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })),
    ...Array.from({ length: uniN }, (_, i): Call => ({ abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'tokenOfOwnerByIndex', args: [owner, BigInt(i)] })),
  ])
  const upIds = r2.slice(0, upN).map((r) => ok<bigint>(r)).filter((x): x is bigint => x !== undefined)
  const uniIds = r2.slice(upN).map((r) => ok<bigint>(r)).filter((x): x is bigint => x !== undefined)

  // pass 3: position structs (+ earned for staked)
  const r3 = await mc([
    ...upIds.map((id): Call => ({ abi: clPmAbi, address: ADDR.CL_PM, functionName: 'positions', args: [id] })),
    ...stakedFlat.flatMap(({ pool, id }): Call[] => [
      { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'positions', args: [id] },
      { abi: clGaugeAbi, address: pool.gauge as Address, functionName: 'earned', args: [owner, id] },
    ]),
    ...uniIds.map((id): Call => ({ abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'positions', args: [id] })),
  ])

  type Pending = Omit<LivePos, 'tick' | 'sqrtP' | 'amount0' | 'amount1'> & { pool: string }
  const pending: Pending[] = []
  upIds.forEach((id, j) => {
    const raw = ok<RawPos>(r3[j])
    if (!raw || (raw[7] === 0n && raw[10] === 0n && raw[11] === 0n)) return
    const pool = poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)
    if (!pool) return
    pending.push({
      npm: 'up33', id, pool: pool.addr, token0: pool.token0, token1: pool.token1,
      tickLower: raw[5], tickUpper: raw[6], liquidity: raw[7], staked: false,
      fees0: raw[10], fees1: raw[11], earnedUp: 0n,
    })
  })
  stakedFlat.forEach(({ pool, id }, j) => {
    const base = upIds.length + j * 2
    const raw = ok<RawPos>(r3[base])
    if (!raw) return
    pending.push({
      npm: 'up33', id, pool: pool.addr, token0: pool.token0, token1: pool.token1,
      tickLower: raw[5], tickUpper: raw[6], liquidity: raw[7], staked: true,
      fees0: 0n, fees1: 0n, earnedUp: ok<bigint>(r3[base + 1]) ?? 0n,
    })
  })
  const uniRaws = uniIds
    .map((id, j) => ({ id, raw: ok<RawPos>(r3[upIds.length + stakedFlat.length * 2 + j]) }))
    .filter((x): x is { id: bigint; raw: RawPos } => !!x.raw && (x.raw[7] > 0n || x.raw[10] > 0n || x.raw[11] > 0n))

  // univ3 pool resolution
  const uniKeys = new Map<string, { token0: Address; token1: Address; fee: number }>()
  for (const { raw } of uniRaws)
    uniKeys.set(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`, { token0: raw[2], token1: raw[3], fee: raw[4] })
  const uniKeyList = [...uniKeys.entries()]
  const addrRes = await mc(
    uniKeyList.map(([, k]): Call => ({ abi: uniV3FactoryAbi, address: UNI.V3_FACTORY, functionName: 'getPool', args: [k.token0, k.token1, k.fee] })),
  )
  const uniPoolByKey = new Map<string, string>()
  uniKeyList.forEach(([key], i) => {
    const a = ok<Address>(addrRes[i])
    if (a && !/^0x0{40}$/.test(a)) uniPoolByKey.set(key, a.toLowerCase())
  })
  for (const { id, raw } of uniRaws) {
    const pool = uniPoolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)
    if (!pool) continue
    pending.push({
      npm: 'univ3', id, pool, token0: raw[2].toLowerCase(), token1: raw[3].toLowerCase(),
      tickLower: raw[5], tickUpper: raw[6], liquidity: raw[7], staked: false,
      fees0: raw[10], fees1: raw[11], earnedUp: 0n,
    })
  }

  // slot0 for every pool hosting a position
  const uniquePools = [...new Set(pending.map((p) => p.pool))]
  const isUni = new Set(pending.filter((p) => p.npm === 'univ3').map((p) => p.pool))
  const s0Res = await mc(
    uniquePools.map((a): Call => ({
      abi: isUni.has(a) ? uniV3PoolAbi : clPoolAbi,
      address: a as Address,
      functionName: 'slot0',
    })),
  )
  const slotByPool = new Map<string, { sqrtP: bigint; tick: number }>()
  uniquePools.forEach((a, i) => {
    const s0 = ok<readonly [bigint, number, ...unknown[]]>(s0Res[i])
    if (s0) slotByPool.set(a, { sqrtP: s0[0], tick: s0[1] })
  })

  // exact uncollected fees for wallet positions via collect() simulation
  await Promise.all(
    pending
      .filter((p) => !p.staked && p.liquidity > 0n)
      .map(async (p) => {
        try {
          const sim = await pc.simulateContract({
            abi: clPmAbi,
            address: p.npm === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM,
            functionName: 'collect',
            args: [{ tokenId: p.id, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
            account: owner,
          })
          const [f0, f1] = sim.result as readonly [bigint, bigint]
          p.fees0 = f0
          p.fees1 = f1
        } catch {
          /* keep tokensOwed fallback */
        }
      }),
  )

  return pending.map((p) => {
    const slot = slotByPool.get(p.pool)
    const { amount0, amount1 } = slot
      ? getAmountsForLiquidity(slot.sqrtP, getSqrtRatioAtTick(p.tickLower), getSqrtRatioAtTick(p.tickUpper), p.liquidity)
      : { amount0: 0n, amount1: 0n }
    return { ...p, tick: slot?.tick ?? null, sqrtP: slot?.sqrtP ?? null, amount0, amount1 }
  })
}

// ---- pricing: db price_usd, USDG anchor, pool-ratio inference ----
function priceMap(positions: LivePos[]): Map<string, number> {
  const addrs = [...new Set(positions.flatMap((p) => [p.token0, p.token1, ADDR.UP.toLowerCase(), ADDR.WETH.toLowerCase()]))]
  const px = new Map<string, number>()
  px.set(ADDR.USDG.toLowerCase(), 1)
  for (const r of tokenRows(addrs)) {
    if (r.price_usd && r.price_usd > 0 && !px.has(r.address)) px.set(r.address, r.price_usd)
  }
  // one side unpriced -> infer through the pool's own price
  for (const p of positions) {
    if (p.sqrtP === null) continue
    const d0 = meta(p.token0).decimals
    const d1 = meta(p.token1).decimals
    const ratio = (Number(p.sqrtP) / 2 ** 96) ** 2 * 10 ** (d0 - d1) // token1 per token0, human units
    if (!Number.isFinite(ratio) || ratio <= 0) continue
    const p0 = px.get(p.token0)
    const p1 = px.get(p.token1)
    if (p0 !== undefined && p1 === undefined) px.set(p.token1, p0 / ratio)
    if (p1 !== undefined && p0 === undefined) px.set(p.token0, p1 * ratio)
  }
  return px
}

const usdOf = (px: Map<string, number>, addr: string, amount: bigint): number | null => {
  const p = px.get(addr.toLowerCase())
  if (p === undefined) return null
  return (Number(amount) / 10 ** meta(addr).decimals) * p
}

/** null-tolerant sum: null + x = x, but all-null stays null */
const addUsd = (...vals: (number | null)[]): number | null =>
  vals.every((v) => v === null) ? null : vals.reduce<number>((a, v) => a + (v ?? 0), 0)

// ---- alert copy ----
const pairLabel = (p: { token0: string; token1: string }) => `${meta(p.token0).symbol}/${meta(p.token1).symbol}`

function rangeLine(p: LivePos): string {
  const d0 = meta(p.token0).decimals
  const d1 = meta(p.token1).decimals
  const px = (t: number) => 1.0001 ** t * 10 ** (d0 - d1)
  const cur = p.tick !== null ? fmtPx(px(p.tick)) : '?'
  return `price ${cur} · range ${fmtPx(px(p.tickLower))}–${fmtPx(px(p.tickUpper))} ${meta(p.token1).symbol}/${meta(p.token0).symbol}`
}

// ---- cycle ----
async function watchOne(owner: string, alerts: string[]): Promise<{ n: number; inRange: number; valueUsd: number }> {
  const live = await livePositions(owner as Address)
  await ensureMeta(live.flatMap((p) => [p.token0, p.token1]))
  const px = priceMap(live)
  const upPx = px.get(ADDR.UP.toLowerCase())
  const prevRows = new Map(watchPosByOwner(owner).map((r) => [`${r.npm}|${r.token_id}`, r]))
  const firstSight = prevRows.size === 0
  const ts = now()
  const threshold = feeAlertUsd()
  const snaps: (() => void)[] = []
  let inRangeN = 0
  let totalUsd = 0

  const liveKeys = new Set<string>()
  for (const p of live) {
    const key = `${p.npm}|${p.id}`
    liveKeys.add(key)
    const prev = prevRows.get(key)
    const inRange = p.tick !== null ? (p.tick >= p.tickLower && p.tick < p.tickUpper ? 1 : 0) : null
    const valueUsd = addUsd(usdOf(px, p.token0, p.amount0), usdOf(px, p.token1, p.amount1))
    const feesUsd = p.staked
      ? upPx !== undefined
        ? (Number(p.earnedUp) / 1e18) * upPx
        : null
      : addUsd(usdOf(px, p.token0, p.fees0), usdOf(px, p.token1, p.fees1))
    if (p.liquidity > 0n && inRange === 1) inRangeN++
    if (valueUsd !== null) totalUsd += valueUsd

    const label = `${pairLabel(p)} #${p.id}${p.staked ? ' (staked)' : ''}`
    let collected = prev?.collected_usd ?? 0
    let outSince = prev?.out_since ?? null
    let alertedFee = prev?.alerted_fee ?? 0

    if (!prev && !firstSight) {
      alerts.push(`🆕 <b>${label}</b> new position · ${fmtUsd(valueUsd)}\n${rangeLine(p)}`)
    }
    if (prev && prev.closed === 0 && p.liquidity > 0n && inRange !== null && prev.in_range !== null) {
      if (prev.in_range === 1 && inRange === 0) {
        outSince = ts
        alerts.push(`🔴 <b>${label}</b> OUT OF RANGE · ${fmtUsd(valueUsd)}\n${rangeLine(p)}\n→ re-range at https://alphast.xyz`)
      } else if (prev.in_range === 0 && inRange === 1) {
        outSince = null
        alerts.push(`🟢 <b>${label}</b> back in range · ${fmtUsd(valueUsd)}`)
      }
    }
    if (inRange === 1) outSince = null

    // collections/claims = RAW uncollected amounts going down. USD comparisons
    // would ratchet phantom "collections" out of price swings, and a cycle that
    // lands between decreaseLiquidity and collect sees principal inside
    // tokensOwed — so skip accounting on any cycle where liquidity dropped and
    // rebaseline instead (conservative: may undercount, never overcounts).
    if (prev && prev.closed === 0) {
      const liqDropped = p.liquidity < BigInt(prev.liquidity)
      if (!liqDropped) {
        let got = 0
        if (prev.staked === 0 && !p.staked) {
          const d0 = prev.fees0 !== null ? BigInt(prev.fees0) - p.fees0 : 0n
          const d1 = prev.fees1 !== null ? BigInt(prev.fees1) - p.fees1 : 0n
          if (d0 > 0n) got += usdOf(px, p.token0, d0) ?? 0
          if (d1 > 0n) got += usdOf(px, p.token1, d1) ?? 0
        }
        if (prev.staked === 1) {
          // gauge withdraw auto-claims, so count UP drops even across unstake
          const dUp = prev.earned_up !== null ? BigInt(prev.earned_up) - p.earnedUp : 0n
          if (dUp > 0n && upPx !== undefined) got += (Number(dUp) / 1e18) * upPx
        }
        if (got > 0) {
          collected += got
          alertedFee = 0
        }
      }
    }
    if (feesUsd !== null && feesUsd >= threshold && alertedFee === 0) {
      alertedFee = 1
      alerts.push(`💰 <b>${label}</b> ${p.staked ? 'rewards' : 'fees'} ${fmtUsd(feesUsd)} uncollected (≥ $${threshold})`)
    }
    if (feesUsd !== null && feesUsd < threshold / 2 && alertedFee === 1) alertedFee = 0

    upsertWatchPos({
      owner, npm: p.npm, token_id: String(p.id), pool: p.pool, token0: p.token0, token1: p.token1,
      tick_lower: p.tickLower, tick_upper: p.tickUpper, staked: p.staked ? 1 : 0,
      liquidity: String(p.liquidity), in_range: inRange, value_usd: valueUsd, fees_usd: feesUsd,
      collected_usd: collected, first_ts: prev?.first_ts ?? ts,
      first_value_usd: prev?.first_value_usd ?? valueUsd, last_ts: ts, closed: 0,
      out_since: outSince, alerted_fee: alertedFee,
      fees0: String(p.fees0), fees1: String(p.fees1), earned_up: String(p.earnedUp),
    })

    const due = ts - lastSnapTs(owner, p.npm, String(p.id)) >= TUNE.watchSnapMs / 1000 - 5
    const transitioned = prev ? prev.in_range !== inRange || prev.closed === 1 : true
    if (due || transitioned) {
      snaps.push(() =>
        insSnapQ.run(
          ts, owner, p.npm, String(p.id), String(p.liquidity), p.tick, inRange,
          String(p.amount0), String(p.amount1), String(p.fees0), String(p.fees1),
          String(p.earnedUp), valueUsd, feesUsd,
        ),
      )
    }
  }

  // rows that disappeared from chain = closed (burned / transferred / emptied)
  for (const [key, prev] of prevRows) {
    if (liveKeys.has(key) || prev.closed === 1) continue
    const label = `${meta(prev.token0 ?? '').symbol}/${meta(prev.token1 ?? '').symbol} #${prev.token_id}`
    alerts.push(`✅ <b>${label}</b> position closed`)
    upsertWatchPos({ ...prev, liquidity: '0', in_range: null, staked: prev.staked, closed: 1, last_ts: ts })
  }

  if (snaps.length) tx(() => snaps.forEach((f) => f()))
  if (firstSight && live.length) {
    alerts.push(`👀 watching <code>${owner.slice(0, 8)}…</code>: ${live.length} position${live.length > 1 ? 's' : ''} · ${fmtUsd(totalUsd)}`)
  }
  return { n: live.length, inRange: inRangeN, valueUsd: totalUsd }
}

let lastSummary = ''
export async function watchCycle(): Promise<void> {
  const owners = watchAddrs()
  if (!owners.length) return
  const alerts: string[] = []
  let n = 0
  let inR = 0
  let usd = 0
  for (const o of owners) {
    const r = await watchOne(o, alerts)
    n += r.n
    inR += r.inRange
    usd += r.valueUsd
  }
  if (alerts.length) {
    log(`[watch] ${alerts.length} alert(s)`)
    await sendTg(alerts.join('\n\n'))
  }
  const summary = `[watch] ${n} positions (${inR} in-range) · ~${fmtUsd(usd)}`
  if (summary !== lastSummary) {
    log(summary)
    lastSummary = summary
  }

  const day = new Date().toISOString().slice(0, 10)
  if (kvGet('watch_prune_day') !== day) {
    kvSet('watch_prune_day', day)
    const gone = pruneSnaps(now() - TUNE.watchSnapKeepDays * 86_400)
    if (gone) log(`[watch] pruned ${gone} old snapshots`)
  }
}
