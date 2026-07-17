import type { Address, Hex } from 'viem'
import { ENV } from '../config/env'

/** KyberSwap sentinel for the chain's native token (ETH). */
export const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address

const HEADERS = { 'x-client-id': 'up33-terminal' }
const api = () => `${ENV.kyberBase}/${ENV.kyberChain}/api/v1`

export type KyberHop = {
  pool: string
  exchange: string
  poolType?: string
  tokenIn: string
  tokenOut: string
  swapAmount: string
  amountOut: string
}

export type KyberRouteSummary = {
  tokenIn: string
  tokenOut: string
  amountIn: string
  amountOut: string
  amountInUsd?: string
  amountOutUsd?: string
  gas?: string
  gasUsd?: string
  route: KyberHop[][]
  [k: string]: unknown
}

export type KyberRouteData = {
  routeSummary: KyberRouteSummary
  routerAddress: Address
}

export async function kyberRoute(
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  opts?: { signal?: AbortSignal; applyFee?: boolean },
): Promise<KyberRouteData> {
  // base arg makes path-relative bases (/kyber proxy mode) work — new URL()
  // throws on a bare relative path; the base is ignored for absolute URLs
  const u = new URL(`${api()}/routes`, location.origin)
  u.searchParams.set('tokenIn', tokenIn)
  u.searchParams.set('tokenOut', tokenOut)
  u.searchParams.set('amountIn', amountIn.toString())
  u.searchParams.set('gasInclude', 'true')
  // optional platform fee (charged on output token, encoded by the kyber router;
  // verified working on this chain — see README)
  if ((opts?.applyFee ?? true) && ENV.kyberFeeBps > 0 && ENV.kyberFeeReceiver) {
    u.searchParams.set('feeAmount', String(ENV.kyberFeeBps))
    u.searchParams.set('chargeFeeBy', 'currency_out')
    u.searchParams.set('isInBps', 'true')
    u.searchParams.set('feeReceiver', ENV.kyberFeeReceiver)
  }
  const r = await fetch(u, { headers: HEADERS, signal: opts?.signal })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j || j.code !== 0 || !j.data?.routeSummary) {
    throw new Error(`kyber routes failed: ${j?.message ?? r.status}`)
  }
  return j.data as KyberRouteData
}

export type KyberBuildData = {
  data: Hex
  routerAddress: Address
  amountIn: string
  amountOut: string
  transactionValue?: string
  [k: string]: unknown
}

export async function kyberBuild(
  routeSummary: KyberRouteSummary,
  sender: Address,
  recipient: Address,
  slippageBps: number,
): Promise<KyberBuildData> {
  const r = await fetch(`${api()}/route/build`, {
    method: 'POST',
    headers: { ...HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      routeSummary,
      sender,
      recipient,
      slippageTolerance: slippageBps,
      source: 'up33-terminal',
      enableGasEstimation: false,
    }),
  })
  const j = await r.json().catch(() => null)
  if (!r.ok || !j || j.code !== 0 || !j.data?.data) {
    throw new Error(`kyber build failed: ${j?.message ?? r.status}`)
  }
  return j.data as KyberBuildData
}

export type KyberToken = { address: Address; symbol: string; decimals: number; name?: string }

/** Registered token list for chainId 4663 from ks-setting (seed for the picker). */
export async function kyberTokenList(): Promise<KyberToken[]> {
  const base = ENV.proxied ? '/kyber-setting' : 'https://ks-setting.kyberswap.com'
  const out: KyberToken[] = []
  for (let page = 1; page <= 3; page++) {
    const r = await fetch(`${base}/api/v1/tokens?chainIds=4663&pageSize=100&page=${page}`)
    const j = await r.json().catch(() => null)
    const toks: any[] = j?.data?.tokens ?? []
    for (const t of toks) {
      if (t?.address && t?.symbol && Number.isFinite(t?.decimals)) {
        out.push({ address: t.address as Address, symbol: t.symbol, decimals: t.decimals })
      }
    }
    if (toks.length < 100) break
  }
  return out
}

/** flatten route into "55% up-v3 · 45% uniswapv3" style breakdown */
export function routeBreakdown(rs: KyberRouteSummary): string {
  const amountIn = BigInt(rs.amountIn || '0')
  if (amountIn === 0n || !rs.route?.length) return ''
  const parts: string[] = []
  for (const path of rs.route) {
    if (!path.length) continue
    const first = path[0]
    const pctNum = Number((BigInt(first.swapAmount || '0') * 1000n) / amountIn) / 10
    const names = [...new Set(path.map((h) => h.exchange))].join('→')
    parts.push(`${pctNum}% ${names}`)
  }
  return parts.join(' · ')
}
