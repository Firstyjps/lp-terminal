import { useQuery } from '@tanstack/react-query'
import { fetchChainTvl, fetchDexOverview, fetchFeesOverview, fetchStables } from '../lib/llama'

// chain-level aggregates move slowly — refresh every 5 min, serve stale on error
const opts = { refetchInterval: 300_000, staleTime: 270_000, retry: 1 } as const

export const useChainTvl = () => useQuery({ queryKey: ['llamaTvl'], queryFn: fetchChainTvl, ...opts })
export const useDexOverview = () => useQuery({ queryKey: ['llamaDex'], queryFn: fetchDexOverview, ...opts })
export const useFeesOverview = () => useQuery({ queryKey: ['llamaFees'], queryFn: fetchFeesOverview, ...opts })
export const useStables = () => useQuery({ queryKey: ['llamaStables'], queryFn: fetchStables, ...opts })
