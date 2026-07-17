import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { clGaugeAbi, clPmAbi, erc20Abi, uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi, v2GaugeAbi, v2PoolAbi } from '../abi'
import { ADDR, UNI } from '../config/addresses'
import { MAX_UINT128, getAmountsForLiquidity, getSqrtRatioAtTick } from '../lib/clmath'
import type { ClPool, ClPosition, PoolsData, PositionsData, TokenInfo, V2Pool, V2Position } from '../types'
import { usePools } from './usePools'

type McRes = { status: 'success' | 'failure'; result?: unknown }
async function mc(pc: PublicClient, contracts: unknown[]): Promise<McRes[]> {
  if (contracts.length === 0) return []
  return (await pc.multicall({ contracts: contracts as never })) as McRes[]
}
function ok<T>(r: McRes | undefined): T | undefined {
  return r && r.status === 'success' ? (r.result as T) : undefined
}

type RawPos = readonly [
  bigint, // nonce
  Address, // operator
  Address, // token0
  Address, // token1
  number, // tickSpacing
  number, // tickLower
  number, // tickUpper
  bigint, // liquidity
  bigint,
  bigint,
  bigint, // tokensOwed0
  bigint, // tokensOwed1
]

// same tuple shape as RawPos, but index 4 is the uint24 fee tier (univ3 NPMs
// are fee-keyed where Slipstream is tickSpacing-keyed)
type RawUniPos = RawPos

/**
 * Uniswap v3 wallet positions (official Robinhood Chain deployment). Pools are
 * discovered per position via factory.getPool and read fresh (slot0/liquidity/
 * tickSpacing); tokens outside the UP33 registry get erc20 metadata fetched so
 * any pair renders correctly. No gauges here — positions are never staked.
 */
