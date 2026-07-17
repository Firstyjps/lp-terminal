// Live-chain smoke test for the read layer: TickMath constants, ABI selectors,
// pool discovery, quoter-vs-kyber sanity. Run: npm run smoke
// Never prints the RPC URL.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createPublicClient, defineChain, http, parseUnits, type Address } from 'viem'
import {
  clFactoryAbi,
  clGaugeAbi,
  clPoolAbi,
  quoterAbi,
  v2FactoryAbi,
  v2GaugeAbi,
  voterAbi,
} from '../src/abi'
import { ADDR } from '../src/config/addresses'
import {
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  sqrtPriceToPrice,
} from '../src/lib/clmath'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}

// duplicated rather than imported: src/config/env.ts reads import.meta.env,
// which is vite-only and does not load under node/tsx.
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/** repo-root .env `RPC` (SECRET — never print it). No .env / no key: public RPC. */
const rpc = (() => {
  const fromEnv = process.env.RPC?.trim()
  if (fromEnv) return fromEnv
  try {
    const text = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8')
    return text.match(/^\s*RPC\s*=\s*(\S+)\s*$/m)?.[1] ?? PUBLIC_RPC
  } catch {
    return PUBLIC_RPC
  }
})()

const chain = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [rpc] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})
const pc = createPublicClient({ chain, transport: http(rpc, { batch: true }) })

type Res = { status: 'success' | 'failure'; result?: unknown }
const ok = <T,>(r: Res | undefined): T | undefined =>
  r && r.status === 'success' ? (r.result as T) : undefined

