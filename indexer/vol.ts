// On-demand per-pool volume analysis — deep detail GMGN-style aggregates
// can't give: buy/sell USD split, CVD, per-wallet concentration and churn
// (wash) signals, straight from Swap logs.
//
// Nothing here runs in the background loops: a pool gets indexed only when
// /api/vol is asked about it. First request enqueues a backfill job (Blockscout
// logs primary — no range cap, timestamps included — RPC windows fallback);
// subsequent requests serve partial data with a progress figure until coverage
// reaches the requested range, then a cheap cursor tail keeps it fresh.
//
// Swap topics across the chain's protocols:
//   cl-kind:  univ3 + UP33 CL (Slipstream fork) share the univ3 Swap signature
//   v2-kind:  vanilla univ2 Swap(sender, 4×uint, to)
//   v2s-kind: UP33 v2 (Solidly fork) Swap(sender, to, 4×uint) — different
//             topic0, identical data words, so decode() is shared
import { erc20Abi, parseAbi, parseAbiItem, toEventSelector } from 'viem'
import { ADDR, BLOCKSCOUT, PUBLIC_RPC, log, now, sleep } from './config'
import { securityOf } from './gmgn'
import { mc, ok, pc } from './rpc'
import { uniV2PairAbi, uniV3PoolAbi } from '../src/abi'
import {
  db,
  insertSwap,
  kvGet,
  kvSet,
  poolRow,
  pruneSwaps,
  setSwapTrader,
  swapTxsMissingTrader,
  swapsFor,
  tokenRows,
  tx,
  upsertTokenMeta,
  walletPnlRows,
  type SwapRow,
} from './store'

const SWAP_V3 = parseAbiItem(
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
)
const SWAP_V2 = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
)
const SWAP_V2S = parseAbiItem(
  'event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)',
)
const TOPIC_V3 = toEventSelector(SWAP_V3)
const TOPIC_V2 = toEventSelector(SWAP_V2)
const TOPIC_V2S = toEventSelector(SWAP_V2S)
const solPairAbi = parseAbi(['function stable() view returns (bool)'])

const topicOf = (m: { kind: string }) => (m.kind === 'cl' ? TOPIC_V3 : m.kind === 'v2s' ? TOPIC_V2S : TOPIC_V2)
const eventOf = (m: { kind: string }) => (m.kind === 'cl' ? SWAP_V3 : m.kind === 'v2s' ? SWAP_V2S : SWAP_V2)

export const VOL_HOURS = [6, 24, 72] as const
const KEEP_SECS = 7 * 86_400 // swap-row retention
// progress-bar denominator ONLY. This is an Arbitrum-orbit chain: blocks are
// minted on demand, so block-count × seconds arithmetic is NOT valid for
// time↔block conversion — use blockTs()/blockAtTs() (real timestamps) instead.
const BLOCK_SEC = 0.1004
const MAX_SWAPS_PER_JOB = 60_000 // runaway pool guard — job ends partial
const JOB_MAX_MS = 5 * 60_000
const QUEUE_MAX = 4

// ---- pool meta (kind + token sides), cached in kv ----

type VolMeta = {
  kind: 'cl' | 'v2' | 'v2s'
  t0: string
  t1: string
  d0: number
  d1: number
  s0: string
  s1: string
  /** true → token0 is the quote (anchor/priced side), base is token1 */
  quoteIs0: boolean
}

const metaKey = (pool: string) => `vol_meta:${pool}`
const covKey = (pool: string) => `vol_cov:${pool}`

type Coverage = { fb: number; ft: number; cb: number; ct: number } // from/cursor block+ts

const getCov = (pool: string): Coverage | null => {
  const raw = kvGet(covKey(pool))
  if (!raw) return null
  try {
    return JSON.parse(raw) as Coverage
  } catch {
    return null
  }
}
const setCov = (pool: string, c: Coverage) => kvSet(covKey(pool), JSON.stringify(c))

const ANCHORS = [ADDR.WETH.toLowerCase(), ADDR.USDG.toLowerCase()]

