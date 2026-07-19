// 24h volume / liquidity stats per pool.
// CL pools:  DexScreener batch API (rolling 24h, USD, one call per 30 addrs).
// v2 pools:  official Goldsky v2 subgraph, pairHourDatas summed over the last
//            24h; when the subgraph's tracked USD is 0, fall back to the USDG
//            side (≈$) or the WETH side × WETH price derived from DexScreener.
import { ADDR } from '../config/addresses'
import { ENV } from '../config/env'
import type { Pool, V2Pool } from '../types'

export type PoolStat = {
  vol24hUsd: number | null
  liqUsd: number | null
  source: 'dexscreener' | 'subgraph' | 'geckoterminal' | 'chain'
  // indexer-flagged: claimed TVL not backed by trusted pricing (scam/noise pool)
  sus?: boolean
}

// in same-origin proxy mode (server deploys) these route through nginx so
// users behind restrictive networks keep TVL/volume/USD features
const DS_BASE = ENV.proxied
  ? '/dexscreener/latest/dex/pairs/robinhood/'
  : 'https://api.dexscreener.com/latest/dex/pairs/robinhood/'
const V2_SUBGRAPH =
  (ENV.proxied ? '/goldsky' : 'https://api.goldsky.com') +
  '/api/public/project_cmhef02640198x7p2cz2w70u8/subgraphs/up-robinhood-v2-mainnet/0.1.0/gn'

const WETH = ADDR.WETH.toLowerCase()
const USDG = ADDR.USDG.toLowerCase()

async function fetchDexscreener(
  addrs: string[],
): Promise<{ stats: Record<string, PoolStat>; wethUsd: number | null }> {
  const stats: Record<string, PoolStat> = {}
  let wethUsd: number | null = null
  for (let i = 0; i < addrs.length; i += 30) {
    const r = await fetch(DS_BASE + addrs.slice(i, i + 30).join(','))
    if (!r.ok) throw new Error(`dexscreener ${r.status}`)
    const j = (await r.json()) as { pairs?: any[] }
    for (const p of j?.pairs ?? []) {
      const addr = String(p.pairAddress ?? '').toLowerCase()
      if (!addr) continue
      const vol = Number(p?.volume?.h24)
      const liq = Number(p?.liquidity?.usd)
      stats[addr] = {
        vol24hUsd: Number.isFinite(vol) ? vol : null,
        liqUsd: Number.isFinite(liq) ? liq : null,
        source: 'dexscreener',
      }
      // derive WETH/USD once from any WETH-quoted pair (priceUsd / priceNative)
      if (wethUsd === null) {
        const pu = Number(p?.priceUsd)
        const pn = Number(p?.priceNative)
        if (p?.quoteToken?.address?.toLowerCase() === WETH && pu > 0 && pn > 0) wethUsd = pu / pn
        else if (p?.baseToken?.address?.toLowerCase() === WETH && pu > 0) wethUsd = pu
      }
    }
  }
  return { stats, wethUsd }
}

async function fetchV2Subgraph(
  v2Pools: V2Pool[],
  wethUsd: number | null,
): Promise<Record<string, PoolStat>> {
  const now = Math.floor(Date.now() / 1000)
  const q = `{
    pairHourDatas(first: 1000, where: { hourStartUnix_gte: ${now - 86_400} }) {
      pair { id }
      hourlyVolumeUSD
      hourlyVolumeToken0
      hourlyVolumeToken1
    }
    pairs(first: 200) { id reserveUSD }
  }`
  const r = await fetch(V2_SUBGRAPH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: q }),
  })
  if (!r.ok) throw new Error(`v2 subgraph ${r.status}`)
  const j = (await r.json()) as {
    data?: {
      pairHourDatas?: { pair: { id: string }; hourlyVolumeUSD: string; hourlyVolumeToken0: string; hourlyVolumeToken1: string }[]
      pairs?: { id: string; reserveUSD: string }[]
    }
  }
  const byAddr = new Map(v2Pools.map((p) => [p.address.toLowerCase(), p]))
  const stats: Record<string, PoolStat> = {}
  // liquidity from pairs
  for (const pair of j.data?.pairs ?? []) {
    const addr = pair.id.toLowerCase()
    if (!byAddr.has(addr)) continue
    const liq = Number(pair.reserveUSD)
    stats[addr] = { vol24hUsd: 0, liqUsd: Number.isFinite(liq) ? liq : null, source: 'subgraph' }
  }
  // rolling 24h volume from hour buckets
  for (const h of j.data?.pairHourDatas ?? []) {
    const addr = h.pair.id.toLowerCase()
    const pool = byAddr.get(addr)
    if (!pool) continue
    const entry = (stats[addr] ??= { vol24hUsd: 0, liqUsd: null, source: 'subgraph' })
    const tracked = Number(h.hourlyVolumeUSD)
    let usd: number | null = Number.isFinite(tracked) && tracked > 0 ? tracked : null
    if (usd === null) {
      // untracked bucket — approximate from the stable / WETH side
      const v0 = Number(h.hourlyVolumeToken0)
      const v1 = Number(h.hourlyVolumeToken1)
      const t0 = pool.token0.toLowerCase()
      const t1 = pool.token1.toLowerCase()
      if (t0 === USDG && Number.isFinite(v0)) usd = v0
      else if (t1 === USDG && Number.isFinite(v1)) usd = v1
      else if (wethUsd !== null && t0 === WETH && Number.isFinite(v0)) usd = v0 * wethUsd
      else if (wethUsd !== null && t1 === WETH && Number.isFinite(v1)) usd = v1 * wethUsd
    }
    if (usd !== null && entry.vol24hUsd !== null) entry.vol24hUsd += usd
  }
  return stats
}

export type PoolStatsResult = {
  byPool: Record<string, PoolStat> // key: lowercase pool address; uncovered pools absent
  wethUsd: number | null // WETH/USD derived from dexscreener, reused as a price anchor
}

/** merged 24h stats keyed by lowercase pool address; missing pools stay absent */
export async function fetchPoolStats(pools: Pool[]): Promise<PoolStatsResult> {
  const clAddrs = pools.filter((p) => p.kind === 'cl').map((p) => p.address.toLowerCase())
  const v2Pools = pools.filter((p): p is V2Pool => p.kind === 'v2')
  const ds = await fetchDexscreener(clAddrs).catch(() => ({ stats: {}, wethUsd: null }))
  const sg = await fetchV2Subgraph(v2Pools, ds.wethUsd).catch(() => ({}) as Record<string, PoolStat>)
  return { byPool: { ...sg, ...ds.stats }, wethUsd: ds.wethUsd }
}
