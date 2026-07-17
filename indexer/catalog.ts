// Pool catalog — the authoritative list, built ONLY from the official
// factories themselves (events / enumeration). Third-party APIs never admit a
// pool here, they only enrich pools that already exist (spoofing is therefore
// structural­ly impossible: a fork pool is simply never in the table).
//
//   univ3: PoolCreated logs. Backfill via Blockscout's etherscan-style getLogs
//          (no block-range cap, 1000/page, fromBlock-cursor pagination —
//          measured ~22 pages for the full 21,979-pool history), then a plain
//          RPC getLogs tail in ≤9k-block windows (Alchemy caps at 10k).
//   univ2: the factory keeps an allPairs array — enumeration IS the catalog.
//          Backfill and tail are the same code path: read allPairsLength,
//          fetch any indices we haven't seen.
import { parseAbiItem, toEventSelector } from 'viem'
import { uniV2FactoryAbi, uniV2PairAbi } from '../src/abi'
import { BLOCKSCOUT, log, sleep, UNI } from './config'
import { mc, ok, pc } from './rpc'
import { insertPool, kvGet, kvSet, tx } from './store'

const POOL_CREATED = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)',
)
const POOL_CREATED_TOPIC = toEventSelector(POOL_CREATED)

const hexInt = (x: string | number) => (typeof x === 'number' ? x : parseInt(x, 16))
const addrOfTopic = (t: string) => ('0x' + t.slice(-40)).toLowerCase()

async function bsJson(url: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'up33-lp-indexer/0.1' },
      })
      const text = await r.text()
      if (text.trim()) return JSON.parse(text)
    } catch {
      /* retry below */
    }
    await sleep(1_200 * (i + 1))
  }
  throw new Error('blockscout: no response after retries')
}

type BsLog = { topics: string[]; data: string; blockNumber: string }

/**
 * One-time full-history PoolCreated scan (resumable via the v3_cursor kv).
 * Primary source is Blockscout (no range cap, ~22 pages for full history);
 * if it flakes persistently the scan falls back to windowed RPC getLogs from
 * the same cursor — slower (~1.2k windows) but unconditionally available.
 */
export async function backfillV3(): Promise<number> {
  if (kvGet('v3_backfilled')) return 0
  let cursor = Number(kvGet('v3_cursor') ?? 0)
  let added = 0
  let flakes = 0
  // INDEXER_BACKFILL=rpc skips Blockscout entirely — useful when it throttles
  // (observed 2026-07-16: page pace degraded 1min → 6min mid-backfill). With a
  // private RPC the windowed scan is deterministic (~770 windows for full
  // history) and resumes from the same cursor.
  if (process.env.INDEXER_BACKFILL === 'rpc') {
    log(`[catalog] v3 backfill via RPC windows from blk ${cursor} (INDEXER_BACKFILL=rpc)`)
    const head = Number(await pc.getBlockNumber())
    added = (await scanV3Windows(cursor, head)).length
    kvSet('v3_cursor', String(head))
    kvSet('v3_backfilled', '1')
    return added
  }
  for (;;) {
    const j = await bsJson(
      `${BLOCKSCOUT}/api?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=latest&address=${UNI.V3_FACTORY}&topic0=${POOL_CREATED_TOPIC}`,
    ).catch(() => ({ status: '0', message: 'no response' }) as Record<string, unknown>)
    if (j.status !== '1') {
      if (/no records/i.test(String(j.message))) break
      if (++flakes >= 6) {
        // Blockscout is down/unhappy — finish the remaining range over RPC
        log(`[catalog] blockscout flaking ("${j.message}") — RPC-window fallback from blk ${cursor}`)
        const head = Number(await pc.getBlockNumber())
        added += (await scanV3Windows(cursor, head)).length
        kvSet('v3_cursor', String(head))
        break
      }
      await sleep(2_000 * flakes)
      continue
    }
    flakes = 0
    const logs = j.result as BsLog[]
    tx(() => {
      for (const l of logs) {
        // topics: [sig, token0, token1, fee]; data: [tickSpacing:int24, pool:address]
        const tickSpacing = Number(BigInt.asIntN(24, BigInt('0x' + l.data.slice(2, 66))))
        if (
          insertPool({
            address: addrOfTopic(l.data.slice(66, 130)),
            proto: 'univ3',
            token0: addrOfTopic(l.topics[1]),
            token1: addrOfTopic(l.topics[2]),
            feePpm: hexInt(l.topics[3]),
            tickSpacing,
            createdBlock: hexInt(l.blockNumber),
          })
        )
          added++
      }
    })
    const last = hexInt(logs[logs.length - 1].blockNumber)
    kvSet('v3_cursor', String(last))
    log(`[catalog] v3 backfill +${added} pools (cursor blk ${last})`)
    if (logs.length < 1000) break
    cursor = last // overlap the last block; PK dedupes
    await sleep(300)
  }
  kvSet('v3_backfilled', '1')
  return added
}

