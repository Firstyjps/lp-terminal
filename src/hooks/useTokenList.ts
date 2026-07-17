import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'
import { ADDR } from '../config/addresses'
import { NATIVE, kyberTokenList } from '../lib/kyber'
import type { TokenInfo } from '../types'
import { usePools } from './usePools'

const PINNED: string[] = [NATIVE, ADDR.WETH, ADDR.UP, ADDR.USDG].map((a) => a.toLowerCase())

/** merged token list for the swap picker: ETH + pool tokens + ks-setting registry */
export function useTokenList(): TokenInfo[] {
  const pools = usePools()
  const kyber = useQuery({
    queryKey: ['kyberTokens'],
    staleTime: 10 * 60_000,
    refetchInterval: false,
    queryFn: kyberTokenList,
  })

  const map = new Map<string, TokenInfo>()
  map.set(NATIVE.toLowerCase(), {
    address: NATIVE as Address,
    symbol: 'ETH',
    decimals: 18,
    native: true,
  })
  if (pools.data) {
    for (const [k, t] of Object.entries(pools.data.tokens)) map.set(k, t)
  }
  for (const t of kyber.data ?? []) {
    const k = t.address.toLowerCase()
    if (k === NATIVE.toLowerCase()) continue
    if (!map.has(k)) map.set(k, { address: t.address, symbol: t.symbol, decimals: t.decimals })
  }

  const list = [...map.values()]
  list.sort((a, b) => {
    const ai = PINNED.indexOf(a.address.toLowerCase())
    const bi = PINNED.indexOf(b.address.toLowerCase())
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi)
    return a.symbol.localeCompare(b.symbol)
  })
  return list
}
