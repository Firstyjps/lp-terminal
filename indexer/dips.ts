// Dip detector — "which real tokens just dumped hard?" answered from our own
// data (price snapshots of trust-backed tokens), no external trending API.
// HOODRADAR's buy-the-dip idea, but on chain-derived prices with the fake-TVL
// trust layer already applied — a spoofed token never had trusted pricing, so
// it can't fake a dip here.
//
// Cycle (10 min): snapshot prices → scan for dumps → alert Telegram (12h
// cooldown per token) → prune old snaps. Results served at /api/dips.
import { log, now } from './config'
import {
  bestPoolOf,
  kvGet,
  kvSet,
  prunePriceSnaps,
  priceAt,
  snapshotPrices,
  trustedTokens,
} from './store'
import { sendTg, tgEnabled } from './watch'

const TUNE = {
  snapMinTrust: 500, // snapshot tokens with ≥ this price trust (keeps the table honest + small)
  scanMinTrust: 2_000, // only report dips on tokens with real anchored backing
  minPoolTvl: 15_000, // deepest non-sus pool must hold at least this (HOODRADAR's liq floor)
  drop1h: 0.2, // ≥20% down vs ~1h ago
  drop24h: 0.3, // ≥30% down vs ~24h ago
  keepDays: 7,
  alertCooldownSecs: 12 * 3_600,
  maxReport: 20,
}

export type Dip = {
  token: string
  symbol: string
  price: number
  drop1h: number | null // fraction, positive = down
  drop24h: number | null
  pool: string
  poolTvl: number
}

let latest: { asof: number; dips: Dip[] } = { asof: 0, dips: [] }
// survive restarts so /api/dips isn't empty until the first cycle
const saved = kvGet('dips_latest')
if (saved) {
  try {
    latest = JSON.parse(saved) as typeof latest
  } catch {
    /* rescanned within 10 min anyway */
  }
}

export const dipsLatest = () => latest

const pct = (x: number) => `${(x * 100).toFixed(0)}%`
const fmtPrice = (p: number) => (p >= 1 ? p.toFixed(2) : p.toPrecision(3))

function scan(): Dip[] {
  const t = now()
  const dips: Dip[] = []
  for (const tok of trustedTokens(TUNE.scanMinTrust)) {
    const p = tok.price_usd
    const p1h = priceAt(tok.address, t - 3_600, 900)
    const p24 = priceAt(tok.address, t - 86_400, 5_400)
    const d1 = p1h && p1h > 0 ? (p1h - p) / p1h : null
    const d24 = p24 && p24 > 0 ? (p24 - p) / p24 : null
    if (!((d1 !== null && d1 >= TUNE.drop1h) || (d24 !== null && d24 >= TUNE.drop24h))) continue
    const pool = bestPoolOf(tok.address)
    if (!pool || pool.tvl_usd < TUNE.minPoolTvl) continue
    dips.push({
      token: tok.address,
      symbol: tok.symbol,
      price: p,
      drop1h: d1,
      drop24h: d24,
      pool: pool.address,
      poolTvl: pool.tvl_usd,
    })
  }
  dips.sort((a, b) => (b.drop1h ?? b.drop24h ?? 0) - (a.drop1h ?? a.drop24h ?? 0))
  return dips.slice(0, TUNE.maxReport)
}

async function alert(dips: Dip[]): Promise<void> {
  if (!tgEnabled()) return
  const t = now()
  for (const d of dips) {
    const k = `dip_alert:${d.token}`
    if (t - Number(kvGet(k) ?? 0) < TUNE.alertCooldownSecs) continue
    kvSet(k, String(t))
    const drops = [
      d.drop1h !== null && d.drop1h >= TUNE.drop1h ? `−${pct(d.drop1h)} 1h` : null,
      d.drop24h !== null && d.drop24h >= TUNE.drop24h ? `−${pct(d.drop24h)} 24h` : null,
    ]
      .filter(Boolean)
      .join(' · ')
    await sendTg(
      `📉 <b>DIP</b> ${d.symbol} ${drops}\n` +
        `price $${fmtPrice(d.price)} · liq $${Math.round(d.poolTvl).toLocaleString('en-US')}\n` +
        `<code>${d.token}</code>\n` +
        `https://gmgn.ai/robinhood/token/${d.token}\n` +
        `alphast.xyz → POOLS → VOL เช็ค CVD ก่อนเข้า · DYOR`,
    )
  }
}

export async function dipCycle(): Promise<void> {
  const t = now()
  snapshotPrices(t, TUNE.snapMinTrust)
  const dips = scan()
  latest = { asof: t, dips }
  kvSet('dips_latest', JSON.stringify(latest))
  prunePriceSnaps(t - TUNE.keepDays * 86_400)
  if (dips.length) {
    log(`[dips] ${dips.length} token(s) dumping: ${dips.slice(0, 5).map((d) => d.symbol).join(' ')}`)
    await alert(dips)
  }
}
