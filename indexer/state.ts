// On-chain state sweeps + USD pricing.
//
// State per pool (multicall):
//   univ3: slot0 + liquidity + erc20 balanceOf(token0/1) — balances (not L)
//          are the TVL basis, matching how GT/dexscreener report "reserve".
//   univ2: getReserves + totalSupply.
//
// Pricing is a waterfall: GeckoTerminal token prices are ground truth while
// fresh (stats.ts seeds them, depth = pool reserve/2); everything else comes
// from anchor propagation — a token gets priced through the deepest pool that
// pairs it against an already-priced token, requiring ≥ TUNE.minDepthUsd of
// priced-side depth so dust pools can't set prices. TVL then = sum of priced
// sides (single-priced-side pools: 2× that side, flagged approximate).
import { erc20Abi, formatUnits } from 'viem'
import { uniV2PairAbi, uniV3PoolAbi } from '../src/abi'
import { ADDR, TUNE, log, now } from './config'
import { mc, ok, type Call } from './rpc'
import {
  allTokens,
  db,
  missingMetaTokens,
  setTokenPrice,
  setTvl,
  tx,
  upsertState,
  upsertTokenMeta,
  type PoolRow,
} from './store'

const printable = (s: unknown): string | null => {
  if (typeof s !== 'string') return null
  const t = s.replace(/[^\x20-\x7e]/g, '').trim()
  return t ? t.slice(0, 24) : null
}

/** fetch symbol/decimals for catalog tokens we haven't met yet (10k/slice) */
export async function ensureTokenMeta(): Promise<number> {
  const all = missingMetaTokens()
  for (let i = 0; i < all.length; i += 10_000) {
    const missing = all.slice(i, i + 10_000)
    const res = await mc(
      missing.flatMap((t) => [
        { abi: erc20Abi, address: t as `0x${string}`, functionName: 'symbol' },
        { abi: erc20Abi, address: t as `0x${string}`, functionName: 'decimals' },
      ]),
    )
    tx(() => {
      missing.forEach((t, j) => {
        const sym = printable(ok<string>(res[j * 2]))
        const dec = ok<number>(res[j * 2 + 1])
        upsertTokenMeta(t, sym ?? t.slice(0, 6) + '…', dec ?? 18, sym !== null && dec !== undefined)
      })
    })
  }
  return all.length
}

const poolRowsQ = (addrs: string[]): PoolRow[] => {
  const out: PoolRow[] = []
  const q = db.prepare('SELECT address, proto, token0, token1, fee_ppm, tick_spacing FROM pools WHERE address = ?')
  for (const a of addrs) {
    const r = q.get(a.toLowerCase()) as PoolRow | undefined
    if (r) out.push(r)
  }
  return out
}

/** refresh raw on-chain state for the given pools (memory-bounded slices) */
export async function sweepState(addrs: string[]): Promise<number> {
  let done = 0
  for (let i = 0; i < addrs.length; i += 5_000) {
    done += await sweepSlice(addrs.slice(i, i + 5_000))
  }
  return done
}

async function sweepSlice(addrs: string[]): Promise<number> {
  if (!addrs.length) return 0
  const rows = poolRowsQ(addrs)
  const calls: Call[] = []
  for (const p of rows) {
    const a = p.address as `0x${string}`
    if (p.proto === 'univ3')
      calls.push(
        { abi: uniV3PoolAbi, address: a, functionName: 'slot0' },
        { abi: uniV3PoolAbi, address: a, functionName: 'liquidity' },
        { abi: erc20Abi, address: p.token0 as `0x${string}`, functionName: 'balanceOf', args: [a] },
        { abi: erc20Abi, address: p.token1 as `0x${string}`, functionName: 'balanceOf', args: [a] },
      )
    else
      calls.push(
        { abi: uniV2PairAbi, address: a, functionName: 'getReserves' },
        { abi: uniV2PairAbi, address: a, functionName: 'totalSupply' },
      )
  }
  const res = await mc(calls)
  let i = 0
  tx(() => {
    for (const p of rows) {
      if (p.proto === 'univ3') {
        const s0 = ok<readonly [bigint, number, ...unknown[]]>(res[i++])
        const liq = ok<bigint>(res[i++])
        const b0 = ok<bigint>(res[i++])
        const b1 = ok<bigint>(res[i++])
        if (!s0) continue
        upsertState(p.address, {
          sqrtPrice: s0[0],
          tick: s0[1],
          liquidity: liq ?? 0n,
          reserve0: b0 ?? 0n,
          reserve1: b1 ?? 0n,
        })
      } else {
        const rs = ok<readonly [bigint, bigint, number]>(res[i++])
        const ts = ok<bigint>(res[i++])
        if (!rs) continue
        upsertState(p.address, { reserve0: rs[0], reserve1: rs[1], totalSupply: ts ?? 0n })
      }
    }
  })
  return rows.length
}

