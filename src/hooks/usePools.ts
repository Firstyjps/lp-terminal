import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import { zeroAddress, type Address, type PublicClient } from 'viem'
import {
  clFactoryAbi,
  clGaugeAbi,
  clPoolAbi,
  erc20Abi,
  minterAbi,
  v2FactoryAbi,
  v2GaugeAbi,
  v2PoolAbi,
  voterAbi,
} from '../abi'
import { ADDR } from '../config/addresses'
import type { ClPool, Pool, PoolsData, TokenInfo, V2Pool } from '../types'

type McRes = { status: 'success' | 'failure'; result?: unknown; error?: Error }

async function mc(pc: PublicClient, contracts: unknown[]): Promise<McRes[]> {
  if (contracts.length === 0) return []
  return (await pc.multicall({ contracts: contracts as never })) as McRes[]
}

function ok<T>(r: McRes | undefined): T | undefined {
  return r && r.status === 'success' ? (r.result as T) : undefined
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i)

// ---- token metadata cache (localStorage, shared with the univ3 browser) ----
const TOKEN_CACHE_KEY = 'up33:tokens:v2'

export function loadTokenCache(): Record<string, TokenInfo> {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_CACHE_KEY) ?? '{}')
  } catch {
    return {}
  }
}
export function saveTokenCache(cache: Record<string, TokenInfo>) {
  try {
    localStorage.setItem(TOKEN_CACHE_KEY, JSON.stringify(cache))
  } catch {
    /* ignore */
  }
}

