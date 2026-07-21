// Per-pool volume microscope — the detail aggregate 24h numbers hide:
// buy/sell split + CVD, price from our own swap decode, wallet concentration
// and churn (wash) signals. Data: indexer /api/vol (on-demand Swap-log
// backfill; first open shows an indexing progress line, then live tail).
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { EXPLORER } from '../config/addresses'
import { fmtCompact, fmtNum, fmtPct } from '../lib/format'
import { useVol, type VolBucket, type VolData } from '../hooks/useVol'

const HOURS: { h: number; lbl: string }[] = [
  { h: 6, lbl: '6H' },
  { h: 24, lbl: '24H' },
  { h: 72, lbl: '3D' },
]

export function VolPanel(props: { pool: string; kind: 'cl' | 'v2' | 'v2s' }) {
  const { t } = useTranslation()
  const [hours, setHours] = useState(24)
  const vol = useVol(props.pool, hours, props.kind)
  const d = vol.data
  const tot = d?.totals
  const usd = d?.meta?.usd ?? false
  const quote = d?.meta?.quote ?? ''
  const money = (v: number) => (usd ? '$' + fmtCompact(v) : `${fmtCompact(v)} ${quote}`)

  return (
    <div className="vol-panel">
      <div className="form-row">
        {HOURS.map((r) => (
          <button key={r.h} className={`chip ${hours === r.h ? 'on' : ''}`} onClick={() => setHours(r.h)}>
            {r.lbl}
          </button>
        ))}
        {d?.status === 'indexing' && (
          <span className="amber mono-sm">
            {t('vol.indexing', { pct: Math.round((d.progress ?? 0) * 100) })}
            <span className="spin">▮</span>
          </span>
        )}
        {d?.status === 'error' && <span className="red mono-sm">{t('vol.failed', { err: d.error ?? '?' })}</span>}
        {vol.isError && <span className="red mono-sm">{t('vol.failed', { err: String(vol.error).slice(0, 60) })}</span>}
        {d?.partial && <span className="dim mono-sm">{t('vol.partial')}</span>}
      </div>

      {tot && d?.buckets ? (
        <>
          <div className="an-tiles vol-tiles">
            <Tile label={t('vol.tVol')} value={money(tot.total)} sub={`${t('vol.buy')} ${money(tot.buy)} · ${t('vol.sell')} ${money(tot.sell)}`} />
            <Tile
              label={t('vol.tNet')}
              value={(tot.delta >= 0 ? '+' : '−') + money(Math.abs(tot.delta))}
              cls={tot.delta >= 0 ? 'green' : 'red'}
              sub={t('vol.tNetSub')}
            />
            <Tile label={t('vol.tTrades')} value={String(tot.swaps)} sub={t('vol.avg', { v: money(tot.avgTrade) })} />
            <Tile
              label={t('vol.tWallets')}
              value={String(tot.wallets)}
              sub={tot.traderless > 0 ? t('vol.traderless', { n: tot.traderless }) : t('vol.tWalletsSub')}
            />
            <Tile
              label={t('vol.tTop5')}
              value={fmtPct(tot.top5Share * 100, 0)}
              cls={tot.washy ? 'red' : undefined}
              sub={t('vol.churn', { v: fmtPct(tot.churnShare * 100, 0) }) + (tot.washy ? ` · ${t('vol.washy')}` : '')}
            />
          </div>
          <div className="vol-charts">
            <VolChart mode="price" label={t('vol.chPrice', { quote })} buckets={d.buckets} money={money} />
            <VolChart mode="flow" label={t('vol.chFlow')} buckets={d.buckets} money={money} />
          </div>
          <div className="vol-tables">
            <div>
              <div className="section-title">{t('vol.topTraders')}</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('vol.thWallet')}</th>
                    <th className="num">{t('vol.thTotal')}</th>
                    <th className="num">{t('vol.thBuy')}</th>
                    <th className="num">{t('vol.thSell')}</th>
                    <th className="num">{t('vol.thShare')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.topTraders ?? []).slice(0, 8).map((w) => (
                    <tr key={w.addr} className="rowhover">
                      <td className="mono-sm">
                        <a href={`${EXPLORER}/address/${w.addr}`} target="_blank" rel="noreferrer">
                          {w.short}
                        </a>
                        {w.churn > 0.7 && (
                          <span className="amber" title={t('vol.churnTip')}>
                            {' '}
                            ⇄
                          </span>
                        )}
                      </td>
                      <td className="num">{money(w.total)}</td>
                      <td className="num green">{money(w.buy)}</td>
                      <td className="num red">{money(w.sell)}</td>
                      <td className="num">{fmtPct(w.share * 100, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div>
              <div className="section-title">{t('vol.bigTrades')}</div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>{t('vol.thTime')}</th>
                    <th>{t('vol.thSide')}</th>
                    <th className="num">{t('vol.thValue')}</th>
                    <th className="num">{t('vol.thPrice')}</th>
                    <th>{t('vol.thWallet')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(d.bigTrades ?? []).slice(0, 8).map((x) => (
                    <tr key={x.tx + x.ts} className="rowhover">
                      <td className="mono-sm dim">{hhmm(x.ts, hours)}</td>
                      <td className={x.side === 'buy' ? 'green' : 'red'}>
                        {x.side === 'buy' ? t('vol.buy') : t('vol.sell')}
                      </td>
                      <td className="num">{money(x.v)}</td>
                      <td className="num mono-sm">{x.price != null ? fmtNum(x.price, 4) : '—'}</td>
                      <td className="mono-sm">
                        <a href={`${EXPLORER}/tx/${x.tx}`} target="_blank" rel="noreferrer">
                          {x.trader ? x.trader.slice(0, 6) + '…' + x.trader.slice(-4) : '↗'}
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="dim mono-sm" style={{ marginTop: 4 }}>
            {t('vol.source', { since: hhmm(d.coverage?.fromTs ?? 0, 72), quote })}
            {!d.coverage?.complete && ` · ${t('vol.coverageShort')}`}
          </div>
        </>
      ) : (
        <div className="dim mono-sm" style={{ padding: '12px 0' }}>
          {vol.isLoading || d?.status === 'indexing' ? t('vol.firstLoad') : t('vol.noData')}
        </div>
      )}
    </div>
  )
}

const hhmm = (ts: number, hours: number) => {
  const dt = new Date(ts * 1000)
  const hm = dt.toTimeString().slice(0, 5)
  return hours > 24 ? `${dt.getDate()}/${dt.getMonth() + 1} ${hm}` : hm
}

function Tile(props: { label: string; value: string; sub?: string; cls?: string }) {
  return (
    <div className="an-tile">
      <div className="lbl">{props.label}</div>
      <div className={`val ${props.cls ?? ''}`}>{props.value}</div>
      {props.sub && <div className="sub dim">{props.sub}</div>}
    </div>
  )
}

// terminal-styled SVG chart: 'price' = line over swap-derived prices,
// 'flow' = diverging buy(↑)/sell(↓) bars with the CVD line overlaid
const CH_H = 150
const PAD = { t: 8, r: 8, b: 16, l: 8 }

function VolChart(props: {
  mode: 'price' | 'flow'
  label: string
  buckets: VolBucket[]
  money: (v: number) => string
}) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    // clientWidth minus .an-chart horizontal padding (8+8) — an svg sized to
    // clientWidth would overflow the box and, inside a <td>, feed the table's
    // min-content width back into the next measurement
    const ro = new ResizeObserver(() => setW(Math.max(0, el.clientWidth - 16)))
    ro.observe(el)
    setW(Math.max(0, el.clientWidth - 16))
    return () => ro.disconnect()
  }, [])

  const pts = props.buckets
  const n = pts.length
  const innerW = Math.max(0, w - PAD.l - PAD.r)
  const innerH = CH_H - PAD.t - PAD.b
  const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2)
  const barW = n > 0 ? Math.max(1, innerW / n - 1) : 0

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!n) return
    const rect = e.currentTarget.getBoundingClientRect()
    const i = Math.round((((e.clientX - rect.left) - PAD.l) / Math.max(1, innerW)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }
  const hv = hover != null ? pts[hover] : null
  const flip = w > 0 && hover != null && x(hover) > w / 2

  let body: React.ReactNode = null
  let hoverText = ''
  if (props.mode === 'price') {
    const prices: [number, number][] = []
    let lastP: number | null = null
    pts.forEach((b, i) => {
      if (b.price != null) lastP = b.price
      if (lastP != null) prices.push([i, lastP])
    })
    const vals = prices.map((p) => p[1])
    const lo = vals.length ? Math.min(...vals) : 0
    const hiV = vals.length ? Math.max(...vals) : 1
    const y = (v: number) => PAD.t + (hiV > lo ? innerH * (1 - (v - lo) / (hiV - lo)) : innerH / 2)
    body = (
      <>
        {[hiV, (hiV + lo) / 2, lo].map((v, gi) => (
          <g key={gi}>
            <line x1={PAD.l} x2={PAD.l + innerW} y1={y(v)} y2={y(v)} className="an-grid" />
            <text x={PAD.l + 2} y={gi === 0 ? y(v) + 11 : y(v) - 3} className="an-axis">
              {fmtNum(v, 4)}
            </text>
          </g>
        ))}
        {prices.length > 1 && (
          <polyline className="an-line" points={prices.map((p) => `${x(p[0])},${y(p[1])}`).join(' ')} />
        )}
      </>
    )
    if (hv) hoverText = hv.price != null ? fmtNum(hv.price, 5) : '—'
  } else {
    const maxBar = Math.max(1e-12, ...pts.map((b) => Math.max(b.buy, b.sell)))
    const half = innerH / 2
    const mid = PAD.t + half
    const cvds = pts.map((b) => b.cvd)
    const cvdMax = Math.max(1e-12, ...cvds.map((v) => Math.abs(v)))
    const yc = (v: number) => mid - (v / cvdMax) * (half - 4)
    body = (
      <>
        <line x1={PAD.l} x2={PAD.l + innerW} y1={mid} y2={mid} className="an-grid" />
        <text x={PAD.l + 2} y={PAD.t + 11} className="an-axis">
          {props.money(maxBar)}
        </text>
        {pts.map((b, i) => (
          <g key={i}>
            {b.buy > 0 && (
              <rect
                x={x(i) - barW / 2}
                y={mid - (b.buy / maxBar) * (half - 2)}
                width={barW}
                height={(b.buy / maxBar) * (half - 2)}
                className={`vol-buy ${hover === i ? 'hi' : ''}`}
              />
            )}
            {b.sell > 0 && (
              <rect
                x={x(i) - barW / 2}
                y={mid}
                width={barW}
                height={(b.sell / maxBar) * (half - 2)}
                className={`vol-sell ${hover === i ? 'hi' : ''}`}
              />
            )}
          </g>
        ))}
        <polyline className="vol-cvd" points={pts.map((b, i) => `${x(i)},${yc(b.cvd)}`).join(' ')} />
      </>
    )
    if (hv)
      hoverText = `▲${props.money(hv.buy)} ▼${props.money(hv.sell)} · cvd ${hv.cvd >= 0 ? '+' : '−'}${props.money(Math.abs(hv.cvd))} · ${hv.swaps} tx`
  }

  return (
    <div className="an-chart" ref={wrapRef}>
      <div className="lbl">{props.label}</div>
      {n === 0 || w === 0 ? (
        <div className="dim mono-sm" style={{ height: CH_H, display: 'flex', alignItems: 'center' }}>
          —
        </div>
      ) : (
        <svg width={w} height={CH_H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {body}
          {hv && <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + innerH} className="an-cross" />}
          {[0, Math.floor((n - 1) / 2), n - 1].map((i) => (
            <text
              key={i}
              x={x(i)}
              y={CH_H - 4}
              className="an-axis"
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            >
              {hhmm(pts[i].ts, (pts[n - 1].ts - pts[0].ts) / 3600)}
            </text>
          ))}
        </svg>
      )}
      {hv && (
        <div className="an-tip mono-sm" style={flip ? { right: w - x(hover!) + 6 } : { left: x(hover!) + 6 }}>
          {hhmm(hv.ts, (pts[n - 1].ts - pts[0].ts) / 3600)} · {hoverText}
        </div>
      )}
    </div>
  )
}
