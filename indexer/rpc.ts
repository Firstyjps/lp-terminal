import { createPublicClient, defineChain, http, type PublicClient } from 'viem'
import { log, PUBLIC_RPC, TUNE, rpcUrl, sleep } from './config'

// duplicated from src/config/chain.ts — that module imports src/config/env.ts
// (import.meta.env, vite-only) so it can't be loaded under node
const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  contracts: { multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' } },
})

const url = rpcUrl()
export const usingPrivateRpc = url !== PUBLIC_RPC
// timeout is deliberately tight: a healthy 400-call aggregate answers in 2-4s
// (measured 2026-07-16); a stalled attempt should fail fast and retry, not
// pin the whole boot for 30s. Bad chunks degrade to sub-chunks in mc().
export const pc: PublicClient = createPublicClient({
  chain: robinhood,
  transport: http(url, { timeout: 10_000, retryCount: 2, retryDelay: 400 }),
})

/** error text safe to log — the RPC url (secret) is redacted */
const redact = (e: unknown) =>
  String(e instanceof Error ? `${e.name}: ${e.message.split('\n')[0]}` : e)
    .replaceAll(url, '<rpc>')
    .slice(0, 120)

// loose call shape — abi fragments come from parseAbi, results are narrowed by ok<T>()
export type Call = { abi: unknown; address: `0x${string}`; functionName: string; args?: unknown[] }
export type McRes = { status: 'success' | 'failure'; result?: unknown }

const agg = async (chunk: Call[]): Promise<McRes[]> =>
  (await pc.multicall({ contracts: chunk as never, batchSize: 250_000 })) as McRes[]

/**
 * Chunked multicall: fixed TUNE.batch calls per aggregate3 (batchSize is set
 * high so viem never sub-chunks by calldata bytes), allowFailure semantics,
 * gentle pacing between chunks. A failing chunk is retried once, then split
 * into 100-call sub-chunks so one bad call can only take 100 results down
 * with it — mc() never throws, it returns per-call failures instead.
 */
export async function mc(calls: Call[]): Promise<McRes[]> {
  const out: McRes[] = []
  for (let i = 0; i < calls.length; i += TUNE.batch) {
    const chunk = calls.slice(i, i + TUNE.batch)
    const t0 = Date.now()
    try {
      out.push(...(await agg(chunk)))
    } catch (e) {
      log('[rpc] chunk failed, retrying:', redact(e))
      await sleep(600)
      try {
        out.push(...(await agg(chunk)))
      } catch {
        for (let j = 0; j < chunk.length; j += 100) {
          const part = chunk.slice(j, j + 100)
          try {
            out.push(...(await agg(part)))
          } catch (e2) {
            log(`[rpc] dropped ${part.length}-call sub-chunk:`, redact(e2))
            out.push(...part.map(() => ({ status: 'failure' as const })))
          }
        }
      }
    }
    const ms = Date.now() - t0
    if (ms > 8_000) log(`[rpc] slow chunk: ${ms}ms (${chunk.length} calls)`)
    if (i + TUNE.batch < calls.length) await sleep(TUNE.batchGapMs)
  }
  return out
}

export const ok = <T,>(r?: McRes): T | undefined =>
  r && r.status === 'success' ? (r.result as T) : undefined
