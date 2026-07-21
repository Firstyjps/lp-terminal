// Read-only HTTP API. Response shapes mirror the frontend's PoolsData /
// PoolStat structures so the POOLS tab maps rows 1:1 (bigints travel as
// strings). Served same-origin in production (nginx /api → this) and through
// the vite dev/preview proxy locally.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { aiEnabled, aiInsight } from './ai'
import { PORT, log, now } from './config'
import { db, kvGet, poolCounts, snapsFor, watchPosByOwner } from './store'
import { tgEnabled, watchAddrs, watchEnabled } from './watch'

const JSONH = { 'content-type': 'application/json; charset=utf-8' }

type Params = URLSearchParams

const PROTOS = new Set(['univ2', 'univ3'])
const HEX40 = /^0x[0-9a-f]{40}$/

function poolsWhere(params: Params): { where: string; args: (string | number)[] } {
  const clauses: string[] = []
  const args: (string | number)[] = []

  const proto = (params.get('proto') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => PROTOS.has(s))
  if (proto.length) {
    clauses.push(`p.proto IN (${proto.map(() => '?').join(',')})`)
    args.push(...proto)
  }

  const minTvl = Number(params.get('min_tvl'))
  if (Number.isFinite(minTvl) && minTvl > 0) {
    clauses.push('s.tvl_usd >= ?')
    args.push(minTvl)
  }

  const q = (params.get('q') ?? '').trim().toLowerCase()
  if (q) {
    if (HEX40.test(q)) {
      clauses.push('(p.address = ? OR p.token0 = ? OR p.token1 = ?)')
      args.push(q, q, q)
    } else if (q.includes('/')) {
      // pair search: "weth/usdg" — both sides must match (either orientation)
      const [a, b] = q.split('/', 2).map((s) => s.trim())
      const side = `SELECT address FROM tokens WHERE symbol LIKE ?`
      clauses.push(
        `((p.token0 IN (${side}) AND p.token1 IN (${side})) OR (p.token0 IN (${side}) AND p.token1 IN (${side})))`,
      )
      args.push(a + '%', b + '%', b + '%', a + '%')
    } else {
      const side = `SELECT address FROM tokens WHERE symbol LIKE ?`
      clauses.push(`(p.token0 IN (${side}) OR p.token1 IN (${side}))`)
      args.push(q + '%', q + '%')
    }
  }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', args }
}

const ORDER: Record<string, string> = {
  tvl: 'ORDER BY (s.tvl_usd IS NULL), s.tvl_usd DESC',
  vol: 'ORDER BY (st.vol24h_usd IS NULL), st.vol24h_usd DESC',
  created: 'ORDER BY (p.created_block IS NULL), p.created_block DESC, p.pair_index DESC',
}

type PoolOut = Record<string, unknown>

function getPools(params: Params) {
  const { where, args } = poolsWhere(params)
  const order = ORDER[params.get('sort') ?? 'tvl'] ?? ORDER.tvl
  const limit = Math.min(Math.max(Number(params.get('limit')) || 100, 1), 500)
  const offset = Math.min(Math.max(Number(params.get('offset')) || 0, 0), 20_000)

  const base = `FROM pools p LEFT JOIN pool_state s ON s.address = p.address LEFT JOIN pool_stats st ON st.address = p.address ${where}`
  const count = (db.prepare(`SELECT COUNT(*) AS n ${base}`).get(...args) as { n: number }).n
  const rows = db
    .prepare(
      `SELECT p.address, p.proto, p.token0, p.token1, p.fee_ppm, p.tick_spacing, p.created_block,
              s.sqrt_price, s.tick, s.liquidity, s.reserve0, s.reserve1, s.total_supply,
              s.tvl_usd, s.tvl_approx, s.tvl_sus, s.updated AS state_updated,
              st.vol24h_usd, st.txns24h, st.liq_usd, st.source AS stats_source
       ${base} ${order} LIMIT ? OFFSET ?`,
    )
    .all(...args, limit, offset) as Record<string, unknown>[]

  const tokenAddrs = new Set<string>()
  const pools: PoolOut[] = rows.map((r) => {
    tokenAddrs.add(r.token0 as string)
    tokenAddrs.add(r.token1 as string)
    return {
      proto: r.proto,
      address: r.address,
      token0: r.token0,
      token1: r.token1,
      feePpm: r.fee_ppm,
      tickSpacing: r.tick_spacing,
      createdBlock: r.created_block,
      sqrtPriceX96: r.sqrt_price,
      tick: r.tick,
      liquidity: r.liquidity,
      reserve0: r.reserve0 ?? '0',
      reserve1: r.reserve1 ?? '0',
      totalSupply: r.total_supply,
      tvlUsd: r.tvl_usd,
      tvlApprox: r.tvl_approx === 1,
      tvlSus: r.tvl_sus === 1,
      vol24hUsd: r.vol24h_usd,
      txns24h: r.txns24h,
      gtLiqUsd: r.liq_usd,
      statsSource: r.stats_source,
      stateUpdated: r.state_updated,
    }
  })

  const tokens: Record<string, unknown> = {}
  if (tokenAddrs.size) {
    const list = [...tokenAddrs]
    const trs = db
      .prepare(`SELECT address, symbol, decimals, price_usd FROM tokens WHERE address IN (${list.map(() => '?').join(',')})`)
      .all(...list) as { address: string; symbol: string; decimals: number; price_usd: number | null }[]
    for (const t of trs) tokens[t.address] = { address: t.address, symbol: t.symbol, decimals: t.decimals, priceUsd: t.price_usd }
  }

  const totals = Object.fromEntries(poolCounts().map((c) => [c.proto, c.n]))
  return { ready: kvGet('ready') === '1', asof: now(), totals, count, pools, tokens }
}

