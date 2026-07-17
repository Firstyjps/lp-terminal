// ZAP: single-token add-liquidity. The user funds a position with ONE token
// (or native ETH); we solve how much of it to swap into the counter-token so
// the two piles match the deposit ratio the target needs, swap via the gated
// Kyber path, then deposit — one flow, N wallet-signed txs, halting on any
// failure (a halt never strands value: every intermediate asset is a normal
// wallet balance).
//
// Split solve: the needed ratio ρ (raw counter-units per raw kept-unit) comes
// from CL band math (or v2 reserves); with quote rate q̂ (counter per swapped
// unit) the swap size is s = A·ρ/(q̂+ρ). q̂ isn't known until we quote, so:
// seed with the spot rate, quote once, re-solve, and re-quote when the answer
// moved — 2 quotes converge well because q̂ varies slowly with s. Residual
// mismatch (price impact shifting the band ratio) surfaces as DUST: a small
// leftover the deposit doesn't pull, which stays in the wallet. Planning uses
// floats (ratios only); every on-chain amount stays bigint.
import type { Address } from 'viem'
import { readContract, sendTransaction, writeContract } from 'wagmi/actions'
import { clPmAbi, uniV2PairAbi, uniV2RouterAbi, uniV3PmAbi, v2RouterAbi, wethAbi } from '../abi'
import { ADDR, CHAIN_ID, UNI } from '../config/addresses'
import { ENV } from '../config/env'
import { wagmiConfig } from '../config/wagmi'
import { t } from '../i18n'
import {
  applySlippage,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  Q96,
} from './clmath'
import { fmtAmount } from './format'
import { kyberRoute, NATIVE, type KyberRouteData } from './kyber'
import { buildGatedKyberTx } from './kyberExec'
import { deadline, ensureAllowance, fetchSqrtPriceX96, receivedOf, step } from './tx'
import { txlog } from './txlog'
import type { ClPool, Pool, TokenInfo, V2Pool } from '../types'

const MINS_BPS = 100 // deposit mins: 1% band-edge, same as the PAIR flows

export type ZapTarget =
  | { kind: 'cl-mint'; pool: ClPool; tickLower: number; tickUpper: number }
  | { kind: 'cl-increase'; pool: ClPool; tickLower: number; tickUpper: number; tokenId: bigint; npm: Address }
  | { kind: 'v2'; pool: V2Pool }

export type ZapPlan = {
  /** what the user selected (NATIVE sentinel allowed) */
  tokenIn: Address
  nativeIn: boolean
  /** erc20 actually spent (WETH when nativeIn) */
  erc20In: Address
  inIs0: boolean
  amountIn: bigint
  swapIn: bigint
  keep: bigint
  route: KyberRouteData | null // final planning quote (null = no swap needed)
  estOut: bigint
  dep0: bigint
  dep1: bigint
  /** CL only: liquidity the planned deposit mints at the planning price */
  liquidity: bigint
  dust0: bigint
  dust1: bigint
  impactBps: number | null // swap value lost to impact+lp fees (platform fee excluded)
  routeLabel: string
}

function poolOf(tgt: ZapTarget): Pool {
  return tgt.pool
}

const low = (a: string) => a.toLowerCase()
const isNat = (a: Address) => low(a) === low(NATIVE)

/** needed raw-unit ratio (counter per kept) + spot rate seed, by target */
function needAndSpot(tgt: ZapTarget, inIs0: boolean): { rho: number; spot: number } {
  const pool = poolOf(tgt)
  if (pool.kind === 'v2') {
    const r0 = Number(pool.reserve0)
    const r1 = Number(pool.reserve1)
    if (!(r0 > 0) || !(r1 > 0)) throw new Error(t('zap.errNoReserves'))
    const rho = inIs0 ? r1 / r0 : r0 / r1
    return { rho, spot: rho } // marginal v2 price == reserve ratio
  }
  const { tickLower, tickUpper } = tgt as Extract<ZapTarget, { kind: 'cl-mint' | 'cl-increase' }>
  const p = Number(pool.sqrtPriceX96) / Number(Q96)
  const a = Number(getSqrtRatioAtTick(tickLower)) / Number(Q96)
  const b = Number(getSqrtRatioAtTick(tickUpper)) / Number(Q96)
  if (!(p > 0)) throw new Error(t('zap.errNoPrice'))
  const spot1per0 = p * p // raw token1 per raw token0
  const spot = inIs0 ? spot1per0 : 1 / spot1per0
  if (p <= a) return { rho: inIs0 ? 0 : Infinity, spot } // band above price: token0 only
  if (p >= b) return { rho: inIs0 ? Infinity : 0, spot } // band below price: token1 only
  const amt0f = (b - p) / (b * p) // token0 a unit of liquidity holds
  const amt1f = p - a // token1 a unit of liquidity holds
  const rho1per0 = amt1f / amt0f
  return { rho: inIs0 ? rho1per0 : 1 / rho1per0, spot }
}

