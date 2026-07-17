import { readContract, waitForTransactionReceipt } from 'wagmi/actions'
import type { Address, Hex, TransactionReceipt } from 'viem'
import { erc20Abi, parseAbi, parseEventLogs } from 'viem'
import { writeContract } from 'wagmi/actions'
import { wagmiConfig } from '../config/wagmi'
import { queryClient } from '../config/query'
import { ADDR, CHAIN_ID } from '../config/addresses'
import { t } from '../i18n'
import { fmtAmount } from './format'
import { NATIVE } from './kyber'
import { setSwapIntent } from './swapIntent'
import { txlog } from './txlog'

// Slipstream periphery's abbreviated revert reasons, translated for humans
// (hints resolve lazily so they follow the active language at error time)
const REVERT_HINTS: [RegExp, () => string][] = [
  [/Return amount is not enough/i, () => t('tx.hintKyberMinOut')],
  [/reason:\s*PS\b/, () => t('tx.hintPS')],
  [/INSUFFICIENT_[AB]_AMOUNT/, () => t('tx.hintV2Ratio')],
  [/reason:\s*STF\b/, () => t('tx.hintSTF')],
  [/reason:\s*NP\b/, () => t('tx.hintNP')],
  [/Transaction too old/i, () => t('tx.hintDeadline')],
]

function shortErr(e: unknown): string {
  const anyE = e as any
  const m: string = anyE?.shortMessage ?? anyE?.message ?? String(e)
  const first = m.split('\n')[0]
  const base = first.length > 110 ? first.slice(0, 110) + '…' : first
  for (const [re, hint] of REVERT_HINTS) if (re.test(first)) return `${base} → ${hint()}`
  return base
}

// slot0's leading (sqrtPriceX96, tick) is shared by Slipstream (6-word) and
// Uniswap v3 (7-word, extra feeProtocol) pools; decoding only the prefix keeps
// this one helper valid for both — viem ignores the trailing words.
const slot0PrefixAbi = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick)',
])

/** live pool price for slippage math — never trust the cached pools query for mins */
export async function fetchSqrtPriceX96(pool: Address): Promise<bigint> {
  const s0 = await readContract(wagmiConfig, {
    abi: slot0PrefixAbi,
    address: pool,
    functionName: 'slot0',
    chainId: CHAIN_ID,
  })
  return s0[0]
}

export function invalidateAll() {
  void queryClient.invalidateQueries()
}

/**
 * Run one transaction step: wallet prompt -> pending -> receipt.
 * Returns the tx hash on success, null on rejection/revert (callers should stop a
 * multi-step flow on null). opts.onSuccess sees the confirmed receipt.
 */
export async function step(
  label: string,
  send: () => Promise<Hex>,
  opts?: { onSuccess?: (rcpt: TransactionReceipt) => void },
): Promise<Hex | null> {
  const id = txlog.push('pending', t('tx.confirm', { label }))
  try {
    const hash = await send()
    txlog.update(id, { text: t('tx.pending', { label }), hash })
    const rcpt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: CHAIN_ID })
    if (rcpt.status !== 'success') {
      txlog.update(id, { kind: 'err', text: t('tx.reverted', { label }), hash })
      invalidateAll()
      return null
    }
    txlog.update(id, { kind: 'ok', text: t('tx.ok', { label, n: rcpt.blockNumber.toString() }), hash })
    invalidateAll()
    try {
      opts?.onSuccess?.(rcpt)
    } catch {
      /* follow-up is best-effort */
    }
    return hash
  } catch (e) {
    txlog.update(id, { kind: 'err', text: `${label} — ${shortErr(e)}` })
    invalidateAll()
    return null
  }
}

/** total of `token` delivered to `to` in a receipt's Transfer logs — the
 *  ground truth for "how much did I actually receive" after a swap/claim */
export function receivedOf(rcpt: TransactionReceipt, token: Address, to: Address): bigint {
  const transfers = parseEventLogs({ abi: erc20Abi, logs: rcpt.logs, eventName: 'Transfer' })
  let total = 0n
  for (const t of transfers) {
    if (t.address.toLowerCase() === token.toLowerCase() && t.args.to?.toLowerCase() === to.toLowerCase()) {
      total += t.args.value ?? 0n
    }
  }
  return total
}

/**
 * Post-claim follow-up: read how much UP actually landed in the wallet from the
 * receipt's Transfer logs and offer a one-click "swap it to ETH" that jumps to
 * the SWAP tab prefilled with the exact claimed amount.
 */
export function offerSwapClaimedUp(user: Address) {
  return (rcpt: TransactionReceipt) => {
    const total = receivedOf(rcpt, ADDR.UP, user)
    if (total === 0n) return
    txlog.push('info', t('tx.received', { amt: fmtAmount(total, 18) }), rcpt.transactionHash, {
      label: t('tx.swapToEth'),
      onClick: () => {
        setSwapIntent({ tokenIn: ADDR.UP, tokenOut: NATIVE, amount: total })
        location.hash = 'swap'
      },
    })
  }
}

/** Approve `spender` for exactly `amount` if current allowance is lower. */
export async function ensureAllowance(
  token: Address,
  owner: Address,
  spender: Address,
  amount: bigint,
  symbol: string,
): Promise<boolean> {
  const current = await readContract(wagmiConfig, {
    abi: erc20Abi,
    address: token,
    functionName: 'allowance',
    args: [owner, spender],
    chainId: CHAIN_ID,
  })
  if (current >= amount) return true
  const h = await step(t('tx.approve', { sym: symbol }), () =>
    writeContract(wagmiConfig, {
      abi: erc20Abi,
      address: token,
      functionName: 'approve',
      args: [spender, amount],
      chainId: CHAIN_ID,
    }),
  )
  return h !== null
}

export function deadline(secondsFromNow = 1200): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + secondsFromNow)
}
