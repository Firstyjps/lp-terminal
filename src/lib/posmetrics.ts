// Per-position metrics: what a position is WORTH and what it is EARNING
// RIGHT NOW — the two numbers an LP actually manages by. Pricing uses the
// pool's own price against the USDG/WETH/UP anchors (see clTokenUsd), so any
// pair quoted against an anchor prices with zero extra network calls.
//
// Earning-now follows the ve(3,3) ground rules (apr.ts):
//   staked   -> UP emissions, pro-rata ACTIVE staked liquidity, in-range only
//   unstaked -> swap fees, pro-rata active liquidity, in-range only
//   univ3    -> always the fees branch (no gauges)
import { ADDR } from '../config/addresses'
import { clTokenUsd } from './apr'
import { nowSec } from './format'
import type { PoolStat } from './poolstats'
import type { ClPosition, V2Position, V2Pool } from '../types'

export type Earning =
  | { kind: 'emissions'; upPerDay: number; usdPerDay: number | null; aprPct: number | null; sharePct: number }
  | { kind: 'emissions-idle'; reason: 'out-of-range' | 'ended' }
  | { kind: 'fees'; aprPct: number; usdPerDay: number; sharePct: number }
  | { kind: 'fees-unknown' } // in range but no 24h volume data
  | { kind: 'out-of-range' }
  | { kind: 'empty' }

export type ClMetrics = {
  valueUsd: number | null
  feesUsd: number | null
  inRange: boolean
  earning: Earning
}

const DAY = 86_400
const YEAR_DAYS = 365

const emitting = (p: { rewardRate: bigint; periodFinish: bigint }) =>
  p.rewardRate > 0n && p.periodFinish > BigInt(nowSec())

export function clPosMetrics(args: {
  pos: ClPosition
  /** live-aware held amounts + tick (cards pass the fast feed when they have one) */
  amount0: bigint
  amount1: bigint
  tick: number
  dec0: number
  dec1: number
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}): ClMetrics {
  const { pos, dec0, dec1 } = args
  const pool = pos.pool
  const px = clTokenUsd(pool, dec0, dec1, args.upUsd, args.wethUsd)
  const h = (v: bigint, d: number) => Number(v) / 10 ** d
  const valueUsd = px ? h(args.amount0, dec0) * px.p0 + h(args.amount1, dec1) * px.p1 : null
  const feesUsd = px ? h(pos.fees0, dec0) * px.p0 + h(pos.fees1, dec1) * px.p1 : null
  const inRange = args.tick >= pos.tickLower && args.tick < pos.tickUpper

  let earning: Earning
  if (pos.liquidity === 0n) {
    earning = { kind: 'empty' }
  } else if (pos.staked) {
    if (!inRange) earning = { kind: 'emissions-idle', reason: 'out-of-range' }
    else if (!emitting(pool)) earning = { kind: 'emissions-idle', reason: 'ended' }
    else {
      const denom = Number(pool.stakedLiquidity)
      const share = denom > 0 ? Number(pos.liquidity) / denom : 0
      const upPerDay = (Number(pool.rewardRate) / 1e18) * DAY * share
      const usdPerDay = args.upUsd ? upPerDay * args.upUsd : null
      const aprPct =
        usdPerDay !== null && valueUsd !== null && valueUsd > 0 ? ((usdPerDay * YEAR_DAYS) / valueUsd) * 100 : null
      earning = { kind: 'emissions', upPerDay, usdPerDay, aprPct, sharePct: share * 100 }
    }
  } else if (!inRange) {
    earning = { kind: 'out-of-range' }
  } else if (args.stat?.vol24hUsd == null || valueUsd === null || valueUsd <= 0) {
    earning = { kind: 'fees-unknown' }
  } else {
    const denom = Number(pool.liquidity)
    const share = denom > 0 ? Number(pos.liquidity) / denom : 0
    const keep = 1 - pool.unstakedFeePpm / 1e6
    const usdPerDay = args.stat.vol24hUsd * (pool.feePpm / 1e6) * keep * share
    earning = { kind: 'fees', aprPct: ((usdPerDay * YEAR_DAYS) / valueUsd) * 100, usdPerDay, sharePct: share * 100 }
  }

  return { valueUsd, feesUsd, inRange, earning }
}