function pickQuote(t0: string, t1: string): boolean {
  // USDG beats WETH beats "whichever side has more price trust"
  const rank = (a: string) => (a === ANCHORS[1] ? 2 : a === ANCHORS[0] ? 1 : 0)
  const r0 = rank(t0)
  const r1 = rank(t1)
  if (r0 !== r1) return r0 > r1
  const rows = tokenRows([t0, t1])
  const trust = (a: string) => rows.find((r) => r.address === a)?.price_trust_usd ?? 0
  return trust(t0) > trust(t1)
}

async function resolveMeta(pool: string, kindHint?: string): Promise<VolMeta> {
  const cached = kvGet(metaKey(pool))
  if (cached) {
    const m = JSON.parse(cached) as VolMeta
    // trust a fresh frontend hint over a cached probe result — heals a meta
    // cached under RPC failure with the wrong topic (which scans 0 swaps)
    if (!kindHint || m.kind === kindHint || poolRow(pool)) return m
    db.prepare('DELETE FROM swaps WHERE pool = ?').run(pool)
    kvSet(covKey(pool), '')
  }

  const row = poolRow(pool)
  let kind: VolMeta['kind']
  let t0 = row?.token0
  let t1 = row?.token1
  if (row) {
    kind = row.proto === 'univ3' ? 'cl' : 'v2'
  } else if (kindHint === 'cl' || kindHint === 'v2' || kindHint === 'v2s') {
    kind = kindHint
  } else {
    // probe: CL-family pools answer slot0(); Solidly pairs answer stable();
    // vanilla v2 answers getReserves. All three failing means the address
    // isn't a pool OR the RPC is refusing us — either way, guessing here
    // would poison the meta cache with a wrong topic (0 swaps forever).
    const [r, rs, rv] = await mc([
      { abi: uniV3PoolAbi, address: pool as `0x${string}`, functionName: 'slot0' },
      { abi: solPairAbi, address: pool as `0x${string}`, functionName: 'stable' },
      { abi: uniV2PairAbi, address: pool as `0x${string}`, functionName: 'getReserves' },
    ])
    if (r.status === 'success') kind = 'cl'
    else if (rs.status === 'success') kind = 'v2s'
    else if (rv.status === 'success') kind = 'v2'
    else throw new Error('pool kind probe failed (rpc down or not a pool)')
  }
  if (!t0 || !t1) {
    const res = await mc([
      { abi: uniV2PairAbi, address: pool as `0x${string}`, functionName: 'token0' },
      { abi: uniV2PairAbi, address: pool as `0x${string}`, functionName: 'token1' },
    ])
    t0 = ok<string>(res[0])?.toLowerCase()
    t1 = ok<string>(res[1])?.toLowerCase()
    if (!t0 || !t1) throw new Error('not a pool (token0/token1 revert)')
  }
  t0 = t0.toLowerCase()
  t1 = t1.toLowerCase()

  // token meta for sides the catalog never saw (UP33 pools' tokens)
  let rows = tokenRows([t0, t1])
  const missing = [t0, t1].filter((a) => !rows.find((r) => r.address === a && r.meta_ok))
  if (missing.length) {
    const res = await mc(
      missing.flatMap((a) => [
        { abi: erc20Abi, address: a as `0x${string}`, functionName: 'symbol' },
        { abi: erc20Abi, address: a as `0x${string}`, functionName: 'decimals' },
      ]),
    )
    missing.forEach((a, i) => {
      const sym = ok<string>(res[i * 2])
      const dec = ok<number>(res[i * 2 + 1])
      upsertTokenMeta(a, sym ?? '?', dec ?? 18, sym !== undefined && dec !== undefined)
    })
    rows = tokenRows([t0, t1])
  }
  const tok = (a: string) => rows.find((r) => r.address === a)
  const meta: VolMeta = {
    kind,
    t0,
    t1,
    d0: tok(t0)?.decimals ?? 18,
    d1: tok(t1)?.decimals ?? 18,
    s0: tok(t0)?.symbol ?? '?',
    s1: tok(t1)?.symbol ?? '?',
    quoteIs0: pickQuote(t0, t1),
  }
  kvSet(metaKey(pool), JSON.stringify(meta))
  return meta
}

// ---- log parsing ----

const hexInt = (x: string) => parseInt(x, 16)
const word = (data: string, i: number) => data.slice(2 + i * 64, 2 + (i + 1) * 64)
const uintW = (data: string, i: number) => BigInt('0x' + word(data, i))
const intW = (data: string, i: number) => BigInt.asIntN(256, BigInt('0x' + word(data, i)))

