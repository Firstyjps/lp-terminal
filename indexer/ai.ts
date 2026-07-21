// AI narrative for the ANALYZE tab — server-side only. The DeepSeek key never
// leaves this process: the public endpoint serves a cached completion, so
// visitors can neither prompt the model nor amplify API spend (≤ ~24 calls/day
// regardless of traffic). Metrics are fetched from DeFiLlama here, mirroring
// the frontend's derivations.
import { readFileSync } from 'node:fs'
import { log, now } from './config'

const TTL = 3_600 // regenerate at most hourly
const CHAIN = encodeURIComponent('Robinhood Chain')

/** repo-root .env / env `DEEPSEEK_API_KEY` (SECRET — never log/print it) */
function deepseekKey(): string | null {
  const env = process.env.DEEPSEEK_API_KEY?.trim()
  if (env) return env
  try {
    const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    const m = text.match(/^\s*DEEPSEEK_API_KEY\s*=\s*(\S+)\s*$/m)
    if (m) return m[1]
  } catch {
    /* no repo .env */
  }
  return null
}

export const aiEnabled = (): boolean => deepseekKey() !== null

export type AiInsight = { asof: number; model: string; en: string; zh: string }
let cache: AiInsight | null = null
let inflight: Promise<AiInsight> | null = null

async function getJson(url: string): Promise<any> {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`${url.split('/')[2]} ${r.status}`)
  return r.json()
}

type Series = [number, number][]
const sum = (s: Series, from: number, to?: number) => s.slice(from, to).reduce((a, p) => a + p[1], 0)

/** one DeepSeek chat completion; returns the assistant text (throws on error) */
export async function deepseekChat(
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
  opts?: { maxTokens?: number; temperature?: number; json?: boolean },
): Promise<string> {
  const key = deepseekKey()
  if (!key) throw new Error('no DEEPSEEK_API_KEY')
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      ...(opts?.json ? { response_format: { type: 'json_object' } } : {}),
      temperature: opts?.temperature ?? 0.4,
      max_tokens: opts?.maxTokens ?? 900,
    }),
  })
  if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json()
  const out = j.choices?.[0]?.message?.content
  if (typeof out !== 'string') throw new Error('deepseek: bad shape')
  return out
}

/** compact numeric picture of the chain for the prompt — no free text inside */
export async function metrics(): Promise<Record<string, unknown>> {
  const [tvl, dex, fees, stables] = await Promise.all([
    getJson(`https://api.llama.fi/v2/historicalChainTvl/${CHAIN}`),
    getJson(`https://api.llama.fi/overview/dexs/${CHAIN}?excludeTotalDataChart=false&excludeTotalDataChartBreakdown=false`),
    getJson(`https://api.llama.fi/overview/fees/${CHAIN}?excludeTotalDataChart=false`),
    getJson(`https://stablecoins.llama.fi/stablecoincharts/${CHAIN}`),
  ])
  const volC: Series = dex.totalDataChart ?? []
  const feeC: Series = fees.totalDataChart ?? []
  const tvlC: Series = (tvl as { date: number; tvl: number }[]).map((p) => [p.date, p.tvl])
  const stC: Series = (stables as any[]).map((p) => [Number(p.date), p.totalCirculatingUSD?.peggedUSD ?? 0])

  const wow = (s: Series) =>
    s.length >= 15 ? { cur: sum(s, -8, -1), prev: sum(s, -15, -8) } : null
  const last = (s: Series) => (s.length ? s[s.length - 1][1] : null)

  // 7d market share now vs prior week, top 6 by current share
  const shares: Record<string, { now: number; prev: number }> = {}
  const bd: [number, Record<string, number>][] = dex.totalDataChartBreakdown ?? []
  if (bd.length >= 15) {
    const acc = (from: number, to: number) => {
      const m: Record<string, number> = {}
      let tot = 0
      for (const [, by] of bd.slice(from, to))
        for (const [k, v] of Object.entries(by)) {
          m[k] = (m[k] ?? 0) + v
          tot += v
        }
      for (const k of Object.keys(m)) m[k] = (m[k] / tot) * 100
      return m
    }
    const cur = acc(-8, -1)
    const prev = acc(-15, -8)
    for (const k of Object.keys(cur).sort((a, b) => cur[b] - cur[a]).slice(0, 6))
      shares[k] = { now: Math.round(cur[k] * 10) / 10, prev: Math.round((prev[k] ?? 0) * 10) / 10 }
  }

  const meanTvl7 = tvlC.length >= 7 ? sum(tvlC, -7) / 7 : null
  const feesW = wow(feeC)
  return {
    chain: 'Robinhood Chain (chainId 4663, new Arbitrum-orbit L2 by Robinhood)',
    asofUtc: new Date().toISOString().slice(0, 16),
    chainAgeDays: tvlC.length,
    tvlUsd: last(tvlC),
    tvlUsd7dAgo: tvlC.length >= 8 ? tvlC[tvlC.length - 8][1] : null,
    stablecoinMcapUsd: last(stC),
    stablecoinMcap7dAgo: stC.length >= 8 ? stC[stC.length - 8][1] : null,
    dexVolume: { last24h: dex.total24h, wow: wow(volC) },
    fees: { last24h: fees.total24h, wow: feesW },
    feeAprPctAnnualized:
      feesW && meanTvl7 ? Math.round((feesW.cur / meanTvl7) * (365 / 7) * 1000) / 10 : null,
    dexShare7dPct: shares,
  }
}

const PROMPT = `You are the analytics brain of ALPHAST, a terminal-style LP (liquidity provider) dashboard for Robinhood Chain. From the metrics JSON, write a short market read for LPs.

Rules:
- exactly 4-6 lines per language, each line starts with "> ", separated by \\n
- terminal tone: lowercase, dense, numbers with units ($4.3b, +40%, 64bps), no emoji, no hype
- cover: momentum (volume/fees), what it means for LP yields, structural shifts (protocol share), and exactly one line on the main risk to watch
- ground every claim in the numbers given; do not invent data
- no advice verbs (buy/sell/should); describe, don't recommend
Return strict JSON: {"en": "...", "zh": "..."} — zh is the same content in natural simplified Chinese.`

async function generate(): Promise<AiInsight> {
  const key = deepseekKey()
  if (!key) throw new Error('no DEEPSEEK_API_KEY')
  const m = await metrics()
  const t0 = Date.now()
  const r = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: PROMPT },
        { role: 'user', content: JSON.stringify(m) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4,
      max_tokens: 900,
    }),
  })
  if (!r.ok) throw new Error(`deepseek ${r.status}: ${(await r.text()).slice(0, 120)}`)
  const j = await r.json()
  const out = JSON.parse(j.choices?.[0]?.message?.content ?? '{}')
  if (typeof out.en !== 'string' || typeof out.zh !== 'string') throw new Error('deepseek: bad shape')
  log(`[ai] insight regenerated (${Date.now() - t0}ms, ${j.usage?.total_tokens ?? '?'} tok)`)
  return { asof: now(), model: String(j.model ?? 'deepseek-chat'), en: out.en, zh: out.zh }
}

/** cached insight; serves the stale copy if a refresh attempt fails */
export async function aiInsight(): Promise<AiInsight> {
  if (cache && now() - cache.asof < TTL) return cache
  if (!inflight)
    inflight = generate()
      .then((r) => {
        cache = r
        return r
      })
      .finally(() => {
        inflight = null
      })
  try {
    return await inflight
  } catch (e) {
    if (cache) {
      log('[ai] refresh failed, serving stale:', String(e).slice(0, 120))
      return cache
    }
    throw e
  }
}