/** USD prices of a v2 pool's tokens: anchor + reserve ratio, TVL/2 backstop */
export function v2TokenUsd(
  pool: V2Pool,
  dec0: number,
  dec1: number,
  upUsd?: number,
  wethUsd?: number | null,
  statLiqUsd?: number | null,
): { p0: number; p1: number } | null {
  const r0h = Number(pool.reserve0) / 10 ** dec0
  const r1h = Number(pool.reserve1) / 10 ** dec1
  if (!(r0h > 0) || !(r1h > 0)) return null
  const anchors: Record<string, number | undefined> = {
    [ADDR.USDG.toLowerCase()]: 1,
    [ADDR.WETH.toLowerCase()]: wethUsd ?? undefined,
    [ADDR.UP.toLowerCase()]: upUsd,
  }
  const a0 = anchors[pool.token0.toLowerCase()]
  const a1 = anchors[pool.token1.toLowerCase()]
  // value balance: r0·p0 ≈ r1·p1 (true for volatile pairs; good enough for stables)
  if (a0 !== undefined && a0 > 0) return { p0: a0, p1: (a0 * r0h) / r1h }
  if (a1 !== undefined && a1 > 0) return { p0: (a1 * r1h) / r0h, p1: a1 }
  if (statLiqUsd != null && statLiqUsd > 0) return { p0: statLiqUsd / 2 / r0h, p1: statLiqUsd / 2 / r1h }
  return null
}

export type V2Metrics = {
  valueUsd: number | null // wallet + staked underlying
  feesUsd: number | null // claimable fees
  staked: Earning | null // null when nothing staked
  wallet: Earning | null // null when no wallet LP
}

export function v2PosMetrics(args: {
  pos: V2Position
  dec0: number
  dec1: number
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}): V2Metrics {
  const { pos, dec0, dec1 } = args
  const pool = pos.pool
  const px = v2TokenUsd(pool, dec0, dec1, args.upUsd, args.wethUsd, args.stat?.liqUsd)
  const h = (v: bigint, d: number) => Number(v) / 10 ** d
  const valueUsd = px ? h(pos.amount0, dec0) * px.p0 + h(pos.amount1, dec1) * px.p1 : null
  const feesUsd = px ? h(pos.claimable0, dec0) * px.p0 + h(pos.claimable1, dec1) * px.p1 : null

  const lp = pos.walletLp + pos.stakedLp
  const stakedValue = valueUsd !== null && lp > 0n ? (valueUsd * Number(pos.stakedLp)) / Number(lp) : null
  const walletValue = valueUsd !== null && lp > 0n ? (valueUsd * Number(pos.walletLp)) / Number(lp) : null

  let staked: Earning | null = null
  if (pos.stakedLp > 0n) {
    if (!emitting(pool)) staked = { kind: 'emissions-idle', reason: 'ended' }
    else {
      const denom = Number(pool.gaugeTotalSupply)
      const share = denom > 0 ? Number(pos.stakedLp) / denom : 0
      const upPerDay = (Number(pool.rewardRate) / 1e18) * DAY * share
      const usdPerDay = args.upUsd ? upPerDay * args.upUsd : null
      const aprPct =
        usdPerDay !== null && stakedValue !== null && stakedValue > 0
          ? ((usdPerDay * YEAR_DAYS) / stakedValue) * 100
          : null
      staked = { kind: 'emissions', upPerDay, usdPerDay, aprPct, sharePct: share * 100 }
    }
  }

  let wallet: Earning | null = null
  if (pos.walletLp > 0n) {
    if (args.stat?.vol24hUsd == null || args.stat.liqUsd == null || args.stat.liqUsd <= 0) {
      wallet = { kind: 'fees-unknown' }
    } else {
      const aprPct = ((args.stat.vol24hUsd * (pool.feeBps / 10_000) * YEAR_DAYS) / args.stat.liqUsd) * 100
      const usdPerDay = walletValue !== null ? (walletValue * aprPct) / 100 / YEAR_DAYS : 0
      wallet = { kind: 'fees', aprPct, usdPerDay, sharePct: lp > 0n ? (Number(pos.walletLp) / Number(pool.totalSupply)) * 100 : 0 }
    }
  }

  return { valueUsd, feesUsd, staked, wallet }
}
