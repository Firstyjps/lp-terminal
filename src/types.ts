import type { Address } from 'viem'

export type TokenInfo = {
  address: Address
  symbol: string
  decimals: number
  native?: boolean
}

export type PoolBase = {
  address: Address
  token0: Address
  token1: Address
  gauge: Address | null
  gaugeAlive: boolean
  weight: bigint // Voter vote weight for this pool
  rewardRate: bigint // UP wei/s while periodFinish in future
  periodFinish: bigint
}

/** which DEX a pool/position belongs to (POOLS/POSITIONS handle all of them) */
export type LpProtocol = 'up33' | 'univ3' | 'univ2'

export type V2Pool = PoolBase & {
  kind: 'v2'
  /** 'up33' = Solidly-style pair (stable flag, gauges); 'univ2' = vanilla Uniswap v2 */
  protocol: 'up33' | 'univ2'
  stable: boolean
  reserve0: bigint
  reserve1: bigint
  totalSupply: bigint
  gaugeTotalSupply: bigint // staked LP total in the gauge
  feeBps: number // 1 = 0.01%
}

export type ClPool = PoolBase & {
  kind: 'cl'
  protocol: 'up33' | 'univ3'
  tickSpacing: number
  feePpm: number // 1e6 = 100%
  unstakedFeePpm: number
  sqrtPriceX96: bigint
  tick: number
  liquidity: bigint
  stakedLiquidity: bigint
}

export type Pool = V2Pool | ClPool

export type Protocol = {
  weekly: bigint
  epochCount: number
  activePeriod: number
  totalWeight: bigint
  capMode: number | null
  blockNumber: bigint
}

export type PoolsData = {
  pools: Pool[]
  tokens: Record<string, TokenInfo> // key: lowercase address
  protocol: Protocol
}

export type ClPosition = {
  tokenId: bigint
  pool: ClPool
  tickLower: number
  tickUpper: number
  liquidity: bigint
  staked: boolean
  amount0: bigint // current underlying at pool price
  amount1: bigint
  fees0: bigint // uncollected fees (wallet positions only)
  fees1: bigint
  earned: bigint // pending UP (staked positions only)
}

export type V2Position = {
  pool: V2Pool
  walletLp: bigint
  stakedLp: bigint
  earned: bigint // pending UP from gauge
  claimable0: bigint // unstaked LP fees
  claimable1: bigint
  // underlying for wallet+staked LP at current reserves
  amount0: bigint
  amount1: bigint
}

export type PositionsData = {
  cl: ClPosition[]
  v2: V2Position[]
  /** metadata for position tokens outside the UP33 pool registry (univ3 pairs) */
  tokens: Record<string, TokenInfo>
}