type PriceEntry = { usd: number; depth: number; trust: number; src: string; updated: number }

// trust = min real depth along the propagation chain back to an anchor/GT seed
// (bottleneck). depth alone is spoofable: a scam pool's "depth" is its balance
// × an already-fake price, so chained pools can claim arbitrary depth — but
// they can never raise the bottleneck above the real money at the chain's root.
const ANCHOR_TRUST = 1e12

const loadPrices = (): Map<string, PriceEntry> => {
  const m = new Map<string, PriceEntry>()
  for (const t of allTokens())
    if (t.price_usd != null && t.price_usd > 0)
      m.set(t.address, {
        usd: t.price_usd,
        depth: t.price_depth_usd,
        // pre-migration rows have trust 0 — GT seeds fall back to their depth
        trust: t.price_trust_usd > 0 ? t.price_trust_usd : t.price_src === 'gt' ? t.price_depth_usd : 0,
        src: t.price_src ?? '?',
        updated: t.price_updated ?? 0,
      })
  // WETH + USDG are the chain's verified anchors — fully trusted regardless of
  // the (often tiny) stored depth GT happened to sample their price from.
  // Applied here so every consumer (reprice AND computeTvlFor) gets it.
  for (const a of [ADDR.WETH, ADDR.USDG]) {
    const e = m.get(a.toLowerCase())
    if (e) e.trust = ANCHOR_TRUST
  }
  return m
}

type StateRow = {
  address: string
  proto: string
  token0: string
  token1: string
  reserve0: string
  reserve1: string
}
const statesQ = () =>
  db
    .prepare(
      `SELECT p.address, p.proto, p.token0, p.token1, s.reserve0, s.reserve1
       FROM pools p JOIN pool_state s ON s.address = p.address`,
    )
    .all() as StateRow[]

/**
 * Full pricing pass: propagate USD prices from GT/anchor seeds through pools,
 * then recompute every pool's TVL. Pure JS over in-memory rows (~35k pools),
 * runs after full sweeps and after each GT cycle.
 */
