import { useQuery } from '@tanstack/react-query'

// mirrors indexer/vol.ts readVol() output
export type VolBucket = {
  ts: number
  buy: number
  sell: number
  swaps: number
  price: number | null
  traders: number
  cvd: number
}
export type VolTrader = {
  addr: string
  short: string
  buy: number
  sell: number
  total: number
  n: number
  share: number
  churn: number
  /** Birdeye leaderboard membership — present only when the indexer has a key */
  pnl?: { win: string; rank: number; pnl: number | null }
}
export type VolTrade = { ts: number; side: 'buy' | 'sell'; v: number; price: number | null; trader: string | null; tx: string }
export type VolData = {
  pool: string
  hours: number
  status: 'indexing' | 'ready' | 'error' | 'unknown'
  progress: number
  partial: boolean
  error?: string
  asof: number
  meta?: { kind: string; base: string; quote: string; usd: boolean; quoteUsd: number | null }
  /** GMGN verdict on the base token — absent until fetched / without a key */
  security?: {
    honeypot: boolean
    alert: boolean
    sellTax: number | null
    buyTax: number | null
    openSource: boolean
    renounced: boolean
    top10Rate: number | null
    known: boolean
  }
  coverage?: { fromTs: number; toTs: number; complete: boolean }
  totals?: {
    buy: number
    sell: number
    delta: number
    total: number
    swaps: number
    wallets: number
    traderless: number
    avgTrade: number
    top5Share: number
    churnShare: number
    washy: boolean
  }
  buckets?: VolBucket[]
  topTraders?: VolTrader[]
  bigTrades?: VolTrade[]
}

/** on-demand swap analytics — polls fast while the indexer backfills, then
 *  settles into a slow refresh that just tails new blocks */
export const useVol = (pool: string | null, hours: number, kind: 'cl' | 'v2' | 'v2s') =>
  useQuery({
    queryKey: ['vol', pool, hours],
    enabled: !!pool,
    refetchInterval: (q) => (q.state.data?.status === 'ready' ? 60_000 : 2_500),
    staleTime: 2_000,
    retry: 1,
    queryFn: async (): Promise<VolData> => {
      const r = await fetch(`/api/vol?pool=${pool!.toLowerCase()}&hours=${hours}&kind=${kind}`, {
        headers: { accept: 'application/json' },
      })
      if (!r.ok) throw new Error(`vol ${r.status}`)
      const j = (await r.json()) as VolData & { error?: string }
      if (j.error && !j.status) throw new Error(j.error)
      return j
    },
  })
