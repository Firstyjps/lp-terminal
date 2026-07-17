import { parseAbi } from 'viem'
export { erc20Abi } from 'viem'

// Signatures below were extracted verbatim from Blockscout-verified ABIs.
// Only what the app calls is included.

export const wethAbi = parseAbi([
  'function deposit() payable',
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
])

export const voterAbi = parseAbi([
  'function length() view returns (uint256)',
  'function pools(uint256) view returns (address)',
  'function gauges(address pool) view returns (address)',
  'function isAlive(address gauge) view returns (bool)',
  'function weights(address pool) view returns (uint256)',
  'function totalWeight() view returns (uint256)',
  'function claimable(address gauge) view returns (uint256)',
  'function capMode() view returns (uint8)',
])

export const minterAbi = parseAbi([
  'function weekly() view returns (uint256)',
  'function epochCount() view returns (uint256)',
  'function activePeriod() view returns (uint256)',
])

export const v2FactoryAbi = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
  'function getPool(address tokenA, address tokenB, bool stable) view returns (address)',
  'function getFee(address pool, bool _stable) view returns (uint256)',
])

export const v2PoolAbi = parseAbi([
  'function metadata() view returns (uint256 dec0, uint256 dec1, uint256 r0, uint256 r1, bool st, address t0, address t1)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function getReserves() view returns (uint256 _reserve0, uint256 _reserve1, uint256 _blockTimestampLast)',
  'function claimable0(address) view returns (uint256)',
  'function claimable1(address) view returns (uint256)',
  'function claimFees() returns (uint256 claimed0, uint256 claimed1)',
])

export const v2RouterAbi = parseAbi([
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function quoteAddLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 amountADesired, uint256 amountBDesired) view returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function quoteRemoveLiquidity(address tokenA, address tokenB, bool stable, address _factory, uint256 liquidity) view returns (uint256 amountA, uint256 amountB)',
  'function addLiquidity(address tokenA, address tokenB, bool stable, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, bool stable, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])

// v2 Gauge instances are not individually verified on Blockscout; this is the
// standard Velodrome V2 Gauge interface. Selectors are validated against the
// live chain by scripts/smoke.ts (earned/balanceOf must respond via eth_call).
export const v2GaugeAbi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function earned(address _account) view returns (uint256)',
  'function deposit(uint256 _amount)',
  'function withdraw(uint256 _amount)',
  'function getReward(address _account)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
  'function stakingToken() view returns (address)',
])

export const clFactoryAbi = parseAbi([
  'function allPoolsLength() view returns (uint256)',
  'function allPools(uint256) view returns (address)',
  'function getPool(address, address, int24) view returns (address)',
  'function tickSpacings() view returns (int24[])',
  'function tickSpacingToFee(int24) view returns (uint24)',
])

export const clPoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function stakedLiquidity() view returns (uint128)',
  'function fee() view returns (uint24)',
  'function unstakedFee() view returns (uint24)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function gauge() view returns (address)',
])

export const clPmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity((uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) payable returns (uint256 amount0, uint256 amount1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) payable returns (uint256 amount0, uint256 amount1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function getApproved(uint256 tokenId) view returns (address)',
  'function approve(address to, uint256 tokenId)',
  'function burn(uint256 tokenId) payable',
])

// Note: CLGauge also has getReward(address); only the tokenId variant is included
// to keep viem overload resolution unambiguous.
export const clGaugeAbi = parseAbi([
  'function deposit(uint256 tokenId)',
  'function withdraw(uint256 tokenId)',
  'function getReward(uint256 tokenId)',
  'function earned(address account, uint256 tokenId) view returns (uint256)',
  'function stakedValues(address depositor) view returns (uint256[] staked)',
  'function rewardRate() view returns (uint256)',
  'function periodFinish() view returns (uint256)',
])

// ---- Uniswap v3 (official Robinhood Chain deployment; see addresses.UNI) ----
// Same core math as Slipstream but fee-keyed: positions() carries uint24 fee
// where Slipstream has int24 tickSpacing, and slot0 has an extra feeProtocol
// word. increase/decrease/collect/burn are signature-identical to clPmAbi —
// call those fragments against UNI.V3_NPM instead of duplicating them here.

export const uniV3FactoryAbi = parseAbi([
  'function getPool(address, address, uint24) view returns (address)',
])

export const uniV3PmAbi = parseAbi([
  'function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function balanceOf(address owner) view returns (uint256)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  // mint is the ONE write that differs from Slipstream (uint24 fee instead of
  // int24 tickSpacing, and no sqrtPriceX96 pool-creation field)
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
])

export const uniV3PoolAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function tickSpacing() view returns (int24)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function fee() view returns (uint24)',
])

// ---- Uniswap v2 (official; UNI.V2_FACTORY / UNI.V2_ROUTER) ----
// Vanilla Uniswap v2 — NOT the Solidly-style UP33 v2 (no stable flag, 0.30%
// fixed fee). Pairs are fungible ERC-20 LP tokens, not NFTs.

export const uniV2FactoryAbi = parseAbi([
  'function allPairsLength() view returns (uint256)',
  'function allPairs(uint256) view returns (address)',
  'function getPair(address, address) view returns (address)',
])

export const uniV2PairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
])

export const uniV2RouterAbi = parseAbi([
  'function addLiquidity(address tokenA, address tokenB, uint256 amountADesired, uint256 amountBDesired, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB, uint256 liquidity)',
  'function removeLiquidity(address tokenA, address tokenB, uint256 liquidity, uint256 amountAMin, uint256 amountBMin, address to, uint256 deadline) returns (uint256 amountA, uint256 amountB)',
])

// On-chain the quoter fns are nonpayable (revert-and-catch quoting); declared
// view here so they can ride eth_call/multicall — semantics are identical.
export const quoterAbi = parseAbi([
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
])

export const clSwapRouterAbi = parseAbi([
  'function exactInputSingle((address tokenIn, address tokenOut, int24 tickSpacing, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
])
