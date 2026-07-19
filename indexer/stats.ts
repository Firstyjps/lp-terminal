// GeckoTerminal enrichment — volume/liquidity/txn stats + token USD price
// seeds for the pricing waterfall. GT fully covers this chain's Uniswap
// deployments (network `robinhood`, per-dex top lists) but each list is capped
// at 10 pages × 20 = top 200 — the long tail keeps chain-derived TVL only.
// Free tier is 30 calls/min: calls are paced ≥ TUNE.gtPaceMs apart and the
// whole cycle (≤30 calls) runs every TUNE.statsMs.
//
// NOTE: GT has no UP33 dex entry — UP33 pool stats stay on the frontend's
// existing dexscreener path; this indexer only serves the Uniswap catalog.
import { GT, TUNE, log, sleep } from './config'
import { poolRow, setTokenPrice, upsertStats } from './store'

const LISTS = [
  { path: '/networks/robinhood/pools', label: 'network' },
  { path: '/networks/robinhood/dexes/uniswap-v2-robinhood/pools', label: 'uni-v2' },
  { path: '/networks/robinhood/dexes/uniswap-v3-robinhood/pools', label: 'uni-v3' },
]

type GtPool = {
  attributes?: {
    address?: string
    reserve_in_usd?: string
    volume_usd?: { h24?: string }
    transactions?: { h24?: { buys?: number; sells?: number } }
    base_token_price_usd?: string
    quote_token_price_usd?: string
  }
  relationships?: {
    base_token?: { data?: { id?: string } }
    quote_token?: { data?: { id?: string } }
  }
}

let lastCall = 0
async function gtJson(url: string): Promise<{ data?: GtPool[] } | null> {
  const wait = lastCall + TUNE.gtPaceMs - Date.now()
  if (wait > 0) await sleep(wait)
  lastCall = Date.now()
  try {
    const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'up33-lp-indexer/0.1' } })
    if (!r.ok) return null
    return (await r.json()) as { data?: GtPool[] }
  } catch {
    return null
  }
}

const num = (x: unknown): number | null => {
  const n = Number(x)
  return Number.isFinite(n) ? n : null
}
const tokenOfId = (id?: string): string | null =>
  id?.startsWith('robinhood_0x') ? id.slice('robinhood_'.length).toLowerCase() : null

function ingest(p: GtPool): boolean {
  const a = p.attributes
  const addr = a?.address?.toLowerCase()
  if (!a || !addr || !poolRow(addr)) return false // catalog is the gate — unknown pools are ignored
  const reserve = num(a.reserve_in_usd)
  const h24 = a.transactions?.h24
  const txns = h24 ? (h24.buys ?? 0) + (h24.sells ?? 0) : null
  upsertStats(addr, num(a.volume_usd?.h24), txns, reserve, 'geckoterminal')
  // token price seeds: ground truth while fresh; depth = half the pool's reserve
  const depth = (reserve ?? 0) / 2
  if (depth > 0) {
    const base = tokenOfId(p.relationships?.base_token?.data?.id)
    const quote = tokenOfId(p.relationships?.quote_token?.data?.id)
    const bp = num(a.base_token_price_usd)
    const qp = num(a.quote_token_price_usd)
    if (base && bp && bp > 0) setTokenPrice(base, bp, depth, depth, 'gt')
    if (quote && qp && qp > 0) setTokenPrice(quote, qp, depth, depth, 'gt')
  }
  return true
}

/** one enrichment cycle over the three GT top lists */
export async function gtCycle(): Promise<void> {
  let matched = 0
  let seen = 0
  for (const list of LISTS) {
    for (let page = 1; page <= 10; page++) {
      const j = await gtJson(`${GT}${list.path}?page=${page}`)
      const items = j?.data
      if (!items?.length) break
      seen += items.length
      for (const it of items) if (ingest(it)) matched++
      if (items.length < 20) break
    }
  }
  log(`[stats] gt cycle: ${matched}/${seen} list entries matched catalog`)
}
