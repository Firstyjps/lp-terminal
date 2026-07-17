// Range orders ("sell via LP"): a one-sided CL position parked strictly beyond
// the current price. As the market trades through the band, the deposit
// converts into the other token; fully crossed = fully sold, plus swap fees.
// NOT a resting order: if price retreats back through the band it un-fills,
// and nothing executes automatically — the owner withdraws to lock in.
//
// Closed forms for liquidity L over sqrt bounds [A,B] (verified against
// CLPool/SqrtPriceMath):
//   all-token0 amount = L·(1/A − 1/B)   (price at/below A)
//   all-token1 amount = L·(B − A)       (price at/above B)
//   ⇒ full-fill average price (token1 per token0) = A·B — geometric mean of bounds
import { parseAbi, parseEventLogs, type Address, type TransactionReceipt } from 'viem'
import { ADDR } from '../config/addresses'

export type LimitSide = 'sell0' | 'sell1'

/** selling token0 fills as token1/token0 price RISES (band above the market);
 *  selling token1 fills as it FALLS (band below) */
export function limitSideFor(pool: { token0: Address }, sell: Address): LimitSide {
  return sell.toLowerCase() === pool.token0.toLowerCase() ? 'sell0' : 'sell1'
}

/** fraction of the sell amount converted so far, 0..1 (display only) */
export function limitFillFrac(side: LimitSide, sqrtP: bigint, sqrtA: bigint, sqrtB: bigint): number {
  const P = Number(sqrtP)
  const A = Number(sqrtA)
  const B = Number(sqrtB)
  if (side === 'sell0') {
    // token0 remaining ∝ 1/√P − 1/√B
    if (P <= A) return 0
    if (P >= B) return 1
    return (1 / A - 1 / P) / (1 / A - 1 / B)
  }
  if (P >= B) return 0
  if (P <= A) return 1
  return (B - P) / (B - A)
}

// ---- local bookkeeping: tokenId -> order intent (this frontend only) ----

export type LimitTag = {
  sell: Address
  buy: Address
  sellSym: string
  buySym: string
  amountIn: string // raw units of the sell token
  pool: Address
  ts: number
}

const KEY = 'up33.limitOrders.v1'

function load(): Record<string, LimitTag> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, LimitTag>
  } catch {
    return {}
  }
}
function save(m: Record<string, LimitTag>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(m))
  } catch {
    /* storage unavailable — tags are cosmetic */
  }
}

export function tagLimit(tokenId: bigint, tag: LimitTag) {
  const m = load()
  m[tokenId.toString()] = tag
  save(m)
}
export function limitTagOf(tokenId: bigint): LimitTag | null {
  return load()[tokenId.toString()] ?? null
}
export function untagLimit(tokenId: bigint) {
  const m = load()
  if (m[tokenId.toString()]) {
    delete m[tokenId.toString()]
    save(m)
  }
}

const erc721TransferAbi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
])

/** tokenId freshly minted to `user` by the CL position manager in this receipt */
export function mintedTokenId(rcpt: TransactionReceipt, user: Address): bigint | null {
  const logs = parseEventLogs({ abi: erc721TransferAbi, logs: rcpt.logs, eventName: 'Transfer' })
  for (const l of logs) {
    if (
      l.address.toLowerCase() === ADDR.CL_PM.toLowerCase() &&
      l.args.from === '0x0000000000000000000000000000000000000000' &&
      l.args.to?.toLowerCase() === user.toLowerCase()
    ) {
      return l.args.tokenId ?? null
    }
  }
  return null
}