function solveSwap(amountIn: bigint, rho: number, rate: number): bigint {
  if (rho === 0) return 0n
  if (!Number.isFinite(rho)) return amountIn
  const A = Number(amountIn)
  const s = (A * rho) / (rate + rho)
  const sb = BigInt(Math.round(Math.min(Math.max(s, 0), A)))
  return sb > amountIn ? amountIn : sb
}

/**
 * Plan a zap. Throws Error with a human-readable reason when it can't
 * (no route, empty pool, dust amounts). Network: 1–2 kyber quotes.
 */
export async function planZap(args: {
  target: ZapTarget
  tokenIn: Address // NATIVE | pool.token0 | pool.token1
  amountIn: bigint
  signal?: AbortSignal
}): Promise<ZapPlan> {
  const { target, tokenIn, amountIn } = args
  const pool = poolOf(target)
  if (amountIn <= 0n) throw new Error(t('zap.errAmount'))
  const nativeIn = isNat(tokenIn)
  const erc20In = nativeIn ? ADDR.WETH : tokenIn
  const inIs0 = low(erc20In) === low(pool.token0)
  if (!inIs0 && low(erc20In) !== low(pool.token1)) throw new Error(t('zap.errNotInPool'))
  const otherErc20 = inIs0 ? pool.token1 : pool.token0

  const { rho, spot } = needAndSpot(target, inIs0)

  // --- solve the swap size (≤2 kyber quotes) ---
  let swapIn = solveSwap(amountIn, rho, spot)
  let route: KyberRouteData | null = null
  if (swapIn > 0n && swapIn * 1_000_000n < amountIn) swapIn = 0n // <0.0001% — not worth a tx
  if (amountIn - swapIn > 0n && (amountIn - swapIn) * 1_000_000n < amountIn) swapIn = amountIn
  if (swapIn > 0n) {
    route = await kyberRoute(erc20In, otherErc20, swapIn, { signal: args.signal })
    const q1 = Number(BigInt(route.routeSummary.amountOut)) / Number(swapIn)
    if (!(q1 > 0)) throw new Error(t('zap.errZeroQuote'))
    const s1 = solveSwap(amountIn, rho, q1)
    // re-quote only when the answer moved meaningfully (>0.4% of the input)
    const drift = s1 > swapIn ? s1 - swapIn : swapIn - s1
    if (drift * 250n > amountIn && s1 > 0n) {
      swapIn = s1
      route = await kyberRoute(erc20In, otherErc20, swapIn, { signal: args.signal })
    }
  }
  const estOut = route ? BigInt(route.routeSummary.amountOut) : 0n
  if (swapIn > 0n && estOut === 0n) throw new Error(t('zap.errNoRoute'))

  // --- planned deposit + dust estimate ---
  const keep = amountIn - swapIn
  const dep0 = inIs0 ? keep : estOut
  const dep1 = inIs0 ? estOut : keep
  let liquidity = 0n
  let dust0 = 0n
  let dust1 = 0n
  if (pool.kind === 'cl') {
    const { tickLower, tickUpper } = target as Extract<ZapTarget, { kind: 'cl-mint' | 'cl-increase' }>
    const sqrtA = getSqrtRatioAtTick(tickLower)
    const sqrtB = getSqrtRatioAtTick(tickUpper)
    liquidity = getLiquidityForAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, dep0, dep1)
    if (liquidity === 0n) throw new Error(t('zap.errTooSmall'))
    const pulled = getAmountsForLiquidity(pool.sqrtPriceX96, sqrtA, sqrtB, liquidity)
    dust0 = dep0 > pulled.amount0 ? dep0 - pulled.amount0 : 0n
    dust1 = dep1 > pulled.amount1 ? dep1 - pulled.amount1 : 0n
  } else {
    const v2 = pool as V2Pool
    if (dep0 > 0n && dep1 > 0n) {
      const need1 = (dep0 * v2.reserve1) / v2.reserve0
      if (need1 <= dep1) dust1 = dep1 - need1
      else dust0 = dep0 - (dep1 * v2.reserve0) / v2.reserve1
    }
  }

  // swap value lost to impact + lp fees, from kyber's own USD marks; the
  // configured platform fee (if any) is subtracted so it doesn't read as impact
  let impactBps: number | null = null
  const inUsd = Number(route?.routeSummary.amountInUsd ?? NaN)
  const outUsd = Number(route?.routeSummary.amountOutUsd ?? NaN)
  if (inUsd > 0 && outUsd > 0) impactBps = (1 - outUsd / inUsd) * 10_000 - ENV.kyberFeeBps

  return {
    tokenIn,
    nativeIn,
    erc20In,
    inIs0,
    amountIn,
    swapIn,
    keep,
    route,
    estOut,
    dep0,
    dep1,
    liquidity,
    dust0,
    dust1,
    impactBps,
    routeLabel: route ? routeLabelOf(route) : '',
  }
}