/** windowed RPC getLogs scan (≤9k blocks per request — under Alchemy's 10k cap) */
async function scanV3Windows(from: number, to: number): Promise<string[]> {
  const fresh: string[] = []
  let logged = 0
  for (let lo = from; lo <= to; lo += 9_001) {
    const hi = Math.min(lo + 9_000, to)
    const logs = await pc.getLogs({
      address: UNI.V3_FACTORY,
      event: POOL_CREATED,
      fromBlock: BigInt(lo),
      toBlock: BigInt(hi),
    })
    for (const l of logs) {
      const a = l.args
      if (!a.pool || !a.token0 || !a.token1 || a.fee === undefined || a.tickSpacing === undefined) continue
      if (
        insertPool({
          address: a.pool.toLowerCase(),
          proto: 'univ3',
          token0: a.token0,
          token1: a.token1,
          feePpm: a.fee,
          tickSpacing: a.tickSpacing,
          createdBlock: Number(l.blockNumber),
        })
      )
        fresh.push(a.pool.toLowerCase())
    }
    if (to - from > 100_000 && ++logged % 100 === 0)
      log(`[catalog] rpc scan blk ${hi}/${to} (+${fresh.length})`)
  }
  return fresh
}

/** RPC tail from the stored cursor to head; returns newly added pool addresses */
export async function tailV3(): Promise<string[]> {
  const head = Number(await pc.getBlockNumber())
  const from = Math.max(0, Number(kvGet('v3_cursor') ?? head - 2_000) - 120) // ~12s overlap
  const fresh = await scanV3Windows(from, head)
  kvSet('v3_cursor', String(head))
  return fresh
}

/**
 * univ2 catalog sync (backfill == tail): fetch allPairs indices we haven't
 * seen yet. The cursor only advances past indices that fully resolved, so a
 * partial multicall failure is retried on the next tick.
 */
export async function syncV2(): Promise<string[]> {
  const count = Number(
    await pc.readContract({ abi: uniV2FactoryAbi, address: UNI.V2_FACTORY, functionName: 'allPairsLength' }),
  )
  let known = Number(kvGet('v2_count') ?? 0)
  if (count <= known) return []
  const fresh: string[] = []
  while (known < count) {
    const n = Math.min(2_000, count - known) // 2k pairs per round = 5 + 10 aggregates
    const idx = Array.from({ length: n }, (_, i) => known + i)
    const pairRes = await mc(
      idx.map((i) => ({ abi: uniV2FactoryAbi, address: UNI.V2_FACTORY, functionName: 'allPairs', args: [BigInt(i)] })),
    )
    const pairs: string[] = []
    for (const r of pairRes) {
      const a = ok<string>(r)
      if (!a) break // stop at first failure — cursor advances only past successes
      pairs.push(a)
    }
    if (!pairs.length) break
    const tokRes = await mc(
      pairs.flatMap((p) => [
        { abi: uniV2PairAbi, address: p as `0x${string}`, functionName: 'token0' },
        { abi: uniV2PairAbi, address: p as `0x${string}`, functionName: 'token1' },
      ]),
    )
    let done = 0
    tx(() => {
      for (let i = 0; i < pairs.length; i++) {
        const t0 = ok<string>(tokRes[i * 2])
        const t1 = ok<string>(tokRes[i * 2 + 1])
        if (!t0 || !t1) break
        if (
          insertPool({
            address: pairs[i].toLowerCase(),
            proto: 'univ2',
            token0: t0,
            token1: t1,
            feePpm: 3_000, // vanilla v2: fixed 0.30%
            pairIndex: known + i,
          })
        )
          fresh.push(pairs[i].toLowerCase())
        done++
      }
    })
    if (!done) break
    known += done
    kvSet('v2_count', String(known))
    if (known < count) log(`[catalog] v2 sync ${known}/${count}`)
  }
  return fresh
}
