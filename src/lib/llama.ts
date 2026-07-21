// DeFiLlama chain-level analytics for Robinhood Chain — reached through the
// same-origin `/llama` + `/llama-stables` proxies (vite dev server / nginx in
// prod), the same wiring as every other third-party API in this app.
const CHAIN = encodeURIComponent('Robinhood Chain')

export type TvlPoint = { date: number; tvl: number }
/** [unix seconds, usd] */
export type SeriesPoint = [number, number]

export type LlamaProto = {
  name: string
  displayName?: string
  category?: string | null
  total24h?: number | null
  total7d?: number | null
  total30d?: number | null
  change_1d?: number | null
}

export type LlamaOverview = {
  total24h?: number
  total7d?: number
  total30d?: number
  change_1d?: number
  change_7d?: number
  totalDataChart?: SeriesPoint[]
  protocols?: LlamaProto[]
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { headers: { accept: 'application/json' } })
  if (!r.ok) throw new Error(`defillama ${r.status}`)
  return (await r.json()) as T
}

export const fetchChainTvl = () => getJson<TvlPoint[]>(`/llama/v2/historicalChainTvl/${CHAIN}`)

export const fetchDexOverview = () =>
  getJson<LlamaOverview>(`/llama/overview/dexs/${CHAIN}?excludeTotalDataChart=false`)

export const fetchFeesOverview = () =>
  getJson<LlamaOverview>(`/llama/overview/fees/${CHAIN}?excludeTotalDataChart=false`)

type StablePoint = { date: string; totalCirculatingUSD?: { peggedUSD?: number } }

/** daily stablecoin market cap on the chain (USD) */
export async function fetchStables(): Promise<SeriesPoint[]> {
  const rows = await getJson<StablePoint[]>(`/llama-stables/stablecoincharts/${CHAIN}`)
  return rows
    .map((p): SeriesPoint => [Number(p.date), p.totalCirculatingUSD?.peggedUSD ?? NaN])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
}
