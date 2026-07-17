// Gated Kyber execution: the ONLY path that turns a kyber route into a
// sendable transaction. Kyber calldata is opaque, so every build passes the
// same safety gates regardless of caller (SWAP tab, ZAP):
//   1. router whitelist — calldata goes to ENV.kyberRouter or nowhere
//   2. tx value sanity  — native value exactly amountIn for ETH, else 0
//   3. build-vs-quote drift — built output must beat quote minus slippage
//   4. amountIn integrity — built tx must spend exactly what was quoted
// (a 5th, tokenOut identity, is asserted where the caller knows the pair)
import { getAddress, type Address, type Hex } from 'viem'
import { ENV } from '../config/env'
import { t } from '../i18n'
import { applySlippage } from './clmath'
import { kyberBuild, type KyberRouteSummary } from './kyber'

export type GatedKyberTx = { to: Address; data: Hex; value: bigint }

/**
 * Build a kyber swap tx and run the safety gates. Throws Error with a
 * human-readable reason on any gate failure — callers txlog it and abort.
 */
export async function buildGatedKyberTx(args: {
  routeSummary: KyberRouteSummary
  sender: Address
  recipient: Address
  slippageBps: number
  /** the exact amount the caller intends to spend (must match the quote) */
  amountIn: bigint
  /** true when the input is native ETH (tx carries value) */
  nativeIn: boolean
}): Promise<GatedKyberTx> {
  const built = await kyberBuild(args.routeSummary, args.sender, args.recipient, args.slippageBps)
  if (getAddress(built.routerAddress) !== ENV.kyberRouter) {
    throw new Error(t('kyber.routerMismatch', { addr: built.routerAddress }))
  }
  const value = BigInt(built.transactionValue ?? '0')
  const expected = args.nativeIn ? args.amountIn : 0n
  if (value !== expected) {
    throw new Error(t('kyber.badValue', { got: value.toString(), want: expected.toString() }))
  }
  const quotedOut = BigInt(args.routeSummary.amountOut)
  if (
    BigInt(built.amountIn) !== args.amountIn ||
    BigInt(built.amountOut) < applySlippage(quotedOut, args.slippageBps)
  ) {
    throw new Error(t('kyber.buildDeviates', { in: built.amountIn, out: built.amountOut }))
  }
  return { to: ENV.kyberRouter, data: built.data, value }
}