type RawLog = { blockNumber: number; logIndex: number; tx: string; ts: number; data: string }

/** one decoded swap in float token units, pool-perspective deltas */
function decode(meta: VolMeta, l: RawLog): SwapRow | null {
  let net0: number
  let net1: number
  let price: number | null = null
  if (meta.kind === 'cl') {
    // amount0/amount1 are int256 pool deltas (positive = pool received)
    net0 = Number(intW(l.data, 0)) / 10 ** meta.d0
    net1 = Number(intW(l.data, 1)) / 10 ** meta.d1
    const sqrt = Number(uintW(l.data, 2)) / 2 ** 96
    const p1per0 = sqrt * sqrt * 10 ** (meta.d0 - meta.d1) // token1 per token0
    price = meta.quoteIs0 ? (p1per0 > 0 ? 1 / p1per0 : null) : p1per0
  } else {
    const a0In = Number(uintW(l.data, 0)) / 10 ** meta.d0
    const a1In = Number(uintW(l.data, 1)) / 10 ** meta.d1
    const a0Out = Number(uintW(l.data, 2)) / 10 ** meta.d0
    const a1Out = Number(uintW(l.data, 3)) / 10 ** meta.d1
    net0 = a0In - a0Out
    net1 = a1In - a1Out
  }
  const baseNet = meta.quoteIs0 ? net1 : net0
  const quoteNet = meta.quoteIs0 ? net0 : net1
  const baseAmt = Math.abs(baseNet)
  const quoteAmt = Math.abs(quoteNet)
  if (baseAmt === 0 && quoteAmt === 0) return null
  if (price == null && baseAmt > 0) price = quoteAmt / baseAmt
  return {
    pool: '', // filled by caller
    block: l.blockNumber,
    log_index: l.logIndex,
    tx: l.tx.toLowerCase(),
    ts: l.ts,
    trader: null,
    // base flowing OUT of the pool = someone bought the base token
    side: baseNet < 0 ? 'buy' : 'sell',
    base_amt: baseAmt,
    quote_amt: quoteAmt,
    price,
  }
}

// ---- block ↔ time (exact, via real block timestamps) ----

const blockTs = async (b: number): Promise<number> =>
  Number((await pc.getBlock({ blockNumber: BigInt(b) })).timestamp)

/** lowest block with timestamp ≥ targetTs — ~20 getBlock calls (binary search) */
async function blockAtTs(targetTs: number, lo: number, hi: number): Promise<number> {
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if ((await blockTs(mid)) < targetTs) lo = mid + 1
    else hi = mid
  }
  return lo
}

// ---- backfill job machinery ----

export type VolJob = {
  pool: string
  hours: number
  kindHint?: string
  status: 'queued' | 'running' | 'done' | 'error'
  progress: number // 0..1 of the block range being scanned
  error?: string
  partial?: boolean
}

const jobs = new Map<string, VolJob>()
const queue: string[] = []
let pumping = false

/** enqueue (or extend) indexing so [now-hours, now] is covered. Never throws. */
export function ensureVol(pool: string, hours: number, kindHint?: string): VolJob | undefined {
  pool = pool.toLowerCase()
  const j = jobs.get(pool)
  if (j && (j.status === 'queued' || j.status === 'running')) {
    j.hours = Math.max(j.hours, hours)
    return j
  }
  const cov = getCov(pool)
  const needFrom = now() - hours * 3_600
  // covered and cursor fresh (<60s) → nothing to do; tail on next poll otherwise
  if (cov && cov.ft <= needFrom + 120 && now() - cov.ct < 60) return j
  if (queue.length >= QUEUE_MAX) return j
  const nj: VolJob = { pool, hours, kindHint, status: 'queued', progress: 0 }
  jobs.set(pool, nj)
  queue.push(pool)
  void pump()
  return nj
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const pool = queue.shift()
      if (!pool) break
      const j = jobs.get(pool)
      if (!j) continue
      j.status = 'running'
      try {
        await runJob(j)
        j.status = 'done'
        j.progress = 1
      } catch (e) {
        j.status = 'error'
        j.error = String(e).slice(0, 160)
        log(`[vol] job ${pool.slice(0, 10)} failed:`, j.error)
      }
    }
  } finally {
    pumping = false
  }
}

