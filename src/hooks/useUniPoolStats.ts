// TVL/volume stats for SPECIFIC uniswap pools (the ones the user holds
// positions in), straight from the pool indexer's address search. Kept apart
// from useUniPools (catalog browse) so POSITIONS doesn't drag a 120-row page.
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { fetchUniIndex } from '../lib/uniIndex'
import type { PoolStat } from '../lib/poolstats'

export function useUniPoolStats(addrs: Address[]) {
  const key = addrs
    .map((a) => a.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['uniPoolStats', key],
    enabled: addrs.length > 0,
    refetchInterval: 60_000,
    staleTime: 50_000,
    queryFn: async () => {
      const out: Record<string, PoolStat> = {}
      await Promise.all(
        addrs.map(async (a) => {
          const r = await fetchUniIndex(a, 0, undefined, 'tvl', 4).catch(() => null)
          if (r) Object.assign(out, r.stats)
        }),
      )
      return out
    },
  })
}
