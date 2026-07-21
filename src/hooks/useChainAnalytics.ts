import { useQuery } from '@tanstack/react-query'
import { fetchChainTvl, fetchDexOverview, fetchFeesOverview, fetchStables } from '../lib/llama'

// chain-level aggregates move slowly — refresh every 5 min, serve stale on error
const opts = { refetchInterval: 300_000, staleTime: 270_000, retry: 1 } as const

export type AiInsight = { asof: number; model: string; en: string; zh: string }

/** server-side cached DeepSeek narrative — 503 means no key configured */
export const useAiInsight = () =>
  useQuery({
    queryKey: ['aiInsight'],
    refetchInterval: 600_000,
    staleTime: 570_000,
    retry: 1,
    queryFn: async (): Promise<AiInsight> => {
      const r = await fetch('/api/ai-insight', { headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`ai ${r.status}`)
      return r.json()
    },
  })

export type Dip = {
  token: string
  symbol: string
  price: number
  drop1h: number | null
  drop24h: number | null
  pool: string
  poolTvl: number
}
export type DipsData = { asof: number; dips: Dip[] }

/** indexer dip detector — trusted tokens that just dumped (10-min scan) */
export const useDips = () =>
  useQuery({
    queryKey: ['dips'],
    refetchInterval: 300_000,
    staleTime: 270_000,
    retry: 1,
    queryFn: async (): Promise<DipsData> => {
      const r = await fetch('/api/dips', { headers: { accept: 'application/json' } })
      if (!r.ok) throw new Error(`dips ${r.status}`)
      return r.json()
    },
  })

export const useChainTvl = () => useQuery({ queryKey: ['llamaTvl'], queryFn: fetchChainTvl, ...opts })
export const useDexOverview = () => useQuery({ queryKey: ['llamaDex'], queryFn: fetchDexOverview, ...opts })
export const useFeesOverview = () => useQuery({ queryKey: ['llamaFees'], queryFn: fetchFeesOverview, ...opts })
export const useStables = () => useQuery({ queryKey: ['llamaStables'], queryFn: fetchStables, ...opts })