async function runJob(j: VolJob): Promise<void> {
  const t0 = Date.now()
  const meta = await resolveMeta(j.pool, j.kindHint)
  const topic = topicOf(meta)
  const head = Number(await pc.getBlockNumber())
  const headTs = now()
  const row = poolRow(j.pool) as { created_block?: number | null } | undefined
  const created = row?.created_block ?? 0
  const targetTs = headTs - j.hours * 3_600
  // real-timestamp block lookup — demand-driven blocks make count arithmetic lie
  const desiredFrom = Math.max(created, await blockAtTs(targetTs, created, head))

  const cov = getCov(j.pool)
  const deadline = t0 + JOB_MAX_MS
  // reached < head ⇒ look up the honest cursor time (targetTs is already the
  // honest floor for a fully scanned old edge: no blocks in a gap = no swaps)
  const cursorTs = async (reached: number) => (reached >= head ? headTs : await blockTs(reached))

  // progress denominator (segment layout mirrors the scan plan below)
  const planned: [number, number][] = []
  if (!cov) planned.push([desiredFrom, head])
  else {
    if (head > cov.cb) planned.push([Math.max(cov.cb - 120, 0), head])
    if (desiredFrom < cov.fb) planned.push([desiredFrom, cov.fb - 1])
  }
  const totalBlocks = planned.reduce((n, [lo, hi]) => n + (hi - lo + 1), 0) || 1
  let doneBlocks = 0
  const bump = (n: number) => {
    doneBlocks += n
    j.progress = Math.min(0.95, doneBlocks / totalBlocks)
  }

  // Coverage may only ever claim a contiguous, actually-scanned block range —
  // a deadline/cap cut must never leave silent holes that read as "no trades".
  // A cut job stays partial; the frontend's next poll re-enqueues and the scan
  // continues from the honest cursor.
  let inserted = 0
  let partial = false
  if (!cov) {
    const r = await scanSegment(j, meta, topic, desiredFrom, head, deadline, bump)
    inserted += r.inserted
    partial = r.reached < head
    if (r.reached >= desiredFrom)
      setCov(j.pool, { fb: desiredFrom, ft: targetTs, cb: r.reached, ct: await cursorTs(r.reached) })
  } else {
    const nc: Coverage = { ...cov }
    // tail first — the freshest data wins the time budget
    if (head > cov.cb) {
      const r = await scanSegment(j, meta, topic, Math.max(cov.cb - 120, 0), head, deadline, bump) // ~12s overlap, PK dedupes
      inserted += r.inserted
      if (r.reached > nc.cb) {
        nc.cb = r.reached
        nc.ct = await cursorTs(r.reached)
      }
      if (r.reached < head) partial = true
    }
    // back-extension counts only when it completes — a half-done back scan
    // would leave a gap inside the claimed range
    if (desiredFrom < cov.fb && !partial) {
      const r = await scanSegment(j, meta, topic, desiredFrom, cov.fb - 1, deadline, bump)
      inserted += r.inserted
      if (r.reached >= cov.fb - 1) {
        nc.fb = desiredFrom
        nc.ft = targetTs
      } else partial = true
    }
    setCov(j.pool, nc)
  }
  j.partial = partial

  await resolveTraders(j.pool)
  const pruned = pruneSwaps(now() - KEEP_SECS)
  if (inserted || pruned)
    log(
      `[vol] ${j.pool.slice(0, 10)} +${inserted} swaps${j.partial ? ' (partial)' : ''}` +
        (pruned ? ` · pruned ${pruned}` : '') +
        ` (${((Date.now() - t0) / 1000).toFixed(0)}s)`,
    )
}

async function bsJson(url: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 3; i++) {
    try {
      // hard timeout — Blockscout hangs (not errors) on log queries over very
      // busy pools, and an untimed fetch would pin the serial job queue
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'up33-lp-indexer/0.1' },
        signal: AbortSignal.timeout(25_000),
      })
      const text = await r.text()
      if (text.trim()) return JSON.parse(text)
    } catch {
      /* retry */
    }
    await sleep(1_000 * (i + 1))
  }
  return { status: '0', message: 'no response' }
}