export function reprice(): { priced: number; tvlPools: number } {
  const decs = new Map(allTokens().map((t) => [t.address, t.decimals]))
  const prices = loadPrices()
  // bootstrap anchor before the first GT cycle: USDG ≈ $1 (GT overwrites it)
  if (!prices.has(ADDR.USDG.toLowerCase()))
    prices.set(ADDR.USDG.toLowerCase(), { usd: 1, depth: 1, trust: ANCHOR_TRUST, src: 'anchor', updated: now() })

  const states = statesQ()
  const human = (raw: string, addr: string) => Number(formatUnits(BigInt(raw), decs.get(addr) ?? 18))
  const gtFresh = (e: PriceEntry) => e.src === 'gt' && now() - e.updated < TUNE.gtFreshSecs

  const dirty = new Map<string, PriceEntry>()
  for (let round = 0; round < 3; round++) {
    let changed = 0
    for (const s of states) {
      const b0 = human(s.reserve0, s.token0)
      const b1 = human(s.reserve1, s.token1)
      for (const [known, other, kb, ob] of [
        [s.token0, s.token1, b0, b1],
        [s.token1, s.token0, b1, b0],
      ] as const) {
        const kp = prices.get(known)
        if (!kp || ob <= 0) continue
        const depth = kb * kp.usd
        if (depth < TUNE.minDepthUsd) continue
        const trust = Math.min(kp.trust, depth)
        const existing = prices.get(other)
        // trust-first replacement (depth breaks ties): depth-first would let a
        // deep-but-fake pool hijack the price of a legitimately priced token
        if (existing && (gtFresh(existing) || existing.trust > trust || (existing.trust === trust && existing.depth >= depth)))
          continue
        const e: PriceEntry = { usd: depth / ob, depth, trust, src: 'pool', updated: now() }
        prices.set(other, e)
        dirty.set(other, e)
        changed++
      }
    }
    if (!changed) break
  }

  const gtLiq = new Map(
    (db.prepare('SELECT address, liq_usd FROM pool_stats WHERE liq_usd IS NOT NULL').all() as {
      address: string
      liq_usd: number
    }[]).map((r) => [r.address, r.liq_usd]),
  )
  let tvlPools = 0
  tx(() => {
    for (const [addr, e] of dirty) setTokenPrice(addr, e.usd, e.depth, e.trust, e.src)
    for (const s of states) {
      const p0 = prices.get(s.token0)
      const p1 = prices.get(s.token1)
      const u0 = p0 ? human(s.reserve0, s.token0) * p0.usd : null
      const u1 = p1 ? human(s.reserve1, s.token1) * p1.usd : null
      const tvl = u0 != null && u1 != null ? u0 + u1 : u0 != null ? u0 * 2 : u1 != null ? u1 * 2 : null
      setTvl(s.address, tvl, tvl != null && (u0 == null || u1 == null), tvlSus(tvl, u0, p0, u1, p1, gtLiq.get(s.address)))
      if (tvl != null) tvlPools++
    }
  })
  return { priced: prices.size, tvlPools }
}

/**
 * sus = the claimed TVL is mostly backed by a token whose price trust can't
 * plausibly support it (side value > susRatio × the token's trust bottleneck).
 * GT's own reserve figure rescues pools GT actively tracks: if GT sees real
 * liquidity in the same order of magnitude, the TVL stands.
 */
function tvlSus(
  tvl: number | null,
  u0: number | null,
  p0: PriceEntry | undefined,
  u1: number | null,
  p1: PriceEntry | undefined,
  gtLiqUsd: number | undefined,
): boolean {
  if (tvl == null) return false
  if (gtLiqUsd != null && gtLiqUsd * TUNE.susRatio >= tvl) return false
  const over = (u: number | null, p: PriceEntry | undefined) => u != null && p != null && u > TUNE.susRatio * p.trust
  return over(u0, p0) || over(u1, p1)
}

/** cheap TVL refresh for a few pools using already-stored prices (no propagation) */
export function computeTvlFor(addrs: string[]): void {
  if (!addrs.length) return
  const decs = new Map(allTokens().map((t) => [t.address, t.decimals]))
  const prices = loadPrices()
  const q = db.prepare(
    `SELECT p.address, p.proto, p.token0, p.token1, s.reserve0, s.reserve1
     FROM pools p JOIN pool_state s ON s.address = p.address WHERE p.address = ?`,
  )
  const liqQ = db.prepare('SELECT liq_usd FROM pool_stats WHERE address = ?')
  tx(() => {
    for (const a of addrs) {
      const s = q.get(a.toLowerCase()) as StateRow | undefined
      if (!s) continue
      const human = (raw: string, addr: string) => Number(formatUnits(BigInt(raw), decs.get(addr) ?? 18))
      const p0 = prices.get(s.token0)
      const p1 = prices.get(s.token1)
      const u0 = p0 ? human(s.reserve0, s.token0) * p0.usd : null
      const u1 = p1 ? human(s.reserve1, s.token1) * p1.usd : null
      const tvl = u0 != null && u1 != null ? u0 + u1 : u0 != null ? u0 * 2 : u1 != null ? u1 * 2 : null
      const gtLiq = (liqQ.get(s.address) as { liq_usd: number | null } | undefined)?.liq_usd ?? undefined
      setTvl(s.address, tvl, tvl != null && (u0 == null || u1 == null), tvlSus(tvl, u0, p0, u1, p1, gtLiq))
    }
  })
}

export const sweepLog = (label: string, n: number, ms: number) =>
  log(`[sweep] ${label} ${n} pools in ${(ms / 1000).toFixed(1)}s`)
