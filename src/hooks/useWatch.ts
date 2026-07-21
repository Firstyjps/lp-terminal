// Indexer-side position tracking (WATCH_ADDRESSES): last-known rows power the
// PnL readouts in POSITIONS. Wallets the indexer isn't watching just get
// watched:false — the UI renders nothing extra for them.
import { useQuery } from '@tanstack/react-query'
import type { Address } from 'viem'

export type WatchRow = {
  npm: 'up33' | 'univ3'
  tokenId: string
  staked: boolean
  inRange: boolean | null
  valueUsd: number | null
  feesUsd: number | null
  collectedUsd: number
  firstTs: number
  firstValueUsd: number | null
  closed: boolean
  outSince: number | null
}

export type WatchData = {
  enabled: boolean
  telegram: boolean
  watched: boolean
  rows: WatchRow[]
  /** open rows keyed `${npm}|${tokenId}` for card lookup */
  byKey: Map<string, WatchRow>
}

async function fetchWatch(owner: string): Promise<WatchData> {
  const r = await fetch(new URL(`/api/watch?owner=${owner.toLowerCase()}`, location.origin))
  if (!r.ok) throw new Error(`watch ${r.status}`)
  const j = (await r.json()) as { enabled?: boolean; telegram?: boolean; watched?: boolean; positions?: Record<string, unknown>[] }
  const rows: WatchRow[] = (j.positions ?? []).map((p) => ({
    npm: p.npm as 'up33' | 'univ3',
    tokenId: String(p.token_id),
    staked: p.staked === 1,
    inRange: p.in_range == null ? null : p.in_range === 1,
    valueUsd: (p.value_usd as number | null) ?? null,
    feesUsd: (p.fees_usd as number | null) ?? null,
    collectedUsd: (p.collected_usd as number) ?? 0,
    firstTs: p.first_ts as number,
    firstValueUsd: (p.first_value_usd as number | null) ?? null,
    closed: p.closed === 1,
    outSince: (p.out_since as number | null) ?? null,
  }))
  return {
    enabled: !!j.enabled,
    telegram: !!j.telegram,
    watched: !!j.watched,
    rows,
    byKey: new Map(rows.filter((r) => !r.closed).map((r) => [`${r.npm}|${r.tokenId}`, r])),
  }
}

export function useWatch(owner?: Address) {
  return useQuery({
    queryKey: ['watch', owner?.toLowerCase()],
    enabled: !!owner,
    refetchInterval: 60_000,
    retry: false,
    queryFn: () => fetchWatch(owner!),
  })
}
