// Uniswap v3 pool discovery for the POOLS tab.
//
// Why not RPC enumeration: the factory has thousands of PoolCreated events
// (mostly dust-TVL 1%-tier meme pools) and both public RPC (query timeout) and
// Alchemy (10k-block getLogs cap ≈ 1100+ requests) make in-browser scans
// unrealistic. There is also no official Uniswap subgraph for Robinhood Chain
// (official Graph deployments are mainnet-only as of 2026-07).
//
// So discovery is token-centric via DexScreener (already same-origin proxied
// in server mode), and every candidate is VERIFIED on-chain before display:
// the pool's own token0/token1/fee must round-trip through factory.getPool to
// the same address — an API can suggest pools, it can never substitute one.
import { getAddress, zeroAddress, type Address, type PublicClient } from 'viem'
import { erc20Abi, uniV3FactoryAbi, uniV3PoolAbi } from '../abi'
import { ADDR, UNI } from '../config/addresses'
import { ENV } from '../config/env'
import { loadTokenCache, saveTokenCache } from '../hooks/usePools'
import type { PoolStat } from './poolstats'
import type { ClPool, TokenInfo } from '../types'

const DS = ENV.proxied ? '/dexscreener' : 'https://api.dexscreener.com'
const CAP = 30 // top pools by TVL per query — keeps the verify multicall small

type DsPair = {
  chainId?: string
  dexId?: string
  labels?: string[]
  pairAddress?: string
  volume?: { h24?: number }
  liquidity?: { usd?: number }
}

export type UniBrowse = {
  pools: ClPool[]
  tokens: Record<string, TokenInfo>
  stats: Record<string, PoolStat> // lowercase pool address
  candidates: number // dexscreener v3 matches before cap + on-chain verify
  dropped: number // candidates that failed factory.getPool verification
}

function v3PairsOf(json: unknown): DsPair[] {
  const arr = Array.isArray(json) ? json : ((json as { pairs?: DsPair[] })?.pairs ?? [])
  return arr.filter(
    (p) => p?.chainId === 'robinhood' && p?.dexId === 'uniswap' && (p?.labels ?? []).includes('v3'),
  )
}

async function dsJson(path: string): Promise<unknown> {
  const r = await fetch(DS + path)
  if (!r.ok) throw new Error(`dexscreener ${r.status}`)
  return r.json()
}

/** dexscreener candidates for a query: token address, pool address, or symbol text */
async function candidatesFor(query: string): Promise<DsPair[]> {
  const q = query.trim()
  if (/^0x[0-9a-fA-F]{40}$/.test(q)) {
    // token address first (the common case), then pool-address lookup
    const byToken = v3PairsOf(await dsJson(`/token-pairs/v1/robinhood/${q}`).catch(() => null))
    if (byToken.length) return byToken
    return v3PairsOf(await dsJson(`/latest/dex/pairs/robinhood/${q}`).catch(() => null))
  }
  return v3PairsOf(await dsJson(`/latest/dex/search?q=${encodeURIComponent(q)}`).catch(() => null))
}

type McRes = { status: 'success' | 'failure'; result?: unknown }
const ok = <T,>(r: McRes | undefined): T | undefined =>
  r && r.status === 'success' ? (r.result as T) : undefined

/**
 * Discover + on-chain-verify Uniswap v3 pools. `query` empty = WETH (hub token).
 * Returns ready-to-render ClPool objects (protocol 'univ3', no gauge fields).
 */
