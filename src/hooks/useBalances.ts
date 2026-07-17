import { useQuery } from '@tanstack/react-query'
import { usePublicClient } from 'wagmi'
import type { Address, PublicClient } from 'viem'
import { erc20Abi } from '../abi'
import { NATIVE } from '../lib/kyber'

/** balances for a set of tokens (NATIVE sentinel included). key = lowercase addr */
export function useBalances(user?: Address, tokens: Address[] = []) {
  const pc = usePublicClient()
  const key = tokens
    .map((t) => t.toLowerCase())
    .sort()
    .join(',')
  return useQuery({
    queryKey: ['balances', user, key],
    enabled: !!pc && !!user && tokens.length > 0,
    refetchInterval: 15_000,
    queryFn: async () => {
      const client = pc as PublicClient
      const out: Record<string, bigint> = {}
      const erc20s = tokens.filter((t) => t.toLowerCase() !== NATIVE.toLowerCase())
      const hasNative = tokens.length !== erc20s.length
      const res = (await client.multicall({
        contracts: erc20s.map((t) => ({
          abi: erc20Abi,
          address: t,
          functionName: 'balanceOf',
          args: [user!],
        })) as never,
      })) as { status: string; result?: unknown }[]
      erc20s.forEach((t, i) => {
        out[t.toLowerCase()] =
          res[i]?.status === 'success' ? (res[i].result as bigint) : 0n
      })
      if (hasNative) out[NATIVE.toLowerCase()] = await client.getBalance({ address: user! })
      return out
    },
  })
}