type BsLog = { topics: string[]; data: string; blockNumber: string; timeStamp: string; transactionHash: string; logIndex: string }

/** Blockscout paged scan; falls back to windowed RPC getLogs when it flakes */
async function scanSegment(
  j: VolJob,
  meta: VolMeta,
  topic: string,
  lo: number,
  hi: number,
  deadline: number,
  bump: (blocks: number) => void,
): Promise<ScanRes> {
  let inserted = 0
  let cursor = lo
  let reached = lo - 1 // highest block contiguously scanned so far
  let flakes = 0
  while (cursor <= hi) {
    if (Date.now() > deadline || inserted >= MAX_SWAPS_PER_JOB) return { inserted, reached }
    const jr = await bsJson(
      `${BLOCKSCOUT}/api?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=${hi}&address=${j.pool}&topic0=${topic}`,
    )
    if (jr.status !== '1') {
      if (/no records/i.test(String(jr.message))) {
        bump(hi - cursor + 1)
        return { inserted, reached: hi }
      }
      if (++flakes >= 3) {
        const r = await scanRpcWindows(j, meta, cursor, hi, deadline, bump)
        return { inserted: inserted + r.inserted, reached: r.reached }
      }
      await sleep(1_500 * flakes)
      continue
    }
    flakes = 0
    const logs = jr.result as BsLog[]
    tx(() => {
      for (const l of logs) {
        const s = decode(meta, {
          blockNumber: hexInt(l.blockNumber),
          logIndex: hexInt(l.logIndex || '0x0'),
          tx: l.transactionHash,
          ts: hexInt(l.timeStamp),
          data: l.data,
        })
        if (s) {
          s.pool = j.pool
          insertSwap(s)
          inserted++
        }
      }
    })
    const last = hexInt(logs[logs.length - 1].blockNumber)
    bump(Math.max(0, last - cursor))
    if (logs.length < 1000) {
      bump(hi - last)
      return { inserted, reached: hi }
    }
    reached = last - 1 // block `last` may be split across pages — not proven yet
    cursor = last // overlap last block; PK dedupes
    await sleep(250)
  }
  return { inserted, reached: hi }
}

type ScanRes = { inserted: number; reached: number } // reached ≥ hi ⇒ segment complete

/** RPC fallback: ≤9k-block windows; timestamps interpolated from block anchors.
 *  Stops (never skips) on a refused window — coverage must stay contiguous. */
async function scanRpcWindows(
  j: VolJob,
  meta: VolMeta,
  lo: number,
  hi: number,
  deadline: number,
  bump: (blocks: number) => void,
): Promise<ScanRes> {
  const event = eventOf(meta)
  let inserted = 0
  for (let a = lo; a <= hi; a += 9_001) {
    const b = Math.min(a + 9_000, hi)
    if (Date.now() > deadline || inserted >= MAX_SWAPS_PER_JOB) return { inserted, reached: a - 1 }
    // per-window retry — public RPC 429s under boot-sweep contention
    let logs: Awaited<ReturnType<typeof pc.getLogs>> | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        logs = await pc.getLogs({ address: j.pool as `0x${string}`, event, fromBlock: BigInt(a), toBlock: BigInt(b) })
        break
      } catch {
        await sleep(1_200 * (attempt + 1))
      }
    }
    if (!logs) return { inserted, reached: a - 1 }
    // real edge timestamps + in-window interpolation (blocks are demand-driven
    // — a global blocks-per-second constant can drift by hours)
    let tsOf = (_: number) => now()
    if (logs.length) {
      try {
        const [tsA, tsB] = [await blockTs(a), b >= a ? await blockTs(b) : now()]
        tsOf = (x: number) => Math.round(tsA + ((tsB - tsA) * (x - a)) / Math.max(1, b - a))
      } catch {
        return { inserted, reached: a - 1 } // no honest timestamps → stop here
      }
    }
    tx(() => {
      for (const l of logs!) {
        if (l.transactionHash == null || l.blockNumber == null || l.logIndex == null) continue // pending log
        // re-encode nothing: getLogs gives raw data too
        const s = decode(meta, {
          blockNumber: Number(l.blockNumber),
          logIndex: Number(l.logIndex),
          tx: l.transactionHash,
          ts: tsOf(Number(l.blockNumber)),
          data: l.data,
        })
        if (s) {
          s.pool = j.pool
          insertSwap(s)
          inserted++
        }
      }
    })
    bump(b - a + 1)
    await sleep(120) // gentle on the public RPC — ~110 windows for a 24h scan
  }
  return { inserted, reached: hi }
}