export async function fetchUniBrowse(pc: PublicClient, query: string): Promise<UniBrowse> {
  const raw = await candidatesFor(query || ADDR.WETH)

  // dedupe, rank by TVL, cap
  const seen = new Map<string, DsPair>()
  for (const p of raw) {
    const a = p.pairAddress?.toLowerCase()
    if (a && !seen.has(a)) seen.set(a, p)
  }
  const ranked = [...seen.values()].sort(
    (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
  )
  const picks = ranked.slice(0, CAP)

  const stats: Record<string, PoolStat> = {}
  for (const p of picks) {
    const vol = Number(p.volume?.h24)
    const liq = Number(p.liquidity?.usd)
    stats[p.pairAddress!.toLowerCase()] = {
      vol24hUsd: Number.isFinite(vol) ? vol : null,
      liqUsd: Number.isFinite(liq) ? liq : null,
      source: 'dexscreener',
    }
  }

  // hydrate pool state from the pool contracts themselves
  const addrs = picks.map((p) => getAddress(p.pairAddress!))
  const det = (await pc.multicall({
    contracts: addrs.flatMap((a) => [
      { abi: uniV3PoolAbi, address: a, functionName: 'token0' },
      { abi: uniV3PoolAbi, address: a, functionName: 'token1' },
      { abi: uniV3PoolAbi, address: a, functionName: 'fee' },
      { abi: uniV3PoolAbi, address: a, functionName: 'tickSpacing' },
      { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
      { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
    ]) as never,
  })) as McRes[]

  type Hyd = { addr: Address; token0: Address; token1: Address; fee: number; ts: number; s0: readonly [bigint, number]; liq: bigint }
  const hyd: Hyd[] = []
  addrs.forEach((a, i) => {
    const token0 = ok<Address>(det[i * 6])
    const token1 = ok<Address>(det[i * 6 + 1])
    const fee = ok<number>(det[i * 6 + 2])
    const ts = ok<number>(det[i * 6 + 3])
    const s0 = ok<readonly [bigint, number]>(det[i * 6 + 4])
    const liq = ok<bigint>(det[i * 6 + 5])
    if (!token0 || !token1 || fee === undefined || ts === undefined || !s0) return
    hyd.push({ addr: a, token0, token1, fee, ts, s0, liq: liq ?? 0n })
  })

  // authenticity gate: the OFFICIAL factory must map (token0, token1, fee) back
  // to this exact address, else it's a fork/spoof pool and gets dropped
  const gp = (await pc.multicall({
    contracts: hyd.map((h) => ({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool',
      args: [h.token0, h.token1, h.fee],
    })) as never,
  })) as McRes[]
  const verified = hyd.filter((h, i) => {
    const mapped = ok<Address>(gp[i])
    return !!mapped && mapped !== zeroAddress && mapped.toLowerCase() === h.addr.toLowerCase()
  })

  // token metadata (shared localStorage cache with the UP33 pool scan)
  const cache = loadTokenCache()
  const tokens: Record<string, TokenInfo> = {}
  const missing: Address[] = []
  for (const h of verified) {
    for (const t of [h.token0, h.token1]) {
      const k = t.toLowerCase()
      if (tokens[k]) continue
      if (cache[k]) tokens[k] = cache[k]
      else if (!missing.some((m) => m.toLowerCase() === k)) missing.push(t)
    }
  }
  if (missing.length) {
    const meta = (await pc.multicall({
      contracts: missing.flatMap((t) => [
        { abi: erc20Abi, address: t, functionName: 'symbol' },
        { abi: erc20Abi, address: t, functionName: 'decimals' },
      ]) as never,
    })) as McRes[]
    missing.forEach((t, j) => {
      const info: TokenInfo = {
        address: t,
        symbol: ok<string>(meta[j * 2]) ?? t.slice(0, 6) + '…',
        decimals: ok<number>(meta[j * 2 + 1]) ?? 18,
      }
      tokens[t.toLowerCase()] = info
      cache[t.toLowerCase()] = info
    })
    saveTokenCache(cache)
  }

  const pools: ClPool[] = verified.map((h) => ({
    kind: 'cl',
    protocol: 'univ3',
    address: h.addr,
    token0: h.token0,
    token1: h.token1,
    tickSpacing: h.ts,
    feePpm: h.fee, // univ3 fee unit == ppm
    unstakedFeePpm: 0, // no ve(3,3) levy — LPs keep 100% of fees
    sqrtPriceX96: h.s0[0],
    tick: h.s0[1],
    liquidity: h.liq,
    stakedLiquidity: 0n,
    gauge: null,
    gaugeAlive: false,
    weight: 0n,
    rewardRate: 0n,
    periodFinish: 0n,
  }))

  return { pools, tokens, stats, candidates: ranked.length, dropped: hyd.length - verified.length }
}