function routeLabelOf(r: KyberRouteData): string {
  const names = new Set<string>()
  for (const path of r.routeSummary.route ?? []) for (const h of path) names.add(h.exchange)
  return [...names].slice(0, 3).join(' · ')
}

// ---------------- stages ----------------

export type ZapStageKind = 'wrap' | 'approveIn' | 'swap' | 'approve0' | 'approve1' | 'deposit'
export type ZapStage = { kind: ZapStageKind; label: string }

const depositVerb = (tgt: ZapTarget): string =>
  tgt.kind === 'cl-increase'
    ? t('zap.stIncrease', { id: tgt.tokenId.toString() })
    : tgt.kind === 'cl-mint'
      ? t('zap.stMint')
      : t('zap.stAddLiquidity')

/** the exact tx sequence executeZap will run, for preview + progress UI */
export function zapStages(plan: ZapPlan, target: ZapTarget, t0: TokenInfo, t1: TokenInfo): ZapStage[] {
  const tIn = plan.inIs0 ? t0 : t1
  const tOut = plan.inIs0 ? t1 : t0
  const spender = target.kind === 'v2' ? t('zap.spenderRouter') : t('zap.spenderNpm')
  const stages: ZapStage[] = []
  if (plan.nativeIn) stages.push({ kind: 'wrap', label: t('zap.stWrap', { amt: fmtAmount(plan.amountIn, 18) }) })
  if (plan.swapIn > 0n) {
    stages.push({ kind: 'approveIn', label: t('zap.stApproveKyber', { sym: tIn.symbol }) })
    stages.push({
      kind: 'swap',
      label: t('zap.stSwap', {
        amt: fmtAmount(plan.swapIn, tIn.decimals),
        sym: tIn.symbol,
        out: fmtAmount(plan.estOut, tOut.decimals),
        outSym: tOut.symbol,
      }),
    })
  }
  if (plan.dep0 > 0n) stages.push({ kind: 'approve0', label: t('zap.stApproveSpender', { sym: t0.symbol, spender }) })
  if (plan.dep1 > 0n) stages.push({ kind: 'approve1', label: t('zap.stApproveSpender', { sym: t1.symbol, spender }) })
  stages.push({ kind: 'deposit', label: depositVerb(target) })
  return stages
}

// ---------------- executor ----------------

export type ZapRun = { ok: boolean; failedAt: number | null }

/**
 * Execute a planned zap step by step. Re-quotes the swap fresh (the plan's
 * quote is for preview) and deposits the amounts that ACTUALLY arrived, so a
 * stale plan can only halt the flow, never mis-spend. Halts (returns
 * failedAt) on the first failed/rejected tx or violated gate.
 */