function getTokens(params: Params) {
  const q = (params.get('q') ?? '').trim().toLowerCase()
  if (!q) return { tokens: [] }
  const rows = HEX40.test(q)
    ? db.prepare('SELECT address, symbol, decimals, price_usd FROM tokens WHERE address = ?').all(q)
    : db
        .prepare(
          `SELECT t.address, t.symbol, t.decimals, t.price_usd,
                  (SELECT COUNT(*) FROM pools p WHERE p.token0 = t.address OR p.token1 = t.address) AS pools
           FROM tokens t WHERE t.symbol LIKE ? ORDER BY pools DESC LIMIT 20`,
        )
        .all(q + '%')
  return { tokens: rows }
}

function getHealth() {
  const totals = Object.fromEntries(poolCounts().map((c) => [c.proto, c.n]))
  const tokens = (db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number }).n
  const priced = (db.prepare('SELECT COUNT(*) AS n FROM tokens WHERE price_usd > 0').get() as { n: number }).n
  const tvl = (db.prepare('SELECT COUNT(*) AS n FROM pool_state WHERE tvl_usd IS NOT NULL').get() as { n: number }).n
  return {
    ready: kvGet('ready') === '1',
    asof: now(),
    pools: totals,
    tokens,
    pricedTokens: priced,
    tvlPools: tvl,
    v3Cursor: Number(kvGet('v3_cursor') ?? 0),
    v2Count: Number(kvGet('v2_count') ?? 0),
    rssMb: Math.round(process.memoryUsage.rss() / 1e6),
  }
}

/** watcher status + last-known rows. Position data is public on-chain anyway;
 *  rows are only returned for owners actually configured in WATCH_ADDRESSES. */
function getWatch(params: Params) {
  const owners = watchAddrs()
  const q = (params.get('owner') ?? '').trim().toLowerCase()
  const filtered = q ? owners.filter((o) => o === q) : owners
  const positions = filtered.flatMap((o) => watchPosByOwner(o))
  return {
    enabled: watchEnabled(),
    telegram: tgEnabled(),
    watched: q ? owners.includes(q) : undefined,
    asof: now(),
    positions,
  }
}

function getPosHistory(params: Params) {
  const owner = (params.get('owner') ?? '').trim().toLowerCase()
  const npm = (params.get('npm') ?? '').trim()
  const id = (params.get('id') ?? '').trim()
  if (!watchAddrs().includes(owner) || !['up33', 'univ3'].includes(npm) || !/^\d{1,78}$/.test(id)) {
    return { snaps: [] }
  }
  const days = Math.min(Math.max(Number(params.get('days')) || 30, 1), 365)
  return { snaps: snapsFor(owner, npm, id, now() - days * 86_400) }
}

export function startApi(): void {
  const srv = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const started = Date.now()
    try {
      const url = new URL(req.url ?? '/', 'http://indexer')
      if (req.method !== 'GET') {
        res.writeHead(405, JSONH)
        res.end('{"error":"GET only"}')
        return
      }
      let body: unknown
      let cache = 'public, max-age=10'
      if (url.pathname === '/api/pools') body = getPools(url.searchParams)
      else if (url.pathname === '/api/tokens') body = getTokens(url.searchParams)
      else if (url.pathname === '/api/watch') {
        body = getWatch(url.searchParams)
        cache = 'no-store'
      } else if (url.pathname === '/api/pos-history') {
        body = getPosHistory(url.searchParams)
        cache = 'no-store'
      }
      else if (url.pathname === '/api/health') {
        body = getHealth()
        cache = 'no-store'
      } else if (url.pathname === '/api/ai-insight') {
        // cached server-side completion — no user input reaches the model
        if (!aiEnabled()) {
          res.writeHead(503, JSONH)
          res.end('{"error":"ai disabled"}')
          return
        }
        body = await aiInsight()
        cache = 'public, max-age=300'
      } else {
        res.writeHead(404, JSONH)
        res.end('{"error":"not found"}')
        return
      }
      res.writeHead(200, { ...JSONH, 'cache-control': cache })
      res.end(JSON.stringify(body))
      if (Date.now() - started > 500) log(`[api] slow ${url.pathname} ${Date.now() - started}ms`)
    } catch (e) {
      res.writeHead(500, JSONH)
      res.end(JSON.stringify({ error: String(e) }))
    }
  })
  srv.listen(PORT, () => log(`[api] listening on :${PORT}`))
}
