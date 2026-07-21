// Telegram Q&A — makes the alert bot conversational. Long-polls getUpdates and
// answers free-text questions with DeepSeek, grounded in live indexer data
// (watched positions, top pools, DeFiLlama chain metrics). Server-side only:
// both keys stay in this process, and ONLY the whitelisted TELEGRAM_CHAT_ID is
// answered — strangers who find the bot get silence, so they can't spend a
// single model token. Run one polling instance at a time (getUpdates is an
// exclusive consumer) — in practice: the VPS indexer, which is the only one
// with the telegram env set.
import { aiEnabled, deepseekChat, metrics } from './ai'
import { envVal, log, now, sleep } from './config'
import { db, kvGet, kvSet, tokenRows, watchPosByOwner } from './store'
import { watchAddrs } from './watch'

const LLM_PER_HOUR = 40 // spend ceiling, generous for one human
const HISTORY_MAX = 12 // kept turns per chat (LLM context)

const token = () => envVal('TELEGRAM_BOT_TOKEN')
const chatId = () => envVal('TELEGRAM_CHAT_ID')
const api = () => `https://api.telegram.org/bot${token()}`

export const tgBotEnabled = (): boolean => token() !== null && chatId() !== null && aiEnabled()

// ---- data context ----

const short = (a: string) => a.slice(0, 6) + '…'

function symbolMap(addrs: string[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const r of tokenRows(addrs)) if (r.meta_ok) m.set(r.address, r.symbol)
  return m
}

function positionsCtx(): unknown[] {
  const rows = watchAddrs().flatMap((o) => watchPosByOwner(o))
  const syms = symbolMap(rows.flatMap((r) => [r.token0 ?? '', r.token1 ?? '']).filter(Boolean))
  const sym = (a: string | null) => (a ? (syms.get(a) ?? short(a)) : '?')
  return rows.map((r) => ({
    pair: `${sym(r.token0)}/${sym(r.token1)}`,
    id: r.token_id,
    protocol: r.npm,
    staked: r.staked === 1,
    closed: r.closed === 1,
    inRange: r.in_range === null ? null : r.in_range === 1,
    valueUsd: r.value_usd,
    pendingFeesOrRewardsUsd: r.fees_usd,
    collectedUsdSinceTracking: r.collected_usd,
    trackedDays: Math.round((now() - r.first_ts) / 8_640) / 10,
    valueUsdWhenFirstTracked: r.first_value_usd,
    outOfRangeSince: r.out_since,
  }))
}

function poolsCtx(): unknown[] {
  const rows = db
    .prepare(
      `SELECT p.address, p.proto, p.token0, p.token1, p.fee_ppm,
              s.tvl_usd, st.vol24h_usd
       FROM pools p JOIN pool_state s ON s.address = p.address
       LEFT JOIN pool_stats st ON st.address = p.address
       WHERE s.tvl_usd >= 10000 AND s.tvl_sus = 0
       ORDER BY (st.vol24h_usd IS NULL), st.vol24h_usd DESC, s.tvl_usd DESC LIMIT 12`,
    )
    .all() as { address: string; proto: string; token0: string; token1: string; fee_ppm: number; tvl_usd: number; vol24h_usd: number | null }[]
  const syms = symbolMap(rows.flatMap((r) => [r.token0, r.token1]))
  return rows.map((r) => ({
    pair: `${syms.get(r.token0) ?? short(r.token0)}/${syms.get(r.token1) ?? short(r.token1)}`,
    proto: r.proto,
    feePct: r.fee_ppm / 10_000,
    tvlUsd: Math.round(r.tvl_usd),
    vol24hUsd: r.vol24h_usd === null ? null : Math.round(r.vol24h_usd),
  }))
}

// DeFiLlama metrics cached 5 min so chat doesn't hammer their API
let metricsCache: { t: number; data: Record<string, unknown> } | null = null
async function chainCtx(): Promise<Record<string, unknown> | { error: string }> {
  if (metricsCache && now() - metricsCache.t < 300) return metricsCache.data
  try {
    const data = await metrics()
    metricsCache = { t: now(), data }
    return data
  } catch (e) {
    return { error: `chain metrics unavailable: ${String(e).slice(0, 80)}` }
  }
}

const SYSTEM = `You are the assistant living inside ALPHAST (https://alphast.xyz) — a terminal-style LP dashboard for Robinhood Chain (chainId 4663, Arbitrum-orbit L2 by Robinhood), covering the UP33 ve(3,3) DEX and Uniswap v2/v3. You chat with the dashboard's owner on Telegram.

Rules:
- Answer in the language the user writes (Thai in -> Thai out, casual but precise).
- The DATA json in the last system message is LIVE from the indexer: the owner's LP positions, top pools by 24h volume, and chain-level metrics. Ground every number in it; if something isn't in the data, say so instead of inventing.
- Positions marked staked earn UP emissions while in range; unstaked earn swap fees. Out-of-range earns nothing — the web UI has a RE-RANGE button for that.
- Things the web UI can do (point the owner there for actions — you cannot transact): view positions & PnL, RE-RANGE, collect fees, stake/unstake, add/remove liquidity, zap single-token, swap, limit orders, ANALYZE tab with charts.
- Be concise (Telegram): short paragraphs or tight bullet lines, numbers with units ($, %, UP). PLAIN TEXT ONLY — no markdown of any kind (no **bold**, no #headers, no tables; asterisks render literally in Telegram). Use "-" bullets and line breaks.
- Describe and explain; never use advice verbs like buy/sell/should for financial decisions.`