export async function executeZap(args: {
  plan: ZapPlan
  target: ZapTarget
  user: Address
  slipBps: number // swap leg slippage
  t0: TokenInfo
  t1: TokenInfo
  onStage?: (i: number) => void
}): Promise<ZapRun> {
  const { plan, target, user, slipBps, t0, t1 } = args
  const pool = poolOf(target)
  const stages = zapStages(plan, target, t0, t1)
  const tIn = plan.inIs0 ? t0 : t1
  const otherErc20 = plan.inIs0 ? pool.token1 : pool.token0
  let i = 0
  const fail = (): ZapRun => ({ ok: false, failedAt: i })
  const abort = (msg: string): ZapRun => {
    txlog.push('err', t('zap.halt', { msg }))
    return fail()
  }

  let actualOut = 0n

  for (i = 0; i < stages.length; i++) {
    args.onStage?.(i)
    const st = stages[i]
    switch (st.kind) {
      case 'wrap': {
        const h = await step(st.label, () =>
          writeContract(wagmiConfig, {
            abi: wethAbi,
            address: ADDR.WETH,
            functionName: 'deposit',
            value: plan.amountIn,
            chainId: CHAIN_ID,
          }),
        )
        if (!h) return fail()
        break
      }
      case 'approveIn': {
        if (!(await ensureAllowance(plan.erc20In, user, ENV.kyberRouter, plan.swapIn, tIn.symbol))) return fail()
        break
      }
      case 'swap': {
        // fresh quote for the build; the plan's quote is preview-only
        let fresh
        try {
          fresh = await kyberRoute(plan.erc20In, otherErc20, plan.swapIn)
        } catch (e) {
          return abort(t('zap.haltRequote', { err: (e as Error).message }))
        }
        const freshOut = BigInt(fresh.routeSummary.amountOut)
        // price-move gate: the fresh route must still deliver ≈ the previewed
        // output (slippage + 0.5% grace) — otherwise stop and let the user re-look
        if (freshOut < applySlippage(plan.estOut, slipBps + 50)) {
          const dec = (plan.inIs0 ? t1 : t0).decimals
          return abort(
            t('zap.haltPriceMoved', { now: fmtAmount(freshOut, dec), prev: fmtAmount(plan.estOut, dec) }),
          )
        }
        // tokenOut identity gate: the route must pay out the pool's counter-token
        if (low(fresh.routeSummary.tokenOut) !== low(otherErc20)) {
          return abort(t('zap.haltTokenOut', { addr: fresh.routeSummary.tokenOut }))
        }
        let tx
        try {
          tx = await buildGatedKyberTx({
            routeSummary: fresh.routeSummary,
            sender: user,
            recipient: user,
            slippageBps: slipBps,
            amountIn: plan.swapIn,
            nativeIn: false, // zap always swaps the erc20 (ETH was wrapped in stage 0)
          })
        } catch (e) {
          return abort((e as Error).message)
        }
        // read what actually arrived (receipt Transfer logs) — deposits use this
        let got = 0n
        const h = await step(
          st.label + ' [KYBER]',
          () => sendTransaction(wagmiConfig, { to: tx.to, data: tx.data, value: tx.value, chainId: CHAIN_ID }),
          { onSuccess: (rcpt) => (got = receivedOf(rcpt, otherErc20, user)) },
        )
        if (!h) return fail()
        if (got === 0n) return abort(t('zap.haltNoTransfer'))
        actualOut = got
        break
      }
      case 'approve0':
      case 'approve1': {
        const is0 = st.kind === 'approve0'
        const token = is0 ? pool.token0 : pool.token1
        const sym = is0 ? t0.symbol : t1.symbol
        const amt = depositAmounts(plan, actualOut)[is0 ? 0 : 1]
        const spender =
          target.kind === 'v2'
            ? (pool as V2Pool).protocol === 'univ2'
              ? UNI.V2_ROUTER
              : ADDR.V2_ROUTER
            : target.kind === 'cl-increase'
              ? target.npm
              : (pool as ClPool).protocol === 'univ3'
                ? UNI.V3_NPM
                : ADDR.CL_PM
        if (amt > 0n && !(await ensureAllowance(token, user, spender, amt, sym))) return fail()
        break
      }
      case 'deposit': {
        const [dep0, dep1] = depositAmounts(plan, actualOut)
        if (dep0 === 0n && dep1 === 0n) return abort(t('zap.haltNothing'))
        const ok = await runDeposit(target, user, dep0, dep1, st.label, t0, t1)
        if (!ok) return fail()
        break
      }
    }
  }

  // zapped into an up33 pool with a live gauge → staking is the follow-up move
  if (pool.protocol === 'up33' && pool.gauge && pool.gaugeAlive && target.kind !== 'cl-increase') {
    txlog.push('info', t('zap.stakeHint'), undefined, {
      label: t('zap.stakeHintAction'),
      onClick: () => {
        location.hash = 'positions'
      },
    })
  }
  return { ok: true, failedAt: null }
}

/** post-swap deposit amounts: kept side exact, swapped side = what arrived */
function depositAmounts(plan: ZapPlan, actualOut: bigint): [bigint, bigint] {
  const out = plan.swapIn > 0n ? actualOut : 0n
  return plan.inIs0 ? [plan.keep, out] : [out, plan.keep]
}