async function fetchUniPositions(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
): Promise<{ cl: ClPosition[]; tokens: Record<string, TokenInfo> }> {
  const none = { cl: [], tokens: {} }
  const cntRes = await mc(pc, [
    { abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'balanceOf', args: [user] },
  ])
  const count = Number(ok<bigint>(cntRes[0]) ?? 0n)
  if (count === 0) return none

  const idRes = await mc(
    pc,
    Array.from({ length: Math.min(count, 100) }, (_, i) => ({
      abi: uniV3PmAbi,
      address: UNI.V3_NPM,
      functionName: 'tokenOfOwnerByIndex',
      args: [user, BigInt(i)],
    })),
  )
  const ids = idRes.map((r) => ok<bigint>(r)).filter((x): x is bigint => x !== undefined)
  if (ids.length === 0) return none

  const posRes = await mc(
    pc,
    ids.map((id) => ({ abi: uniV3PmAbi, address: UNI.V3_NPM, functionName: 'positions', args: [id] })),
  )
  const raws = ids
    .map((id, j) => ({ id, raw: ok<RawUniPos>(posRes[j]) }))
    .filter((x): x is { id: bigint; raw: RawUniPos } => !!x.raw)
    // drop empty NFTs (closed positions linger in wallets)
    .filter(({ raw }) => raw[7] > 0n || raw[10] > 0n || raw[11] > 0n)
  if (raws.length === 0) return none

  // resolve each distinct (token0, token1, fee) to its pool address
  const poolKeys = new Map<string, { token0: Address; token1: Address; fee: number }>()
  for (const { raw } of raws) {
    poolKeys.set(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`, {
      token0: raw[2],
      token1: raw[3],
      fee: raw[4],
    })
  }
  const keys = [...poolKeys.entries()]
  const addrRes = await mc(
    pc,
    keys.map(([, k]) => ({
      abi: uniV3FactoryAbi,
      address: UNI.V3_FACTORY,
      functionName: 'getPool',
      args: [k.token0, k.token1, k.fee],
    })),
  )

  // pool state + erc20 metadata for tokens the UP33 registry doesn't know
  const unknownTokens = new Set<string>()
  for (const [, k] of keys) {
    for (const t of [k.token0, k.token1]) {
      if (!pools.tokens[t.toLowerCase()]) unknownTokens.add(t.toLowerCase())
    }
  }
  const tokenList = [...unknownTokens] as Address[]
  const poolAddrs = keys.map(([, ], i) => ok<Address>(addrRes[i]))
  const stateCalls: unknown[] = poolAddrs.flatMap((a) =>
    a
      ? [
          { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
          { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
          { abi: uniV3PoolAbi, address: a, functionName: 'tickSpacing' },
        ]
      : [],
  )
  const metaCalls: unknown[] = tokenList.flatMap((t) => [
    { abi: erc20Abi, address: t, functionName: 'symbol' },
    { abi: erc20Abi, address: t, functionName: 'decimals' },
  ])
  const r = await mc(pc, [...stateCalls, ...metaCalls])

  const poolByKey = new Map<string, ClPool>()
  let ri = 0
  keys.forEach(([key, k], i) => {
    const address = poolAddrs[i]
    if (!address) return
    const s0 = ok<readonly [bigint, number, number, number, number, number, boolean]>(r[ri])
    const liquidity = ok<bigint>(r[ri + 1]) ?? 0n
    const tickSpacing = ok<number>(r[ri + 2]) ?? 0
    ri += 3
    if (!s0) return
    poolByKey.set(key, {
      kind: 'cl',
      protocol: 'univ3',
      address,
      token0: k.token0,
      token1: k.token1,
      tickSpacing,
      feePpm: k.fee, // univ3 fee unit (hundredths of a bip) == ppm
      unstakedFeePpm: 0,
      sqrtPriceX96: s0[0],
      tick: s0[1],
      liquidity,
      stakedLiquidity: 0n,
      gauge: null,
      gaugeAlive: false,
      weight: 0n,
      rewardRate: 0n,
      periodFinish: 0n,
    })
  })
  const tokens: Record<string, TokenInfo> = {}
  tokenList.forEach((t, i) => {
    const base = stateCalls.length + i * 2
    tokens[t.toLowerCase()] = {
      address: t,
      symbol: ok<string>(r[base]) ?? t.slice(0, 6) + '…',
      decimals: ok<number>(r[base + 1]) ?? 18,
    }
  })

  const cl: ClPosition[] = []
  for (const { id, raw } of raws) {
    const pool = poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)
    if (!pool) continue
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      raw[7],
    )
    cl.push({
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity: raw[7],
      staked: false,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned: 0n,
    })
  }
  return { cl, tokens }
}

async function fetchPositions(
  pc: PublicClient,
  user: Address,
  pools: PoolsData,
): Promise<PositionsData> {
  // univ3 discovery runs concurrently with the UP33 passes below
  const uniP = fetchUniPositions(pc, user, pools).catch(() => ({ cl: [], tokens: {} }))
  const clPools = pools.pools.filter((p): p is ClPool => p.kind === 'cl')
  const v2Pools = pools.pools.filter((p): p is V2Pool => p.kind === 'v2')
  const clGauges = clPools.filter((p) => p.gauge)

  // pass 1: counts + per-pool balances
  const pass1: unknown[] = [
    { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'balanceOf', args: [user] },
    ...clGauges.map((p) => ({
      abi: clGaugeAbi,
      address: p.gauge!,
      functionName: 'stakedValues',
      args: [user],
    })),
    ...v2Pools.flatMap((p) => [
      { abi: v2PoolAbi, address: p.address, functionName: 'balanceOf', args: [user] },
      { abi: v2PoolAbi, address: p.address, functionName: 'claimable0', args: [user] },
      { abi: v2PoolAbi, address: p.address, functionName: 'claimable1', args: [user] },
      ...(p.gauge
        ? [
            { abi: v2GaugeAbi, address: p.gauge, functionName: 'balanceOf', args: [user] },
            { abi: v2GaugeAbi, address: p.gauge, functionName: 'earned', args: [user] },
          ]
        : []),
    ]),
  ]
  const r1 = await mc(pc, pass1)
  let idx = 0
  const walletCount = Number(ok<bigint>(r1[idx++]) ?? 0n)
  const stakedIdsByGauge: { pool: ClPool; ids: bigint[] }[] = []
  for (const p of clGauges) {
    const ids = ok<readonly bigint[]>(r1[idx++]) ?? []
    if (ids.length) stakedIdsByGauge.push({ pool: p, ids: [...ids] })
  }
  const v2Raw: {
    pool: V2Pool
    walletLp: bigint
    claimable0: bigint
    claimable1: bigint
    stakedLp: bigint
    earned: bigint
  }[] = []
  for (const p of v2Pools) {
    const walletLp = ok<bigint>(r1[idx++]) ?? 0n
    const claimable0 = ok<bigint>(r1[idx++]) ?? 0n
    const claimable1 = ok<bigint>(r1[idx++]) ?? 0n
    let stakedLp = 0n
    let earned = 0n
    if (p.gauge) {
      stakedLp = ok<bigint>(r1[idx++]) ?? 0n
      earned = ok<bigint>(r1[idx++]) ?? 0n
    }
    if (walletLp > 0n || stakedLp > 0n || claimable0 > 0n || claimable1 > 0n || earned > 0n) {
      v2Raw.push({ pool: p, walletLp, claimable0, claimable1, stakedLp, earned })
    }
  }

  // pass 2: wallet tokenIds
  const idRes = await mc(
    pc,
    Array.from({ length: Math.min(walletCount, 100) }, (_, i) => ({
      abi: clPmAbi,
      address: ADDR.CL_PM,
      functionName: 'tokenOfOwnerByIndex',
      args: [user, BigInt(i)],
    })),
  )
  const walletIds = idRes.map((r) => ok<bigint>(r)).filter((x): x is bigint => x !== undefined)

  // pass 3: position structs (+ earned for staked)
  const stakedFlat = stakedIdsByGauge.flatMap(({ pool, ids }) => ids.map((id) => ({ pool, id })))
  const pass3: unknown[] = [
    ...walletIds.map((id) => ({
      abi: clPmAbi,
      address: ADDR.CL_PM,
      functionName: 'positions',
      args: [id],
    })),
    ...stakedFlat.flatMap(({ pool, id }) => [
      { abi: clPmAbi, address: ADDR.CL_PM, functionName: 'positions', args: [id] },
      { abi: clGaugeAbi, address: pool.gauge!, functionName: 'earned', args: [user, id] },
    ]),
  ]
  const r3 = await mc(pc, pass3)

  const poolByKey = new Map<string, ClPool>()
  for (const p of clPools) {
    poolByKey.set(`${p.token0.toLowerCase()}|${p.token1.toLowerCase()}|${p.tickSpacing}`, p)
  }
  const findPool = (raw: RawPos): ClPool | undefined =>
    poolByKey.get(`${raw[2].toLowerCase()}|${raw[3].toLowerCase()}|${raw[4]}`)

  const cl: ClPosition[] = []

  const buildPos = (
    id: bigint,
    raw: RawPos,
    staked: boolean,
    earned: bigint,
  ): ClPosition | null => {
    const pool = findPool(raw)
    if (!pool) return null
    const liquidity = raw[7]
    const { amount0, amount1 } = getAmountsForLiquidity(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(raw[5]),
      getSqrtRatioAtTick(raw[6]),
      liquidity,
    )
    return {
      tokenId: id,
      pool,
      tickLower: raw[5],
      tickUpper: raw[6],
      liquidity,
      staked,
      amount0,
      amount1,
      fees0: raw[10],
      fees1: raw[11],
      earned,
    }
  }

  walletIds.forEach((id, j) => {
    const raw = ok<RawPos>(r3[j])
    if (!raw) return
    const pos = buildPos(id, raw, false, 0n)
    if (pos && (pos.liquidity > 0n || pos.fees0 > 0n || pos.fees1 > 0n)) cl.push(pos)
  })
  stakedFlat.forEach(({ id }, j) => {
    const base = walletIds.length + j * 2
    const raw = ok<RawPos>(r3[base])
    const earned = ok<bigint>(r3[base + 1]) ?? 0n
    if (!raw) return
    const pos = buildPos(id, raw, true, earned)
    if (pos) cl.push(pos)
  })

  // univ3 wallet positions join here so the fee simulation below covers them
  const uni = await uniP
  cl.push(...uni.cl)

  // pass 4: exact uncollected fees for wallet positions via collect() simulation
  // (collect is signature-identical on both NPMs — only the address differs)
  await Promise.all(
    cl
      .filter((p) => !p.staked)
      .map(async (p) => {
        try {
          const sim = await pc.simulateContract({
            abi: clPmAbi,
            address: p.pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM,
            functionName: 'collect',
            args: [
              {
                tokenId: p.tokenId,
                recipient: user,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
              },
            ],
            account: user,
          })
          const [f0, f1] = sim.result as readonly [bigint, bigint]
          p.fees0 = f0
          p.fees1 = f1
        } catch {
          /* keep tokensOwed fallback */
        }
      }),
  )

  const v2: V2Position[] = v2Raw.map((r) => {
    const lp = r.walletLp + r.stakedLp
    const ts = r.pool.totalSupply
    return {
      pool: r.pool,
      walletLp: r.walletLp,
      stakedLp: r.stakedLp,
      earned: r.earned,
      claimable0: r.claimable0,
      claimable1: r.claimable1,
      amount0: ts > 0n ? (lp * r.pool.reserve0) / ts : 0n,
      amount1: ts > 0n ? (lp * r.pool.reserve1) / ts : 0n,
    }
  })

  // staked first, then wallet up33, then univ3
  const rank = (p: ClPosition) => (p.staked ? 0 : p.pool.protocol === 'up33' ? 1 : 2)
  cl.sort((a, b) => rank(a) - rank(b))
  return { cl, v2, tokens: uni.tokens }
}

export function usePositions(user?: Address) {
  const pc = usePublicClient()
  const pools = usePools()
  return useQuery({
    queryKey: ['positions', user],
    enabled: !!pc && !!user && !!pools.data,
    refetchInterval: 15_000,
    queryFn: () => fetchPositions(pc as PublicClient, user!, pools.data!),
  })
}
