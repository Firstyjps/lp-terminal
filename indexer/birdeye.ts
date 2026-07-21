// Birdeye smart-money layer — the one thing our own swap data can't answer:
// "is this wallet actually PROFITABLE, or just loud?" Birdeye's gainers
// leaderboard (x-chain: robinhood) is synced into wallet_pnl and joined onto
// VOL's top-trader tables + served at /api/smartmoney.
//
// Key: BIRDEYE_API_KEY (or BIRDEYE) in .env — absent = whole module dormant,
// same convention as DeepSeek/Telegram. Free-tier friendly: 2 GETs / 30 min.
import { envVal, log, now, sleep } from './config'
import { allWalletPnl, clearWalletPnl, tx, upsertWalletPnl } from './store'

const BASE = 'https://public-api.birdeye.so'
const WINDOWS = ['today', '1W'] as const

const apiKey = (): string | null => envVal('BIRDEYE_API_KEY') ?? envVal('BIRDEYE')
export const birdeyeEnabled = (): boolean => apiKey() !== null

async function get(path: string, params: Record<string, string | number>): Promise<Record<string, unknown> | null> {
  const key = apiKey()
  if (!key) return null
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])))
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}${path}?${qs}`, {
        headers: { 'X-API-KEY': key, 'x-chain': 'robinhood', accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
      if (r.status === 429) {
        await sleep(2_000 * (attempt + 1))
        continue
      }
      if (!r.ok) {
        log(`[birdeye] ${path} http ${r.status}`)
        return null
      }
      return (await r.json()) as Record<string, unknown>
    } catch {
      await sleep(1_000 * (attempt + 1))
    }
  }
  return null
}

type GainerItem = { address?: string; pnl?: number; volume?: number; trade_count?: number }

/** pull the top-100 PnL leaderboard per window into wallet_pnl */
export async function birdeyeCycle(): Promise<void> {
  for (const win of WINDOWS) {
    const j = await get('/trader/gainers-losers', {
      type: win,
      sort_by: 'PnL',
      sort_type: 'desc',
      offset: 0,
      limit: 100,
    })
    const items = ((j?.data as { items?: GainerItem[] } | undefined)?.items ?? []).filter((it) => it.address)
    if (!j) continue
    if (j.success !== true) {
      log(`[birdeye] gainers ${win} rejected:`, JSON.stringify(j).slice(0, 120))
      continue
    }
    const ts = now()
    tx(() => {
      clearWalletPnl(win) // full refresh — ranks shift every cycle
      items.forEach((it, i) =>
        upsertWalletPnl(
          {
            address: it.address!,
            win,
            rank: i + 1,
            pnl: it.pnl ?? null,
            volume: it.volume ?? null,
            trade_count: it.trade_count ?? null,
          },
          ts,
        ),
      )
    })
    log(`[birdeye] ${win} leaderboard: ${items.length} wallets`)
    await sleep(1_500)
  }
}

export const smartMoney = () => ({ enabled: birdeyeEnabled(), asof: now(), wallets: allWalletPnl() })