async function runDeposit(
  target: ZapTarget,
  user: Address,
  dep0: bigint,
  dep1: bigint,
  label: string,
  t0: TokenInfo,
  t1: TokenInfo,
): Promise<boolean> {
  if (target.kind === 'v2') {
    const pool = target.pool
    if (pool.protocol === 'univ2') {
      // vanilla Router02 has no quote helper — compute the optimal pair from
      // fresh reserves so mins are honest and dust stays in the wallet
      const [r0, r1] = await readContract(wagmiConfig, {
        abi: uniV2PairAbi,
        address: pool.address,
        functionName: 'getReserves',
        chainId: CHAIN_ID,
      })
      let d0 = dep0
      let d1 = dep1
      if (r0 > 0n && r1 > 0n && dep0 > 0n && dep1 > 0n) {
        const need1 = (dep0 * r1) / r0
        if (need1 <= dep1) d1 = need1
        else d0 = (dep1 * r0) / r1
      }
      const h = await step(`${label} ${t0.symbol}/${t1.symbol} [uni v2]`, () =>
        writeContract(wagmiConfig, {
          abi: uniV2RouterAbi,
          address: UNI.V2_ROUTER,
          functionName: 'addLiquidity',
          args: [pool.token0, pool.token1, d0, d1, applySlippage(d0, MINS_BPS), applySlippage(d1, MINS_BPS), user, deadline()],
          chainId: CHAIN_ID,
        }),
      )
      return h !== null
    }
    const quote = await readContract(wagmiConfig, {
      abi: v2RouterAbi,
      address: ADDR.V2_ROUTER,
      functionName: 'quoteAddLiquidity',
      args: [pool.token0, pool.token1, pool.stable, ADDR.V2_FACTORY, dep0, dep1],
      chainId: CHAIN_ID,
    })
    const h = await step(`${label} ${t0.symbol}/${t1.symbol}`, () =>
      writeContract(wagmiConfig, {
        abi: v2RouterAbi,
        address: ADDR.V2_ROUTER,
        functionName: 'addLiquidity',
        args: [
          pool.token0,
          pool.token1,
          pool.stable,
          dep0,
          dep1,
          applySlippage(quote[0], MINS_BPS),
          applySlippage(quote[1], MINS_BPS),
          user,
          deadline(),
        ],
        chainId: CHAIN_ID,
      }),
    )
    return h !== null
  }

  // CL: fresh price + band-edge mins (see minAmountsForLiquidity) — 'PS'-safe
  const pool = target.pool
  const sqrtP = await fetchSqrtPriceX96(pool.address)
  const sqrtA = getSqrtRatioAtTick(target.tickLower)
  const sqrtB = getSqrtRatioAtTick(target.tickUpper)
  const liq = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, dep0, dep1)
  if (liq === 0n) {
    txlog.push('err', t('zap.halt', { msg: t('zap.haltDepositSmall') }))
    return false
  }
  const mins = minAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liq, MINS_BPS)

  if (target.kind === 'cl-increase') {
    const h = await step(`${label} (${t0.symbol}/${t1.symbol})`, () =>
      writeContract(wagmiConfig, {
        abi: clPmAbi,
        address: target.npm,
        functionName: 'increaseLiquidity',
        args: [
          {
            tokenId: target.tokenId,
            amount0Desired: dep0,
            amount1Desired: dep1,
            amount0Min: mins.amount0Min,
            amount1Min: mins.amount1Min,
            deadline: deadline(),
          },
        ],
        chainId: CHAIN_ID,
      }),
    )
    return h !== null
  }

  const common = {
    token0: pool.token0,
    token1: pool.token1,
    tickLower: target.tickLower,
    tickUpper: target.tickUpper,
    amount0Desired: dep0,
    amount1Desired: dep1,
    amount0Min: mins.amount0Min,
    amount1Min: mins.amount1Min,
    recipient: user,
    deadline: deadline(),
  }
  const h = await step(
    `${label} ${pool.protocol === 'univ3' ? 'v3' : 'CL'} ${t0.symbol}/${t1.symbol} [${target.tickLower},${target.tickUpper}]`,
    () =>
      pool.protocol === 'univ3'
        ? writeContract(wagmiConfig, {
            abi: uniV3PmAbi,
            address: UNI.V3_NPM,
            functionName: 'mint',
            args: [{ ...common, fee: pool.feePpm }],
            chainId: CHAIN_ID,
          })
        : writeContract(wagmiConfig, {
            abi: clPmAbi,
            address: ADDR.CL_PM,
            functionName: 'mint',
            args: [{ ...common, tickSpacing: pool.tickSpacing, sqrtPriceX96: 0n }],
            chainId: CHAIN_ID,
          }),
  )
  return h !== null
}
