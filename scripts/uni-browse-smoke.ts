// Live smoke for the univ3 POOLS browse layer: replicates fetchUniBrowse
// (src/lib/uniBrowse.ts) with the REAL abi/address/clmath modules — env.ts
// can't load under node, so the flow is mirrored, not imported.
// Never prints the RPC URL.
import { readFileSync } from 'node:fs'
import { createPublicClient, defineChain, encodeFunctionData, getAddress, http, zeroAddress, type Address, type PublicClient } from 'viem'
import { uniV3FactoryAbi, uniV3PmAbi, uniV3PoolAbi } from '../src/abi/index'
import { ADDR, UNI } from '../src/config/addresses'
import { getLiquidityForAmounts, getSqrtRatioAtTick, minAmountsForLiquidity } from '../src/lib/clmath'

// duplicated rather than imported: src/config/env.ts reads import.meta.env,
// which is vite-only and does not load under node/tsx.
const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

/** repo-root .env `RPC` (SECRET — never print it). No .env / no key: public RPC. */
const rpc = (() => {
  const fromEnv = process.env.RPC?.trim()
  if (fromEnv) return fromEnv
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
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
const pc = createPublicClient({ chain, transport: http(rpc, { batch: true }) }) as PublicClient

let fails = 0
function check(name: string, cond: boolean, detail = '') {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!cond) fails++
}

type DsPair = { chainId?: string; dexId?: string; labels?: string[]; pairAddress?: string; volume?: { h24?: number }; liquidity?: { usd?: number } }
const v3PairsOf = (json: unknown): DsPair[] => {
  const arr = Array.isArray(json) ? (json as DsPair[]) : ((json as { pairs?: DsPair[] })?.pairs ?? [])
  return arr.filter((p) => p?.chainId === 'robinhood' && p?.dexId === 'uniswap' && (p?.labels ?? []).includes('v3'))
}
type McRes = { status: string; result?: unknown }
const ok = <T,>(r: McRes | undefined): T | undefined => (r && r.status === 'success' ? (r.result as T) : undefined)

const FEE_TS: Record<number, number> = { 100: 1, 500: 10, 3000: 60, 10000: 200 }
const KNOWN_POOL = '0xa9188730fe85be88ad499d7d52b099e800fb0334' // WETH/USDG 0.3% (verified earlier)

async function main() {
  // 1. token-pairs discovery for WETH (the default browse query)
  const tp = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ADDR.WETH}`)).json()
  const cands = v3PairsOf(tp)
  check('dexscreener token-pairs finds v3 WETH pools', cands.length >= 1, `${cands.length} candidates`)
  // token-pairs caps at ~30 pairs/token (activity-ordered) — a pool missing from
  // one token's list is reachable via its OTHER token; assert exactly that:
  const tpU = await (await fetch(`https://api.dexscreener.com/token-pairs/v1/robinhood/${ADDR.USDG}`)).json()
  check('known USDG/WETH 0.3% pool reachable via USDG query', v3PairsOf(tpU).some((p) => p.pairAddress?.toLowerCase() === KNOWN_POOL))

  // 2. rank by TVL + cap (same as the lib)
  const seen = new Map<string, DsPair>()
  for (const p of cands) { const a = p.pairAddress?.toLowerCase(); if (a && !seen.has(a)) seen.set(a, p) }
  const picks = [...seen.values()].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0)).slice(0, 30)
  console.log(`   top pools by TVL: ${picks.slice(0, 5).map((p) => `${p.pairAddress?.slice(0, 8)}($${Math.round(p.liquidity?.usd ?? 0)})`).join(' ')}`)

  // 3. hydrate from the pool contracts
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
  type Hyd = { addr: Address; token0: Address; token1: Address; fee: number; ts: number; sqrtP: bigint; tick: number; liq: bigint }
  const hyd: Hyd[] = []
  addrs.forEach((a, i) => {
    const token0 = ok<Address>(det[i * 6]); const token1 = ok<Address>(det[i * 6 + 1])
    const fee = ok<number>(det[i * 6 + 2]); const ts = ok<number>(det[i * 6 + 3])
    const s0 = ok<readonly [bigint, number]>(det[i * 6 + 4]); const liq = ok<bigint>(det[i * 6 + 5])
    if (!token0 || !token1 || fee === undefined || ts === undefined || !s0) return
    hyd.push({ addr: a, token0, token1, fee, ts, sqrtP: s0[0], tick: s0[1], liq: liq ?? 0n })
  })
  check('all candidates hydrate on-chain', hyd.length === addrs.length, `${hyd.length}/${addrs.length}`)
  check('fee↔tickSpacing mapping consistent', hyd.every((h) => FEE_TS[h.fee] === h.ts))

  // 4. factory.getPool authenticity round-trip
  const gp = (await pc.multicall({
    contracts: hyd.map((h) => ({ abi: uniV3FactoryAbi, address: UNI.V3_FACTORY, functionName: 'getPool', args: [h.token0, h.token1, h.fee] })) as never,
  })) as McRes[]
  const verified = hyd.filter((h, i) => {
    const m = ok<Address>(gp[i])
    return !!m && m !== zeroAddress && m.toLowerCase() === h.addr.toLowerCase()
  })
  check('factory.getPool verifies every pool', verified.length === hyd.length, `${verified.length}/${hyd.length} (drops would be spoofs)`)

  // 5. symbol search path
  const sr = await (await fetch('https://api.dexscreener.com/latest/dex/search?q=USDG')).json()
  check('symbol search returns robinhood v3 pairs', v3PairsOf(sr).length >= 1, `${v3PairsOf(sr).length} matches`)

  // 6. mint calldata: canonical univ3 selector + slippage mins sane on live state
  const h0 = verified.find((h) => h.addr.toLowerCase() === KNOWN_POOL) ?? verified[0]
  const lower = Math.floor((h0.tick - 600) / h0.ts) * h0.ts
  const upper = Math.ceil((h0.tick + 600) / h0.ts) * h0.ts
  const amt0 = 10n ** 15n
  const liq = getLiquidityForAmounts(h0.sqrtP, getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper), amt0, 2n ** 120n)
  const mins = minAmountsForLiquidity(h0.sqrtP, getSqrtRatioAtTick(lower), getSqrtRatioAtTick(upper), liq, 100)
  const data = encodeFunctionData({
    abi: uniV3PmAbi,
    functionName: 'mint',
    args: [{ token0: h0.token0, token1: h0.token1, fee: h0.fee, tickLower: lower, tickUpper: upper, amount0Desired: amt0, amount1Desired: 2n ** 120n, amount0Min: mins.amount0Min, amount1Min: mins.amount1Min, recipient: '0x0000000000000000000000000000000000000001', deadline: 2n ** 40n }],
  })
  check('mint selector == canonical 0x88316456', data.slice(0, 10) === '0x88316456', data.slice(0, 10))
  check('band-edge mins nonzero for in-range band', mins.amount0Min > 0n && mins.amount1Min > 0n, `${mins.amount0Min}/${mins.amount1Min}`)

  console.log(fails === 0 ? '\nALL UNI-BROWSE SMOKE CHECKS PASSED' : `\n${fails} CHECKS FAILED`)
  process.exit(fails === 0 ? 0 : 1)
}

void main()
