// SQLite store (node:sqlite — built into node ≥22.13, zero dependencies).
// bigints are stored as TEXT and travel as strings through the API; REAL
// columns are display/ranking data only, never used to build transactions.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_PATH, now } from './config'

mkdirSync(dirname(DB_PATH), { recursive: true })
export const db = new DatabaseSync(DB_PATH)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS pools (
  address       TEXT PRIMARY KEY,          -- lowercase
  proto         TEXT NOT NULL,             -- 'univ2' | 'univ3'
  token0        TEXT NOT NULL,             -- lowercase
  token1        TEXT NOT NULL,
  fee_ppm       INTEGER NOT NULL,          -- univ2 fixed 3000 (0.30%)
  tick_spacing  INTEGER,                   -- univ3 only
  created_block INTEGER,                   -- univ3 only (from PoolCreated)
  pair_index    INTEGER,                   -- univ2 only (allPairs index)
  added_ts      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pools_t0 ON pools(token0);
CREATE INDEX IF NOT EXISTS idx_pools_t1 ON pools(token1);

CREATE TABLE IF NOT EXISTS tokens (
  address        TEXT PRIMARY KEY,
  symbol         TEXT NOT NULL DEFAULT '?',
  decimals       INTEGER NOT NULL DEFAULT 18,
  meta_ok        INTEGER NOT NULL DEFAULT 0, -- 0 = symbol/decimals defaulted (call reverted)
  price_usd      REAL,
  price_depth_usd REAL NOT NULL DEFAULT 0,   -- USD depth backing the price (bigger wins)
  price_src      TEXT,                       -- 'gt' | 'pool' | 'anchor'
  price_updated  INTEGER
);

CREATE TABLE IF NOT EXISTS pool_state (
  address      TEXT PRIMARY KEY,
  sqrt_price   TEXT,    -- univ3
  tick         INTEGER, -- univ3
  liquidity    TEXT,    -- univ3 in-range L
  reserve0     TEXT NOT NULL DEFAULT '0', -- univ2: reserves; univ3: erc20 balances (TVL basis)
  reserve1     TEXT NOT NULL DEFAULT '0',
  total_supply TEXT,    -- univ2 LP supply
  tvl_usd      REAL,
  tvl_approx   INTEGER NOT NULL DEFAULT 0, -- 1 = only one side priced (tvl = 2× that side)
  updated      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_tvl ON pool_state(tvl_usd);

CREATE TABLE IF NOT EXISTS pool_stats (
  address    TEXT PRIMARY KEY,
  vol24h_usd REAL,
  txns24h    INTEGER,
  liq_usd    REAL,     -- GT's own reserve figure (cross-check; tvl_usd is chain-derived)
  source     TEXT NOT NULL,
  updated    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);

-- position watcher (WATCH_ADDRESSES): last-known CL position state per NFT
CREATE TABLE IF NOT EXISTS watch_positions (
  owner          TEXT NOT NULL,             -- lowercase wallet
  npm            TEXT NOT NULL,             -- 'up33' | 'univ3' (which position manager)
  token_id       TEXT NOT NULL,             -- NFT id (bigint as text)
  pool           TEXT,                      -- lowercase pool address
  token0         TEXT, token1 TEXT,
  tick_lower     INTEGER, tick_upper       INTEGER,
  staked         INTEGER NOT NULL DEFAULT 0,
  liquidity      TEXT NOT NULL DEFAULT '0',
  in_range       INTEGER,                   -- last observed (NULL until first read)
  value_usd      REAL,
  fees_usd       REAL,                      -- uncollected (staked: earned UP value)
  collected_usd  REAL NOT NULL DEFAULT 0,   -- cumulative, inferred from fee drops
  first_ts       INTEGER NOT NULL,
  first_value_usd REAL,
  last_ts        INTEGER,
  closed         INTEGER NOT NULL DEFAULT 0,
  out_since      INTEGER,                   -- ts of the in->out transition
  alerted_fee    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner, npm, token_id)
);

-- periodic snapshots feeding the PnL panel (one row per position per ~5min)
CREATE TABLE IF NOT EXISTS position_snaps (
  ts        INTEGER NOT NULL,
  owner     TEXT NOT NULL,
  npm       TEXT NOT NULL,
  token_id  TEXT NOT NULL,
  liquidity TEXT,
  tick      INTEGER,
  in_range  INTEGER,
  amount0   TEXT, amount1 TEXT,
  fees0     TEXT, fees1  TEXT,
  earned_up TEXT,
  value_usd REAL, fees_usd REAL,
  PRIMARY KEY (owner, npm, token_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_snaps_ts ON position_snaps(ts);
`)

// additive migrations for DBs created before these columns existed
// (CREATE TABLE IF NOT EXISTS won't touch an existing table)
for (const mig of [
  // anchor-rooted price trust: min real (anchor/GT) depth along the propagation
  // chain that produced this price — spoof-proof, unlike price_depth_usd
  'ALTER TABLE tokens ADD COLUMN price_trust_usd REAL NOT NULL DEFAULT 0',
  // 1 = claimed TVL is not backed by trusted pricing (see state.ts reprice)
  'ALTER TABLE pool_state ADD COLUMN tvl_sus INTEGER NOT NULL DEFAULT 0',
  // raw uncollected amounts — collection detection compares these (exact),
  // never USD values (price swings would ratchet phantom "collections")
  'ALTER TABLE watch_positions ADD COLUMN fees0 TEXT',
  'ALTER TABLE watch_positions ADD COLUMN fees1 TEXT',
  'ALTER TABLE watch_positions ADD COLUMN earned_up TEXT',
]) {
  try {
    db.exec(mig)
  } catch {
    /* column already exists */
  }
}

// ---- kv ----
const kvGetQ = db.prepare('SELECT v FROM kv WHERE k = ?')
const kvSetQ = db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
export const kvGet = (k: string): string | undefined => (kvGetQ.get(k) as { v: string } | undefined)?.v
export const kvSet = (k: string, v: string) => void kvSetQ.run(k, v)

// ---- pools ----
const insPoolQ = db.prepare(`
  INSERT OR IGNORE INTO pools (address, proto, token0, token1, fee_ppm, tick_spacing, created_block, pair_index, added_ts)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
/** returns true when the pool is new */
export function insertPool(p: {
  address: string
  proto: 'univ2' | 'univ3'
  token0: string
  token1: string
  feePpm: number
  tickSpacing?: number
  createdBlock?: number
  pairIndex?: number
}): boolean {
  const r = insPoolQ.run(
    p.address.toLowerCase(),
    p.proto,
    p.token0.toLowerCase(),
    p.token1.toLowerCase(),
    p.feePpm,
    p.tickSpacing ?? null,
    p.createdBlock ?? null,
    p.pairIndex ?? null,
    now(),
  )
  return Number(r.changes) > 0
}

export type PoolRow = {
  address: string
  proto: 'univ2' | 'univ3'
  token0: string
  token1: string
  fee_ppm: number
  tick_spacing: number | null
}
const poolsByAddrQ = db.prepare('SELECT address, proto, token0, token1, fee_ppm, tick_spacing FROM pools WHERE address = ?')
export const poolRow = (addr: string) => poolsByAddrQ.get(addr.toLowerCase()) as PoolRow | undefined
export const allPoolAddrs = (): string[] =>
  (db.prepare('SELECT address FROM pools').all() as { address: string }[]).map((r) => r.address)
export const poolCounts = () =>
  db.prepare(`SELECT proto, COUNT(*) AS n FROM pools GROUP BY proto`).all() as { proto: string; n: number }[]

// ---- tokens ----
const insTokenQ = db.prepare(`
  INSERT INTO tokens (address, symbol, decimals, meta_ok) VALUES (?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET symbol = excluded.symbol, decimals = excluded.decimals, meta_ok = excluded.meta_ok`)
export const upsertTokenMeta = (addr: string, symbol: string, decimals: number, metaOk: boolean) =>
  void insTokenQ.run(addr.toLowerCase(), symbol, decimals, metaOk ? 1 : 0)

const priceQ = db.prepare(`
  INSERT INTO tokens (address, price_usd, price_depth_usd, price_trust_usd, price_src, price_updated) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET price_usd = excluded.price_usd, price_depth_usd = excluded.price_depth_usd,
    price_trust_usd = excluded.price_trust_usd, price_src = excluded.price_src, price_updated = excluded.price_updated`)
export const setTokenPrice = (addr: string, usd: number, depthUsd: number, trustUsd: number, src: string) =>
  void priceQ.run(addr.toLowerCase(), usd, depthUsd, trustUsd, src, now())

export type TokenRow = {
  address: string
  symbol: string
  decimals: number
  meta_ok: number
  price_usd: number | null
  price_depth_usd: number
  price_trust_usd: number
  price_src: string | null
  price_updated: number | null
}
export const allTokens = () => db.prepare('SELECT * FROM tokens').all() as TokenRow[]
export const missingMetaTokens = (): string[] =>
  (
    db
      .prepare(
        `SELECT DISTINCT u.addr FROM (SELECT token0 AS addr FROM pools UNION SELECT token1 FROM pools) u
         LEFT JOIN tokens t ON t.address = u.addr WHERE t.address IS NULL`,
      )
      .all() as { addr: string }[]
  ).map((r) => r.addr)

// ---- pool_state ----
const upStateQ = db.prepare(`
  INSERT INTO pool_state (address, sqrt_price, tick, liquidity, reserve0, reserve1, total_supply, updated)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET sqrt_price = excluded.sqrt_price, tick = excluded.tick,
    liquidity = excluded.liquidity, reserve0 = excluded.reserve0, reserve1 = excluded.reserve1,
    total_supply = excluded.total_supply, updated = excluded.updated`)
export const upsertState = (
  addr: string,
  s: { sqrtPrice?: bigint; tick?: number; liquidity?: bigint; reserve0: bigint; reserve1: bigint; totalSupply?: bigint },
) =>
  void upStateQ.run(
    addr.toLowerCase(),
    s.sqrtPrice !== undefined ? String(s.sqrtPrice) : null,
    s.tick ?? null,
    s.liquidity !== undefined ? String(s.liquidity) : null,
    String(s.reserve0),
    String(s.reserve1),
    s.totalSupply !== undefined ? String(s.totalSupply) : null,
    now(),
  )

const tvlQ = db.prepare('UPDATE pool_state SET tvl_usd = ?, tvl_approx = ?, tvl_sus = ? WHERE address = ?')
export const setTvl = (addr: string, tvl: number | null, approx: boolean, sus: boolean) =>
  void tvlQ.run(tvl, approx ? 1 : 0, sus ? 1 : 0, addr.toLowerCase())

// ---- pool_stats ----
const upStatsQ = db.prepare(`
  INSERT INTO pool_stats (address, vol24h_usd, txns24h, liq_usd, source, updated) VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(address) DO UPDATE SET vol24h_usd = excluded.vol24h_usd, txns24h = excluded.txns24h,
    liq_usd = excluded.liq_usd, source = excluded.source, updated = excluded.updated`)
export const upsertStats = (addr: string, vol24h: number | null, txns24h: number | null, liqUsd: number | null, source: string) =>
  void upStatsQ.run(addr.toLowerCase(), vol24h, txns24h, liqUsd, source, now())

/** hot set: real TVL, or GT-visible activity, or freshly created */
export const hotAddrs = (): string[] =>
  (
    db
      .prepare(
        `SELECT address FROM pool_state WHERE tvl_usd >= ?
         UNION SELECT address FROM pool_stats WHERE vol24h_usd > 0
         UNION SELECT address FROM pools WHERE added_ts > ?`,
      )
      .all(10_000, now() - 3_600) as { address: string }[]
  ).map((r) => r.address)

/**
 * active set for the hourly sweep: anything that ever showed ≥$100 TVL plus
 * everything younger than 48h. The launchpads mint ~20k dust pools/day — the
 * 6-hourly census (allPoolAddrs) keeps their state honest, the hourly sweep
 * stays bounded by real liquidity instead of catalog size.
 */
export const activeAddrs = (): string[] =>
  (
    db
      .prepare(
        `SELECT address FROM pool_state WHERE tvl_usd >= ?
         UNION SELECT address FROM pools WHERE added_ts > ?`,
      )
      .all(100, now() - 172_800) as { address: string }[]
  ).map((r) => r.address)

// ---- position watcher ----
export type WatchPosRow = {
  owner: string
  npm: 'up33' | 'univ3'
  token_id: string
  pool: string | null
  token0: string | null
  token1: string | null
  tick_lower: number | null
  tick_upper: number | null
  staked: number
  liquidity: string
  in_range: number | null
  value_usd: number | null
  fees_usd: number | null
  collected_usd: number
  first_ts: number
  first_value_usd: number | null
  last_ts: number | null
  closed: number
  out_since: number | null
  alerted_fee: number
  fees0: string | null
  fees1: string | null
  earned_up: string | null
}

const upWatchQ = db.prepare(`
  INSERT INTO watch_positions (owner, npm, token_id, pool, token0, token1, tick_lower, tick_upper,
    staked, liquidity, in_range, value_usd, fees_usd, collected_usd, first_ts, first_value_usd, last_ts,
    closed, out_since, alerted_fee, fees0, fees1, earned_up)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(owner, npm, token_id) DO UPDATE SET pool = excluded.pool,
    token0 = excluded.token0, token1 = excluded.token1,
    tick_lower = excluded.tick_lower, tick_upper = excluded.tick_upper,
    staked = excluded.staked, liquidity = excluded.liquidity, in_range = excluded.in_range,
    value_usd = excluded.value_usd, fees_usd = excluded.fees_usd, collected_usd = excluded.collected_usd,
    last_ts = excluded.last_ts, closed = excluded.closed, out_since = excluded.out_since,
    alerted_fee = excluded.alerted_fee, fees0 = excluded.fees0, fees1 = excluded.fees1,
    earned_up = excluded.earned_up`)
export const upsertWatchPos = (r: WatchPosRow) =>
  void upWatchQ.run(
    r.owner, r.npm, r.token_id, r.pool, r.token0, r.token1, r.tick_lower, r.tick_upper,
    r.staked, r.liquidity, r.in_range, r.value_usd, r.fees_usd, r.collected_usd,
    r.first_ts, r.first_value_usd, r.last_ts, r.closed, r.out_since, r.alerted_fee,
    r.fees0, r.fees1, r.earned_up,
  )

const watchByOwnerQ = db.prepare('SELECT * FROM watch_positions WHERE owner = ?')
export const watchPosByOwner = (owner: string) => watchByOwnerQ.all(owner.toLowerCase()) as WatchPosRow[]

export const insSnapQ = db.prepare(`
  INSERT OR REPLACE INTO position_snaps (ts, owner, npm, token_id, liquidity, tick, in_range,
    amount0, amount1, fees0, fees1, earned_up, value_usd, fees_usd)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)

const lastSnapQ = db.prepare(
  'SELECT MAX(ts) AS ts FROM position_snaps WHERE owner = ? AND npm = ? AND token_id = ?',
)
export const lastSnapTs = (owner: string, npm: string, id: string): number =>
  Number((lastSnapQ.get(owner, npm, id) as { ts: number | null }).ts ?? 0)

const snapsQ = db.prepare(`
  SELECT ts, liquidity, tick, in_range, amount0, amount1, fees0, fees1, earned_up, value_usd, fees_usd
  FROM position_snaps WHERE owner = ? AND npm = ? AND token_id = ? AND ts >= ? ORDER BY ts`)
export const snapsFor = (owner: string, npm: string, id: string, sinceTs: number) =>
  snapsQ.all(owner.toLowerCase(), npm, id, sinceTs) as Record<string, unknown>[]

export const pruneSnaps = (beforeTs: number): number =>
  Number(db.prepare('DELETE FROM position_snaps WHERE ts < ?').run(beforeTs).changes)

export const tokenRows = (addrs: string[]): TokenRow[] =>
  addrs.length
    ? (db
        .prepare(`SELECT * FROM tokens WHERE address IN (${addrs.map(() => '?').join(',')})`)
        .all(...addrs.map((a) => a.toLowerCase())) as TokenRow[])
    : []

export const tx = (fn: () => void) => {
  db.exec('BEGIN')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}
