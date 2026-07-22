// GMGN token-security gate — is_honeypot / unsafe alert / buy+sell tax,
// straight from GMGN's OpenAPI. This catches the failure mode our fake-TVL
// trust layer can't see: a CONTRACT trap (can buy, can't sell) sitting in a
// pool with perfectly real liquidity.
//
// Auth: read endpoints need only X-APIKEY + timestamp/client_id query params
// (verified against openapi.gmgn.ai 2026-07-22 — Ed25519 signing is required
// only for trade/portfolio calls, which this codebase will never make).
// Key: GMGN_API_KEY in .env — absent = every verdict is null ("unknown"),
// nothing is ever blocked on missing data.
import { randomUUID } from 'node:crypto'
import { envVal, log, now, sleep } from './config'
import { tokenSecurityRow, upsertTokenSecurity, type TokenSecurityRow } from './store'

const BASE = 'https://openapi.gmgn.ai'
const TTL_SECS = 6 * 3_600 // GMGN re-evaluates tokens; refresh stale verdicts
const NEG_TTL_SECS = 1_800 // api-miss rows retry sooner

const apiKey = (): string | null => envVal('GMGN_API_KEY')
export const gmgnEnabled = (): boolean => apiKey() !== null

const asFlag = (...vals: unknown[]): number | null => {
  for (const v of vals) {
    if (v === true || v === 1 || v === '1') return 1
    if (v === false || v === 0 || v === '0') return 0
  }
  return null
}
const asNum = (v: unknown): number | null => {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

async function fetchSecurity(addr: string): Promise<Omit<TokenSecurityRow, 'updated'> | null> {
  const key = apiKey()
  if (!key) return null
  const qs = new URLSearchParams({
    chain: 'robinhood',
    address: addr,
    timestamp: String(now()),
    client_id: randomUUID(),
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${BASE}/v1/token/security?${qs}`, {
        headers: { 'X-APIKEY': key, 'content-type': 'application/json', 'user-agent': 'alphast-indexer/0.1' },
        signal: AbortSignal.timeout(12_000),
      })
      if (r.status === 429) {
        await sleep(2_500 * (attempt + 1))
        continue
      }
      if (!r.ok) return null
      const j = (await r.json()) as { code?: number; data?: Record<string, unknown> }
      if (j.code !== 0 || !j.data) return null
      const d = j.data
      return {
        address: addr,
        honeypot: asFlag(d.is_honeypot, d.honeypot),
        alert: asFlag(d.is_show_alert),
        sell_tax: asNum(d.sell_tax),
        buy_tax: asNum(d.buy_tax),
        open_source: asFlag(d.is_open_source, d.open_source),
        renounced: asFlag(d.is_renounced, d.renounced),
        top10_rate: asNum(d.top_10_holder_rate),
      }
    } catch {
      await sleep(1_000)
    }
  }
  return null
}

// single-flight refresh queue — VOL opens and dip scans both funnel through
// here; GMGN gets at most one security call in flight, gently paced
const pending = new Set<string>()
let draining = false

async function drain(): Promise<void> {
  if (draining) return
  draining = true
  try {
    while (pending.size) {
      const [addr] = pending
      pending.delete(addr)
      const sec = await fetchSecurity(addr)
      if (sec) upsertTokenSecurity(sec, now())
      else {
        // negative-cache the miss so a dead API doesn't loop the queue
        const empty = tokenSecurityRow(addr)
        if (!empty)
          upsertTokenSecurity(
            { address: addr, honeypot: null, alert: null, sell_tax: null, buy_tax: null, open_source: null, renounced: null, top10_rate: null },
            now() - TTL_SECS + NEG_TTL_SECS,
          )
      }
      await sleep(600)
    }
  } catch (e) {
    log('[gmgn] drain error:', String(e).slice(0, 120))
  } finally {
    draining = false
  }
}

/** cached verdict (may be stale/null); queues a background refresh when due */
export function securityOf(addr: string): TokenSecurityRow | null {
  addr = addr.toLowerCase()
  const row = tokenSecurityRow(addr)
  if (gmgnEnabled() && (!row || now() - row.updated > TTL_SECS)) {
    pending.add(addr)
    void drain()
  }
  return row ?? null
}

/** true only on a POSITIVE honeypot/alert verdict — unknown never blocks */
export const isUnsafe = (row: TokenSecurityRow | null): boolean =>
  row !== null && (row.honeypot === 1 || row.alert === 1 || (row.sell_tax !== null && row.sell_tax >= 50))

/** wait (bounded) for fresh verdicts on a small set — dip alerts use this */
export async function ensureSecurity(addrs: string[], maxWaitMs = 20_000): Promise<void> {
  if (!gmgnEnabled()) return
  for (const a of addrs) securityOf(a)
  const t0 = Date.now()
  while (pending.size && Date.now() - t0 < maxWaitMs) await sleep(300)
}
