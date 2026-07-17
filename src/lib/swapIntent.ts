// One-shot handoff "swap this next" — set after a claim confirms, consumed by
// the SWAP tab when it can resolve both tokens.
import type { Address } from 'viem'

export type SwapIntent = { tokenIn: Address; tokenOut: Address; amount: bigint }

let intent: SwapIntent | null = null

export function setSwapIntent(i: SwapIntent) {
  intent = i
}
export function peekSwapIntent(): SwapIntent | null {
  return intent
}
export function takeSwapIntent(): SwapIntent | null {
  const i = intent
  intent = null
  return i
}