/** second pass: tx.from for wallet-level analytics, batched JSON-RPC.
 *  Public RPC only — Alchemy free tier 429s on CU throughput, and the public
 *  endpoint takes batches fine up to ~50 sub-calls (measured 2026-07-21).
 *  40-call chunks + backoff keep it under the limit. */
async function resolveTraders(pool: string): Promise<void> {
  const url = PUBLIC_RPC
  // time-capped: a 50k-swap pool would otherwise pin the (serial) job queue
  // for everyone. Unresolved rows stay null and the next job continues.
  const deadline = Date.now() + 4 * 60_000
  for (;;) {
    const hashes = swapTxsMissingTrader(pool, 2_000)
    if (!hashes.length) return
    let resolved = 0
    for (let i = 0; i < hashes.length && Date.now() < deadline; i += 40) {
      const chunk = hashes.slice(i, i + 40)
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              chunk.map((h, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionByHash', params: [h] })),
            ),
            // without this a single stalled POST eats the whole trader budget
            // (observed: 43k-swap job ended with 0 traders resolved)
            signal: AbortSignal.timeout(15_000),
          })
          if (!r.ok) throw new Error(`http ${r.status}`)
          const arr = (await r.json()) as { result?: { hash?: string; from?: string } }[]
          if (!Array.isArray(arr)) throw new Error('non-batch reply')
          tx(() => {
            for (const it of arr) {
              if (it?.result?.hash && it.result.from) {
                setSwapTrader(pool, it.result.hash.toLowerCase(), it.result.from.toLowerCase())
                resolved++
              }
            }
          })
          break
        } catch {
          await sleep(800 * (attempt + 1)) // 429/hiccup — rows stay null if all attempts fail
        }
      }
      await sleep(150)
    }
    if (!resolved || Date.now() >= deadline) return // refused or out of time — don't spin
  }
}

// ---- analytics (read path — pure SQL + JS over stored swaps) ----

const short = (a: string | null) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '?')