// ---- per-chat LLM history + rate limit (in-memory) ----
const history: { role: 'user' | 'assistant'; content: string }[] = []
let llmTimes: number[] = []

const rateOk = (): boolean => {
  const cutoff = now() - 3_600
  llmTimes = llmTimes.filter((t) => t > cutoff)
  return llmTimes.length < LLM_PER_HOUR
}

/** answer a free-text question (exported for offline testing) */
export async function answerText(text: string): Promise<string> {
  const data = {
    nowUtc: new Date().toISOString().slice(0, 16),
    myPositions: positionsCtx(),
    topPoolsBy24hVolume: poolsCtx(),
    chain: await chainCtx(),
  }
  llmTimes.push(now())
  const out = await deepseekChat(
    [
      { role: 'system', content: SYSTEM },
      ...history,
      { role: 'system', content: `DATA ${JSON.stringify(data)}` },
      { role: 'user', content: text },
    ],
    { maxTokens: 700, temperature: 0.5 },
  )
  history.push({ role: 'user', content: text }, { role: 'assistant', content: out })
  while (history.length > HISTORY_MAX) history.shift()
  return out
}

/** instant /status summary — no model call */
function statusText(): string {
  const rows = watchAddrs()
    .flatMap((o) => watchPosByOwner(o))
    .filter((r) => r.closed === 0)
  if (!rows.length) return 'no tracked positions'
  const syms = symbolMap(rows.flatMap((r) => [r.token0 ?? '', r.token1 ?? '']).filter(Boolean))
  const usd = (n: number | null) => (n === null ? '?' : `$${n >= 100 ? Math.round(n) : n.toFixed(2)}`)
  const lines = rows.map((r) => {
    const pair = `${syms.get(r.token0 ?? '') ?? '?'}/${syms.get(r.token1 ?? '') ?? '?'}`
    const state = r.in_range === 1 ? '🟢' : r.in_range === 0 ? '🔴 OUT' : '·'
    return `${state} ${pair} #${r.token_id}${r.staked ? ' (staked)' : ''} · ${usd(r.value_usd)} · pending ${usd(r.fees_usd)}`
  })
  const total = rows.reduce((a, r) => a + (r.value_usd ?? 0), 0)
  const pend = rows.reduce((a, r) => a + (r.fees_usd ?? 0), 0)
  return `${lines.join('\n')}\n— total ${usd(total)} · pending ${usd(pend)}`
}

const HELP = `alphast bot — alerts + Q&A
/status — positions snapshot (instant)
/clear — forget chat history
anything else — ask the AI (positions, pools, chain, LP concepts)
alerts fire on range exits, big pending fees, and position changes.`

// ---- telegram plumbing ----

async function send(chat: string | number, text: string): Promise<void> {
  // telegram hard-caps messages at 4096 chars
  for (let i = 0; i < text.length; i += 4000) {
    const r = await fetch(`${api()}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(i, i + 4000), disable_web_page_preview: true }),
    })
    if (!r.ok) log('[tg] send failed:', r.status, (await r.text()).slice(0, 120))
  }
}

async function handleUpdate(u: { message?: { text?: string; chat: { id: number } } }): Promise<void> {
  const msg = u.message
  if (!msg?.text) return
  // whitelist: silence for anyone but the owner — no reply, no model spend
  if (String(msg.chat.id) !== chatId()) return
  const text = msg.text.trim()

  if (text === '/start' || text === '/help') return send(msg.chat.id, HELP)
  if (text === '/clear') {
    history.length = 0
    return send(msg.chat.id, 'history cleared')
  }
  if (text === '/status') return send(msg.chat.id, statusText())

  if (!rateOk()) return send(msg.chat.id, `rate limit: ${LLM_PER_HOUR} questions/hour — try again soon`)
  await fetch(`${api()}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: msg.chat.id, action: 'typing' }),
  }).catch(() => {})
  try {
    await send(msg.chat.id, await answerText(text))
  } catch (e) {
    log('[tg] answer failed:', String(e).slice(0, 160))
    await send(msg.chat.id, 'ai brain hiccuped — try again')
  }
}

export function startTgBot(): void {
  if (!tgBotEnabled()) {
    log('[tg] q&a bot disabled (needs TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID + DEEPSEEK_API_KEY)')
    return
  }
  void (async () => {
    let offset = Number(kvGet('tg_offset') ?? 0)
    log('[tg] q&a bot polling as sole getUpdates consumer')
    for (;;) {
      try {
        const r = await fetch(`${api()}/getUpdates?timeout=25&offset=${offset}&allowed_updates=%5B%22message%22%5D`, {
          signal: AbortSignal.timeout(35_000),
        })
        const j = (await r.json()) as { ok: boolean; result?: { update_id: number; message?: { text?: string; chat: { id: number } } }[] }
        if (!j.ok) {
          log('[tg] getUpdates not ok — pausing')
          await sleep(10_000)
          continue
        }
        for (const u of j.result ?? []) {
          offset = u.update_id + 1
          kvSet('tg_offset', String(offset))
          await handleUpdate(u).catch((e) => log('[tg] handle error:', String(e).slice(0, 160)))
        }
      } catch (e) {
        log('[tg] poll error:', String(e).slice(0, 120))
        await sleep(5_000)
      }
    }
  })()
}