export async function fetchPools(pc: PublicClient): Promise<PoolsData> {
  const head = await mc(pc, [
    { abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'allPoolsLength' },
    { abi: clFactoryAbi, address: ADDR.CL_FACTORY, functionName: 'allPoolsLength' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'weekly' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'epochCount' },
    { abi: minterAbi, address: ADDR.MINTER, functionName: 'activePeriod' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'totalWeight' },
    { abi: voterAbi, address: ADDR.VOTER, functionName: 'capMode' },
  ])
  const blockNumber = await pc.getBlockNumber()

  const v2N = Math.min(Number(ok<bigint>(head[0]) ?? 0n), 300)
  const clN = Math.min(Number(ok<bigint>(head[1]) ?? 0n), 600)

  const addrRes = await mc(pc, [
    ...range(v2N).map((i) => ({
      abi: v2FactoryAbi,
      address: ADDR.V2_FACTORY,
      functionName: 'allPools',
      args: [BigInt(i)],
    })),
    ...range(clN).map((i) => ({
      abi: clFactoryAbi,
      address: ADDR.CL_FACTORY,
      functionName: 'allPools',
      args: [BigInt(i)],
    })),
  ])
  const v2Addrs = addrRes.slice(0, v2N).map((r) => ok<Address>(r)).filter(Boolean) as Address[]
  const clAddrs = addrRes.slice(v2N).map((r) => ok<Address>(r)).filter(Boolean) as Address[]

  // ---- per-pool detail ----
  const detail: unknown[] = []
  for (const p of v2Addrs) {
    detail.push(
      { abi: v2PoolAbi, address: p, functionName: 'metadata' },
      { abi: v2PoolAbi, address: p, functionName: 'totalSupply' },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [p] },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [p] },
      { abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'getFee', args: [p, false] },
    )
  }
  for (const p of clAddrs) {
    detail.push(
      { abi: clPoolAbi, address: p, functionName: 'slot0' },
      { abi: clPoolAbi, address: p, functionName: 'liquidity' },
      { abi: clPoolAbi, address: p, functionName: 'stakedLiquidity' },
      { abi: clPoolAbi, address: p, functionName: 'fee' },
      { abi: clPoolAbi, address: p, functionName: 'unstakedFee' },
      { abi: clPoolAbi, address: p, functionName: 'tickSpacing' },
      { abi: clPoolAbi, address: p, functionName: 'token0' },
      { abi: clPoolAbi, address: p, functionName: 'token1' },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'gauges', args: [p] },
      { abi: voterAbi, address: ADDR.VOTER, functionName: 'weights', args: [p] },
    )
  }
  const det = await mc(pc, detail)

  const v2Pools: V2Pool[] = []
  let i = 0
  for (const p of v2Addrs) {
    const md = ok<readonly [bigint, bigint, bigint, bigint, boolean, Address, Address]>(det[i])
    const totalSupply = ok<bigint>(det[i + 1]) ?? 0n
    const gauge = ok<Address>(det[i + 2])
    const weight = ok<bigint>(det[i + 3]) ?? 0n
    i += 5
    if (!md) continue
    v2Pools.push({
      kind: 'v2',
      protocol: 'up33',
      address: p,
      token0: md[5],
      token1: md[6],
      stable: md[4],
      reserve0: md[2],
      reserve1: md[3],
      totalSupply,
      gaugeTotalSupply: 0n, // filled in pass 2
      feeBps: 0, // filled below with the stable-aware getFee
      gauge: gauge && gauge !== zeroAddress ? gauge : null,
      gaugeAlive: false,
      weight,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  }
  const clPools: ClPool[] = []
  for (const p of clAddrs) {
    const s0 = ok<readonly [bigint, number, number, number, number, boolean]>(det[i])
    const liquidity = ok<bigint>(det[i + 1]) ?? 0n
    const stakedLiquidity = ok<bigint>(det[i + 2]) ?? 0n
    const fee = ok<number>(det[i + 3]) ?? 0
    const unstakedFee = ok<number>(det[i + 4]) ?? 0
    const tickSpacing = ok<number>(det[i + 5]) ?? 0
    const token0 = ok<Address>(det[i + 6])
    const token1 = ok<Address>(det[i + 7])
    const gauge = ok<Address>(det[i + 8])
    const weight = ok<bigint>(det[i + 9]) ?? 0n
    i += 10
    if (!s0 || !token0 || !token1) continue
    clPools.push({
      kind: 'cl',
      protocol: 'up33',
      address: p,
      token0,
      token1,
      tickSpacing,
      feePpm: fee,
      unstakedFeePpm: unstakedFee,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity,
      stakedLiquidity,
      gauge: gauge && gauge !== zeroAddress ? gauge : null,
      gaugeAlive: false,
      weight,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  }

  // ---- second pass: stable-aware v2 fee + gauge liveness/rates ----
  const pass2: unknown[] = []
  const pass2Tag: { kind: string; idx: number }[] = []
  v2Pools.forEach((p, idx) => {
    pass2.push({
      abi: v2FactoryAbi,
      address: ADDR.V2_FACTORY,
      functionName: 'getFee',
      args: [p.address, p.stable],
    })
    pass2Tag.push({ kind: 'v2fee', idx })
  })
  const allPools: Pool[] = [...v2Pools, ...clPools]
  allPools.forEach((p, idx) => {
    if (!p.gauge) return
    const gaugeAbi = p.kind === 'v2' ? v2GaugeAbi : clGaugeAbi
    pass2.push({ abi: voterAbi, address: ADDR.VOTER, functionName: 'isAlive', args: [p.gauge] })
    pass2Tag.push({ kind: 'alive', idx })
    pass2.push({ abi: gaugeAbi, address: p.gauge, functionName: 'rewardRate' })
    pass2Tag.push({ kind: 'rate', idx })
    pass2.push({ abi: gaugeAbi, address: p.gauge, functionName: 'periodFinish' })
    pass2Tag.push({ kind: 'finish', idx })
    if (p.kind === 'v2') {
      pass2.push({ abi: v2GaugeAbi, address: p.gauge, functionName: 'totalSupply' })
      pass2Tag.push({ kind: 'gts', idx })
    }
  })
  const p2 = await mc(pc, pass2)
  p2.forEach((r, j) => {
    const tag = pass2Tag[j]
    if (tag.kind === 'v2fee') {
      const fee = ok<bigint>(r)
      if (fee !== undefined) (v2Pools[tag.idx] as V2Pool).feeBps = Number(fee)
      return
    }
    const pool = allPools[tag.idx]
    if (tag.kind === 'alive') pool.gaugeAlive = ok<boolean>(r) ?? false
    if (tag.kind === 'rate') pool.rewardRate = ok<bigint>(r) ?? 0n
    if (tag.kind === 'finish') pool.periodFinish = ok<bigint>(r) ?? 0n
    if (tag.kind === 'gts' && pool.kind === 'v2') pool.gaugeTotalSupply = ok<bigint>(r) ?? 0n
  })

  // ---- token metadata ----
  const cache = loadTokenCache()
  const tokens: Record<string, TokenInfo> = {}
  const missing: Address[] = []
  const uniq = new Set<string>()
  for (const p of allPools) {
    for (const t of [p.token0, p.token1]) {
      const k = t.toLowerCase()
      if (uniq.has(k)) continue
      uniq.add(k)
      if (cache[k]) tokens[k] = cache[k]
      else missing.push(t)
    }
  }
  if (missing.length) {
    const metaRes = await mc(
      pc,
      missing.flatMap((t) => [
        { abi: erc20Abi, address: t, functionName: 'symbol' },
        { abi: erc20Abi, address: t, functionName: 'decimals' },
      ]),
    )
    missing.forEach((t, j) => {
      const symbol = ok<string>(metaRes[j * 2]) ?? t.slice(0, 6) + '…'
      const decimals = ok<number>(metaRes[j * 2 + 1]) ?? 18
      const info: TokenInfo = { address: t, symbol, decimals }
      tokens[t.toLowerCase()] = info
      cache[t.toLowerCase()] = info
    })
    saveTokenCache(cache)
  }

  // sort: gauged & emitting first (by vote weight), then by kind
  allPools.sort((a, b) => {
    const aw = a.weight
    const bw = b.weight
    if (aw !== bw) return bw > aw ? 1 : -1
    return a.kind === b.kind ? 0 : a.kind === 'cl' ? -1 : 1
  })

  return {
    pools: allPools,
    tokens,
    protocol: {
      weekly: ok<bigint>(head[2]) ?? 0n,
      epochCount: Number(ok<bigint>(head[3]) ?? 0n),
      activePeriod: Number(ok<bigint>(head[4]) ?? 0n),
      totalWeight: ok<bigint>(head[5]) ?? 0n,
      capMode: ok<number>(head[6]) ?? null,
      blockNumber,
    },
  }
}

export function usePools() {
  const pc = usePublicClient()
  return useQuery({
    queryKey: ['pools'],
    enabled: !!pc,
    refetchInterval: 20_000,
    queryFn: () => fetchPools(pc as PublicClient),
  })
}

export function tokenOf(data: PoolsData | undefined, addr: Address | string): TokenInfo {
  const k = addr.toLowerCase()
  return (
    data?.tokens[k] ?? {
      address: addr as Address,
      symbol: addr.slice(0, 6) + '…',
      decimals: 18,
    }
  )
}

export function poolLabel(data: PoolsData | undefined, p: Pool): string {
  const t0 = tokenOf(data, p.token0).symbol
  const t1 = tokenOf(data, p.token1).symbol
  return `${t0}/${t1}`
}

export function poolTypeLabel(p: Pool): string {
  if (p.kind === 'v2') {
    if (p.protocol === 'univ2') return 'uniswap v2'
    return p.stable ? 'v2 STABLE' : 'v2 VOLATILE'
  }
  if (p.protocol === 'univ3') return `uniswap v3 ts${p.tickSpacing}`
  return `CL ts${p.tickSpacing}`
}

export function poolFeePct(p: Pool): number {
  return p.kind === 'v2' ? p.feeBps / 100 : p.feePpm / 10_000
}