export function readVol(pool: string, hours: number): Record<string, unknown> {
  pool = pool.toLowerCase()
  const j = jobs.get(pool)
  const cov = getCov(pool)
  const metaRaw = kvGet(metaKey(pool))
  const status = j && (j.status === 'queued' || j.status === 'running') ? 'indexing' : cov ? 'ready' : (j?.status ?? 'unknown')
  const basePayload = {
    pool,
    hours,
    status,
    progress: j?.status === 'running' ? j.progress : j?.status === 'queued' ? 0 : 1,
    partial: j?.partial ?? false,
    error: j?.status === 'error' ? j.error : undefined,
    asof: now(),
  }
  if (!metaRaw || !cov) return basePayload

  const meta = JSON.parse(metaRaw) as VolMeta
  const quote = meta.quoteIs0 ? meta.t0 : meta.t1
  const [qRow] = tokenRows([quote])
  const qUsd = qRow?.price_usd ?? (quote === ANCHORS[1] ? 1 : null)
  const usdOk = qUsd != null && qUsd > 0

  const since = Math.max(now() - hours * 3_600, cov.ft)
  const rows = swapsFor(pool, since)

  const N_BUCKETS = 48
  const to = now()
  const from = to - hours * 3_600
  const bw = (hours * 3_600) / N_BUCKETS
  const buckets = Array.from({ length: N_BUCKETS }, (_, i) => ({
    ts: Math.round(from + i * bw),
    buy: 0,
    sell: 0,
    swaps: 0,
    price: null as number | null,
    traders: new Set<string>(),
  }))

  const val = (r: SwapRow) => (usdOk ? r.quote_amt * (qUsd as number) : r.quote_amt)
  let buy = 0
  let sell = 0
  const wallets = new Map<string, { buy: number; sell: number; n: number }>()
  const big: { ts: number; side: string; v: number; price: number | null; trader: string | null; tx: string }[] = []

  for (const r of rows) {
    if (r.ts < from) continue
    const v = val(r)
    const bi = Math.min(N_BUCKETS - 1, Math.max(0, Math.floor((r.ts - from) / bw)))
    const b = buckets[bi]
    b.swaps++
    b.price = r.price ?? b.price
    if (r.side === 'buy') {
      buy += v
      b.buy += v
    } else {
      sell += v
      b.sell += v
    }
    if (r.trader) {
      b.traders.add(r.trader)
      const w = wallets.get(r.trader) ?? { buy: 0, sell: 0, n: 0 }
      w[r.side as 'buy' | 'sell'] += v
      w.n++
      wallets.set(r.trader, w)
    }
    big.push({ ts: r.ts, side: r.side, v, price: r.price, trader: r.trader, tx: r.tx })
  }
  big.sort((a, b) => b.v - a.v)

  const total = buy + sell
  let cum = 0
  const outBuckets = buckets.map((b) => {
    cum += b.buy - b.sell
    return { ts: b.ts, buy: b.buy, sell: b.sell, swaps: b.swaps, price: b.price, traders: b.traders.size, cvd: cum }
  })

  const ranked = [...wallets.entries()]
    .map(([a, w]) => ({
      addr: a,
      short: short(a),
      buy: w.buy,
      sell: w.sell,
      total: w.buy + w.sell,
      n: w.n,
      share: total > 0 ? (w.buy + w.sell) / total : 0,
      churn: Math.max(w.buy, w.sell) > 0 ? Math.min(w.buy, w.sell) / Math.max(w.buy, w.sell) : 0,
    }))
    .sort((a, b) => b.total - a.total)
  // smart-money annotation — Birdeye leaderboard membership (empty w/o key)
  const pnlRows = walletPnlRows(ranked.slice(0, 10).map((w) => w.addr))
  const pnlOf = (a: string) => {
    const rows = pnlRows.filter((r) => r.address === a)
    const r = rows.find((x) => x.win === 'today') ?? rows[0]
    return r ? { win: r.win, rank: r.rank, pnl: r.pnl } : undefined
  }

  const top5Share = ranked.slice(0, 5).reduce((s, w) => s + w.share, 0)
  const churnShare = ranked.filter((w) => w.churn > 0.7 && w.total > total * 0.01).reduce((s, w) => s + w.share, 0)
  const swapsN = rows.filter((r) => r.ts >= from).length
  const traderless = rows.filter((r) => r.ts >= from && !r.trader).length

  // GMGN verdict on the base token (null until fetched / without key)
  const baseAddr = meta.quoteIs0 ? meta.t1 : meta.t0
  const sec = securityOf(baseAddr)

  return {
    ...basePayload,
    meta: {
      kind: meta.kind,
      base: meta.quoteIs0 ? meta.s1 : meta.s0,
      quote: meta.quoteIs0 ? meta.s0 : meta.s1,
      usd: usdOk,
      quoteUsd: qUsd,
    },
    security: sec
      ? {
          honeypot: sec.honeypot === 1,
          alert: sec.alert === 1,
          sellTax: sec.sell_tax,
          buyTax: sec.buy_tax,
          openSource: sec.open_source === 1,
          renounced: sec.renounced === 1,
          top10Rate: sec.top10_rate,
          known: sec.honeypot !== null,
        }
      : undefined,
    coverage: {
      fromTs: Math.max(cov.ft, from),
      toTs: cov.ct,
      // complete = old edge reaches the range AND the cursor is near-live
      complete: cov.ft <= from + 120 && now() - cov.ct < 300,
    },
    totals: {
      buy,
      sell,
      delta: buy - sell,
      total,
      swaps: swapsN,
      wallets: wallets.size,
      traderless,
      avgTrade: swapsN > 0 ? total / swapsN : 0,
      top5Share,
      churnShare,
      washy: top5Share > 0.6 || churnShare > 0.4,
    },
    buckets: outBuckets,
    topTraders: ranked.slice(0, 10).map((w) => ({ ...w, pnl: pnlOf(w.addr) })),
    bigTrades: big.slice(0, 10),
  }
}
