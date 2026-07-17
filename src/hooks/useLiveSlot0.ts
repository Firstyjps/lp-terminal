import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { clPoolAbi } from '../abi'

export type LiveSlot0 = { sqrtPriceX96: bigint; tick: number }

/**
 * Fast, targeted price feed: polls ONLY slot0 of the given CL pools (one
 * multicall) every `intervalMs`. Used where fill/price must feel live (range
 * orders) without re-running the full pool enumeration at that rate.
 */
export function useLiveSlot0(pools: Address[], intervalMs = 4_000) {
  const pc = usePublicClient()
  const key = pools
    .map((a) => a.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['liveSlot0', key],
    enabled: !!pc && pools.length > 0,
    refetchInterval: intervalMs,
    staleTime: 0,
    queryFn: async () => {
      const res = (await (pc as PublicClient).multicall({
        contracts: pools.map((a) => ({
          abi: clPoolAbi,
          address: a,
          functionName: 'slot0',
        })) as never,
      })) as { status: string; result?: readonly [bigint, number, ...unknown[]] }[]
      const out: Record<string, LiveSlot0> = {}
      pools.forEach((a, i) => {
        const r = res[i]
        if (r?.status === 'success' && r.result) {
          out[a.toLowerCase()] = { sqrtPriceX96: r.result[0], tick: Number(r.result[1]) }
        }
      })
      return out
    },
  })
}
