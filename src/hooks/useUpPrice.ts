import { useQuery } from '@tanstack/react-query'
import { parseUnits } from 'viem'
import { ADDR } from '../config/addresses'
import { kyberRoute } from '../lib/kyber'

/** USD price of 1 UP via a kyber UP->USDG quote (display only) */
export function useUpPrice() {
  return useQuery({
    queryKey: ['upPrice'],
    refetchInterval: 60_000,
    staleTime: 50_000,
    retry: 1,
    queryFn: async () => {
      // applyFee: false — this is a price display, not an executable quote
      const r = await kyberRoute(ADDR.UP, ADDR.USDG, parseUnits('1', 18), { applyFee: false })
      const usd = Number(r.routeSummary.amountOutUsd ?? NaN)
      if (Number.isFinite(usd) && usd > 0) return usd
      return Number(r.routeSummary.amountOut) / 1e6 // USDG has 6 decimals
    },
  })
}
