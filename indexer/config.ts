// Indexer constants + tuning. Contract addresses come from the shared frontend
// config — src/config/addresses.ts and src/abi are pure modules and load fine
// under node/tsx. src/config/env.ts does NOT (import.meta.env is vite-only),
// which is why the public RPC is duplicated here instead of imported.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export { ADDR, UNI } from '../src/config/addresses'

export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'
export const BLOCKSCOUT = 'https://robinhoodchain.blockscout.com'
export const GT = 'https://api.geckoterminal.com/api/v2'

export const PORT = Number(process.env.INDEXER_PORT || 8787)
export const DB_PATH =
  process.env.INDEXER_DB || fileURLToPath(new URL('./data/index.db', import.meta.url))

export const TUNE = {
  watchMs: 60_000, // position watcher cycle (WATCH_ADDRESSES)
  watchSnapMs: 300_000, // min gap between stored position snapshots
  watchSnapKeepDays: 120, // snapshot retention
  tailMs: 10_000, // factory tail + v2 allPairsLength poll
  hotSweepMs: 60_000, // state refresh for hot pools
  fullSweepMs: 3_600_000, // state refresh for ACTIVE pools (≥$100 TVL or <48h old)
  censusMs: 21_600_000, // 6h full-catalog dust census (~114k pools and growing)
  statsMs: 300_000, // GeckoTerminal enrichment cycle
  gtPaceMs: 2_600, // ≥2.6s between GT calls (free tier: 30/min)
  batch: 400, // calls per multicall aggregate
  batchGapMs: 40, // pause between aggregates (gentle on the RPC)
  hotTvlUsd: 10_000, // pools at/above this TVL refresh every hotSweepMs
  minDepthUsd: 300, // min priced-side USD depth to propagate a price through a pool
  susRatio: 20, // a pool side worth > susRatio × its token's price trust marks the pool sus
  gtFreshSecs: 1_800, // GT prices younger than this are never overwritten by propagation
}

/** process.env KEY, else repo-root .env KEY (values may be SECRET — never log/print) */
export function envVal(key: string): string | null {
  const env = process.env[key]?.trim()
  if (env) return env
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const m = text.match(new RegExp(`^\\s*${key}\\s*=\\s*(\\S+)\\s*$`, 'm'))
    if (m) return m[1]
  } catch {
    /* no repo .env */
  }
  return null
}

/** repo-root .env `RPC` (SECRET — never log/print it). Fallback: key-free public RPC. */
export const rpcUrl = (): string => envVal('RPC') ?? PUBLIC_RPC

export const now = () => Math.floor(Date.now() / 1000)

/** terminal-style timestamped log line */
export const log = (...a: unknown[]) =>
  console.log(new Date().toISOString().slice(11, 19), ...a)

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
