// Typed client for the pool-indexer API (indexer/, same-origin /api).
//
// The indexer owns the full Uniswap v2+v3 catalog — built exclusively from the
// official factories (PoolCreated events / allPairs enumeration), so every
// address is authentic by construction — plus on-chain state, chain-derived
// TVL and GeckoTerminal 24h stats. This module maps its JSON (bigints travel
// as strings) onto the app's Pool/TokenInfo/PoolStat shapes.
//
// Returns null when the API is unreachable or still warming up (ready:false):
// the caller then falls back to client-side dexscreener discovery (uniBrowse).
import { getAddress } from 'viem'
import type { PoolStat } from './poolstats'
import type { Pool, TokenInfo } from '../types'

type ApiPool = {
  proto: 'univ2' | 'univ3'
  address: string
  token0: string
  token1: string
  feePpm: number
  tickSpacing: number | null
  sqrtPriceX96: string | null
  tick: number | null
  liquidity: string | null
  reserve0: string
  reserve1: string
  totalSupply: string | null
  tvlUsd: number | null
  tvlSus?: boolean
  vol24hUsd: number | null
  txns24h: number | null
  gtLiqUsd: number | null
  statsSource: string | null
}

type ApiResponse = {
  ready: boolean
  totals: Record<string, number>
  count: number
  pools: ApiPool[]
  tokens: Record<string, { address: string; symbol: string; decimals: number; priceUsd: number | null }>
}

export type UniIndexData = {
  pools: Pool[]
  tokens: Record<string, TokenInfo>
  stats: Record<string, PoolStat>
  total: number // server-side matches before the page limit
  indexed: number // whole catalog size (univ2 + univ3)
}

const zeroBase = { gauge: null, gaugeAlive: false, weight: 0n, rewardRate: 0n, periodFinish: 0n } as const

export async function fetchUniIndex(
  query: string,
  minTvl: number,
  proto?: 'univ2' | 'univ3',
  limit = 120,
): Promise<UniIndexData | null> {
  let j: ApiResponse
  try {
    const u = new URL('/api/pools', location.origin)
    const q = query.trim()
    if (q) u.searchParams.set('q', q)
    if (minTvl > 0) u.searchParams.set('min_tvl', String(minTvl))
    if (proto) u.searchParams.set('proto', proto)
    u.searchParams.set('limit', String(limit))
    const r = await fetch(u)
    if (!r.ok) return null
    j = (await r.json()) as ApiResponse
  } catch {
    return null
  }
  if (!j?.ready || !Array.isArray(j.pools)) return null

  const pools: Pool[] = []
  const stats: Record<string, PoolStat> = {}
  for (const p of j.pools) {
    const base = {
      address: getAddress(p.address),
      token0: getAddress(p.token0),
      token1: getAddress(p.token1),
      ...zeroBase,
    }
    if (p.proto === 'univ3') {
      if (!p.sqrtPriceX96) continue // state not swept yet (brand-new pool) — next poll has it
      pools.push({
        ...base,
        kind: 'cl',
        protocol: 'univ3',
        tickSpacing: p.tickSpacing ?? 0,
        feePpm: p.feePpm, // univ3 fee unit == ppm
        unstakedFeePpm: 0, // no ve(3,3) levy
        sqrtPriceX96: BigInt(p.sqrtPriceX96),
        tick: p.tick ?? 0,
        liquidity: BigInt(p.liquidity ?? '0'),
        stakedLiquidity: 0n,
      })
    } else {
      pools.push({
        ...base,
        kind: 'v2',
        protocol: 'univ2',
        stable: false,
        reserve0: BigInt(p.reserve0),
        reserve1: BigInt(p.reserve1),
        totalSupply: BigInt(p.totalSupply ?? '0'),
        gaugeTotalSupply: 0n,
        feeBps: Math.round(p.feePpm / 100), // 3000 ppm -> 30 bps (0.30%)
      })
    }
    stats[p.address.toLowerCase()] = {
      vol24hUsd: p.vol24hUsd,
      liqUsd: p.tvlUsd ?? p.gtLiqUsd, // chain-derived TVL first, GT reserve as backstop
      source: p.statsSource === 'geckoterminal' ? 'geckoterminal' : 'chain',
      sus: p.tvlSus === true,
    }
  }

  const tokens: Record<string, TokenInfo> = {}
  for (const [k, t] of Object.entries(j.tokens ?? {}))
    tokens[k] = { address: getAddress(t.address), symbol: t.symbol, decimals: t.decimals }

  const indexed = Object.values(j.totals ?? {}).reduce((a, b) => a + b, 0)
  return { pools, tokens, stats, total: j.count, indexed }
}