async function main() {
  console.log('== UP33 TERMINAL smoke test ==')

  // 1. chain id
  const id = await pc.getChainId()
  check('chainId == 4663', id === 4663, String(id))

  // 2. TickMath constants vs float reference
  let maxRel = 0
  for (const t of [-887200, -200000, -46055, -100, -1, 0, 1, 100, 46054, 200000, 443636, 887200]) {
    const exact = Number(getSqrtRatioAtTick(t)) / 2 ** 96
    const approx = Math.sqrt(Math.pow(1.0001, t))
    const rel = Math.abs(exact - approx) / approx
    if (rel > maxRel) maxRel = rel
  }
  check('TickMath matches float ref (<1e-9 rel)', maxRel < 1e-9, `maxRel=${maxRel.toExponential(2)}`)

  // 3. liquidity math round-trip
  {
    const sqrtP = getSqrtRatioAtTick(102000)
    const sqrtA = getSqrtRatioAtTick(100000)
    const sqrtB = getSqrtRatioAtTick(104000)
    const in0 = parseUnits('1', 18)
    const L = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, in0, (1n << 255n))
    const { amount0 } = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, L)
    const rel = Number(((in0 - amount0) * 1_000_000n) / in0) / 1e6
    check('liquidity round-trip (amount0 within 0.01%)', amount0 <= in0 && rel < 1e-4, `loss=${rel}`)
  }

  // 4. factories enumerable
  const head = (await pc.multicall({
    contracts: [
      { abi: v2FactoryAbi, address: ADDR.V2_FACTORY, functionName: 'allPoolsLength' },
      { abi: clFactoryAbi, address: ADDR.CL_FACTORY, functionName: 'allPoolsLength' },
    ] as never,
  })) as Res[]
  const v2Len = Number(ok<bigint>(head[0]) ?? 0n)
  const clLen = Number(ok<bigint>(head[1]) ?? 0n)
  check('factories enumerable', v2Len >= 3 && clLen >= 15, `${v2Len} v2 + ${clLen} CL pools`)

  // 5. enumerate CL pools, validate slot0 tick <-> sqrtPrice against our TickMath
  const clAddrRes = (await pc.multicall({
    contracts: Array.from({ length: clLen }, (_, i) => ({
      abi: clFactoryAbi,
      address: ADDR.CL_FACTORY,
      functionName: 'allPools',
      args: [BigInt(i)],
    })) as never,
  })) as Res[]
  const clAddrs = clAddrRes.map((r) => ok<Address>(r)).filter(Boolean) as Address[]
  const slotRes = (await pc.multicall({
    contracts: clAddrs.flatMap((p) => [
      { abi: clPoolAbi, address: p, functionName: 'slot0' },
      { abi: clPoolAbi, address: p, functionName: 'token0' },
      { abi: clPoolAbi, address: p, functionName: 'token1' },
      { abi: clPoolAbi, address: p, functionName: 'tickSpacing' },
      { abi: clPoolAbi, address: p, functionName: 'liquidity' },
      { abi: clPoolAbi, address: p, functionName: 'gauge' },
    ]) as never,
  })) as Res[]
  let tickOk = 0
  let tickBad = 0
  const clPools: {
    addr: Address
    sqrtP: bigint
    tick: number
    t0: Address
    t1: Address
    ts: number
    liq: bigint
    gauge?: Address
  }[] = []
  clAddrs.forEach((p, i) => {
    const s0 = ok<readonly [bigint, number, number, number, number, boolean]>(slotRes[i * 6])
    const t0 = ok<Address>(slotRes[i * 6 + 1])
    const t1 = ok<Address>(slotRes[i * 6 + 2])
    const ts = ok<number>(slotRes[i * 6 + 3])
    const liq = ok<bigint>(slotRes[i * 6 + 4]) ?? 0n
    const gauge = ok<Address>(slotRes[i * 6 + 5])
    if (!s0 || !t0 || !t1 || ts === undefined) return
    clPools.push({ addr: p, sqrtP: s0[0], tick: s0[1], t0, t1, ts, liq, gauge })
    if (s0[0] === 0n) return
    const lo = getSqrtRatioAtTick(s0[1])
    const hi = getSqrtRatioAtTick(s0[1] + 1)
    if (lo <= s0[0] && s0[0] < hi) tickOk++
    else tickBad++
  })
  check('slot0 sqrtPrice within [tick, tick+1) for all CL pools', tickBad === 0, `${tickOk} ok / ${tickBad} bad`)

  // 6. WETH/UP CL pool: our quoter path vs kyber aggregator ballpark
  const wethUp = clPools
    .filter(
      (p) =>
        (p.t0.toLowerCase() === ADDR.WETH.toLowerCase() && p.t1.toLowerCase() === ADDR.UP.toLowerCase()) ||
        (p.t1.toLowerCase() === ADDR.WETH.toLowerCase() && p.t0.toLowerCase() === ADDR.UP.toLowerCase()),
    )
    .sort((a, b) => (b.liq > a.liq ? 1 : -1))[0]
  check('WETH/UP CL pool exists', !!wethUp, wethUp?.addr ?? '')
  let quoterOut: bigint | undefined
  if (wethUp) {
    const oneWeth = parseUnits('1', 18)
    const qRes = (await pc.multicall({
      contracts: [
        {
          abi: quoterAbi,
          address: ADDR.CL_QUOTER,
          functionName: 'quoteExactInputSingle',
          args: [
            {
              tokenIn: ADDR.WETH,
              tokenOut: ADDR.UP,
              amountIn: oneWeth,
              tickSpacing: wethUp.ts,
              sqrtPriceLimitX96: 0n,
            },
          ],
        },
      ] as never,
    })) as Res[]
    const q = ok<readonly [bigint, bigint, number, bigint]>(qRes[0])
    quoterOut = q?.[0]
    check('quoter quotes via multicall (view-cast ABI works)', quoterOut !== undefined && quoterOut > 0n, `1 WETH -> ${quoterOut} UP wei`)

    // spot price sanity vs quoter (small trade impact expected)
    const spot = sqrtPriceToPrice(
      wethUp.sqrtP,
      wethUp.t0.toLowerCase() === ADDR.WETH.toLowerCase() ? 18 : 18,
      18,
    )
    const upPerWeth = wethUp.t0.toLowerCase() === ADDR.WETH.toLowerCase() ? spot : 1 / spot
    if (quoterOut) {
      const outF = Number(quoterOut) / 1e18
      const rel = Math.abs(outF - upPerWeth) / upPerWeth
      check('quoter ~ spot price (<30% incl. fee+impact)', rel < 0.3, `spot=${upPerWeth.toFixed(1)} quote=${outF.toFixed(1)}`)
    }

    try {
      const r = await fetch(
        `https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?tokenIn=${ADDR.WETH}&tokenOut=${ADDR.UP}&amountIn=${oneWeth}`,
        { headers: { 'x-client-id': 'up33-terminal-smoke' } },
      )
      const j: any = await r.json()
      const aggOut = BigInt(j?.data?.routeSummary?.amountOut ?? '0')
      if (aggOut > 0n && quoterOut) {
        const rel = Math.abs(Number(aggOut - quoterOut)) / Number(aggOut)
        check('kyber agg vs our single-pool quote (<25%)', rel < 0.25, `agg=${aggOut} ours=${quoterOut}`)
      } else {
        check('kyber aggregator reachable', aggOut > 0n, j?.message ?? 'no data')
      }
    } catch (e) {
      check('kyber aggregator reachable', false, String(e))
    }
  }

  // 7. v2 gauge standard selectors respond (gauge instances are unverified on Blockscout)
  const v2AddrRes = (await pc.multicall({
    contracts: Array.from({ length: v2Len }, (_, i) => ({
      abi: v2FactoryAbi,
      address: ADDR.V2_FACTORY,
      functionName: 'allPools',
      args: [BigInt(i)],
    })) as never,
  })) as Res[]
  const v2Addrs = v2AddrRes.map((r) => ok<Address>(r)).filter(Boolean) as Address[]
  const gaugeRes = (await pc.multicall({
    contracts: v2Addrs.map((p) => ({
      abi: voterAbi,
      address: ADDR.VOTER,
      functionName: 'gauges',
      args: [p],
    })) as never,
  })) as Res[]
  const zero = '0x0000000000000000000000000000000000000000'
  const v2Gauge = gaugeRes.map((r) => ok<Address>(r)).find((g) => g && g !== zero)
  if (v2Gauge) {
    const rnd = '0x00000000000000000000000000000000000000ff' as Address
    const gRes = (await pc.multicall({
      contracts: [
        { abi: v2GaugeAbi, address: v2Gauge, functionName: 'earned', args: [rnd] },
        { abi: v2GaugeAbi, address: v2Gauge, functionName: 'balanceOf', args: [rnd] },
        { abi: v2GaugeAbi, address: v2Gauge, functionName: 'rewardRate' },
        { abi: v2GaugeAbi, address: v2Gauge, functionName: 'stakingToken' },
      ] as never,
    })) as Res[]
    check(
      'v2 gauge standard selectors respond',
      gRes.every((r) => r.status === 'success'),
      v2Gauge,
    )
  } else {
    check('v2 gauge found', false, 'no gauged v2 pool')
  }

  // 8. CL gauge stakedValues() responds
  const clGauge = clPools.find((p) => p.gauge && p.gauge !== zero)?.gauge
  if (clGauge) {
    const sv = (await pc.multicall({
      contracts: [
        {
          abi: clGaugeAbi,
          address: clGauge,
          functionName: 'stakedValues',
          args: ['0x0eEA30aBa3f07abFA20E4b544F55e0f917d9DFd8'],
        },
      ] as never,
    })) as Res[]
    check('CL gauge stakedValues responds', sv[0].status === 'success', clGauge)
  } else {
    check('CL gauge found', false, 'no gauged CL pool')
  }

  console.log(`\n== ${pass} passed, ${fail} failed ==`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  // avoid leaking the RPC URL inside error strings
  console.error('smoke crashed:', String(e).replace(rpc, '<rpc>'))
  process.exit(1)
})
