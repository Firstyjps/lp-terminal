import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useChainTvl, useDexOverview, useFeesOverview, useStables } from '../../hooks/useChainAnalytics'
import type { SeriesPoint } from '../../lib/llama'
import { fmtCompact, fmtUsd } from '../../lib/format'

type Range = 30 | 90 | 0 // days shown in the charts; 0 = full history
type ProtoSort = 'vol24' | 'vol7' | 'fees24' | 'fees7'

const fmtUsdC = (x?: number | null) => (x == null || !Number.isFinite(x) ? '—' : '$' + fmtCompact(x))
const fmtChg = (x?: number | null) =>
  x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(1)}%`
const chgCls = (x?: number | null) =>
  x == null || !Number.isFinite(x) ? 'dim' : x >= 0 ? 'green' : 'red'
const day = (ts: number) => new Date(ts * 1000).toISOString().slice(5, 10) // MM-DD (UTC)

// ---- 7d trend insights, derived entirely from the already-fetched series ----
type Wow = { cur: number; prev: number; pct: number }
type Insights = {
  vol?: Wow
  fees?: Wow
  /** annualized fee yield on TVL, % — this week vs the week before */
  apr?: { cur: number; prev: number }
  /** effective fee rate, bps of volume — this week vs the week before */
  take?: { cur: number; prev: number }
  tvl?: { pct: number; flow: number; kind: 'new' | 'price' | 'out' }
  /** yesterday's volume vs the 30d daily mean (null = within normal range) */
  spike?: { v: number; x: number } | null
  lead?: { name: string; share: number; riser: string; delta: number }
}

const sumRange = (s: SeriesPoint[], from: number, to?: number) =>
  s.slice(from, to).reduce((a, p) => a + p[1], 0)

function wow(chart: SeriesPoint[]): Wow | undefined {
  // last point is the running (partial) UTC day — compare the 7 full days before
  // it against the 7 before those
  if (chart.length < 15) return undefined
  const cur = sumRange(chart, -8, -1)
  const prev = sumRange(chart, -15, -8)
  return prev > 0 ? { cur, prev, pct: ((cur - prev) / prev) * 100 } : undefined
}

function computeInsights(
  volC: SeriesPoint[],
  feeC: SeriesPoint[],
  tvlS: SeriesPoint[],
  stables: SeriesPoint[],
  breakdown: [number, Record<string, number>][],
  feesBreakdown: [number, Record<string, number>][],
  dexNames: Set<string>,
): Insights {
  const ins: Insights = { vol: wow(volC), fees: wow(feeC) }

  // APR / take rate use DEX fees only — the fees overview also counts
  // launchpads, mining games etc. whose fees never reach an LP
  const dexFeeC: SeriesPoint[] = feesBreakdown.map(([ts, byProto]) => [
    ts,
    Object.entries(byProto).reduce((a, [name, v]) => (dexNames.has(name) ? a + v : a), 0),
  ])
  const dexFees = wow(dexFeeC)

  const meanTvl = (from: number, to?: number) => {
    const s = tvlS.slice(from, to)
    return s.length ? s.reduce((a, p) => a + p[1], 0) / s.length : 0
  }
  if (dexFees && tvlS.length >= 14) {
    const t1 = meanTvl(-7)
    const t2 = meanTvl(-14, -7)
    if (t1 > 0 && t2 > 0)
      ins.apr = {
        cur: (dexFees.cur / t1) * (365 / 7) * 100,
        prev: (dexFees.prev / t2) * (365 / 7) * 100,
      }
  }
  if (ins.vol && dexFees && ins.vol.cur > 0 && ins.vol.prev > 0)
    ins.take = { cur: (dexFees.cur / ins.vol.cur) * 10_000, prev: (dexFees.prev / ins.vol.prev) * 10_000 }

  if (tvlS.length >= 8) {
    const last = tvlS[tvlS.length - 1][1]
    const ago = tvlS[tvlS.length - 8][1]
    const dTvl = last - ago
    let flow = 0
    if (stables.length >= 8) flow = stables[stables.length - 1][1] - stables[stables.length - 8][1]
    ins.tvl = {
      pct: ago > 0 ? (dTvl / ago) * 100 : 0,
      flow,
      kind: dTvl < 0 ? 'out' : flow >= 0.4 * dTvl ? 'new' : 'price',
    }
  }

  // volume anomaly: yesterday (last full day) vs the mean of the 30 days before it
  if (volC.length >= 10) {
    const yv = volC[volC.length - 2][1]
    const base = volC.slice(Math.max(0, volC.length - 32), -2)
    const mean = base.reduce((a, p) => a + p[1], 0) / base.length
    ins.spike = mean > 0 && yv >= 1.8 * mean ? { v: yv, x: yv / mean } : null
  }

  // 7d market share per protocol vs the week before → leader + fastest riser
  if (breakdown.length >= 15) {
    const share = (from: number, to: number) => {
      const acc: Record<string, number> = {}
      let tot = 0
      for (const [, byProto] of breakdown.slice(from, to))
        for (const [name, v] of Object.entries(byProto)) {
          acc[name] = (acc[name] ?? 0) + v
          tot += v
        }
      if (tot > 0) for (const k of Object.keys(acc)) acc[k] = (acc[k] / tot) * 100
      return acc
    }
    const cur = share(-8, -1)
    const prev = share(-15, -8)
    const names = Object.keys(cur)
    if (names.length) {
      const leader = names.reduce((a, b) => (cur[a] >= cur[b] ? a : b))
      const riser = names.reduce((a, b) =>
        cur[a] - (prev[a] ?? 0) >= cur[b] - (prev[b] ?? 0) ? a : b,
      )
      ins.lead = {
        name: leader,
        share: cur[leader],
        riser,
        delta: cur[riser] - (prev[riser] ?? 0),
      }
    }
  }
  return ins
}

/** trend marker: ▲/▼/― on a small threshold so noise reads as flat */
function Dir(props: { pct?: number; th?: number }) {
  const th = props.th ?? 2
  if (props.pct == null || !Number.isFinite(props.pct)) return <span className="dim">―</span>
  if (props.pct > th) return <span className="green">▲</span>
  if (props.pct < -th) return <span className="red">▼</span>
  return <span className="dim">―</span>
}

export function AnalyzeTab() {
  const { t } = useTranslation()
  const tvl = useChainTvl()
  const dex = useDexOverview()
  const fees = useFeesOverview()
  const stables = useStables()
  const [range, setRange] = useState<Range>(30)
  const [sort, setSort] = useState<ProtoSort>('vol24')

  const tvlSeries = useMemo(
    () => (tvl.data ?? []).map((p): SeriesPoint => [p.date, p.tvl]),
    [tvl.data],
  )
  const clip = (s: SeriesPoint[]) => (range === 0 ? s : s.slice(-range))

  // one protocol table out of the two overviews, merged by protocol name
  const protoRows = useMemo(() => {
    type Row = {
      name: string
      category?: string | null
      vol24?: number | null
      vol7?: number | null
      volChg?: number | null
      fees24?: number | null
      fees7?: number | null
    }
    const m = new Map<string, Row>()
    for (const p of dex.data?.protocols ?? [])
      m.set(p.name, {
        name: p.displayName ?? p.name,
        category: p.category,
        vol24: p.total24h,
        vol7: p.total7d,
        volChg: p.change_1d,
      })
    for (const p of fees.data?.protocols ?? []) {
      const r = m.get(p.name) ?? { name: p.displayName ?? p.name, category: p.category }
      r.fees24 = p.total24h
      r.fees7 = p.total7d
      m.set(p.name, r)
    }
    const key: Record<ProtoSort, (r: Row) => number> = {
      vol24: (r) => r.vol24 ?? -1,
      vol7: (r) => r.vol7 ?? -1,
      fees24: (r) => r.fees24 ?? -1,
      fees7: (r) => r.fees7 ?? -1,
    }
    return [...m.values()].sort((a, b) => key[sort](b) - key[sort](a))
  }, [dex.data, fees.data, sort])

  const ins = useMemo(() => {
    // every protocol in the *dexs* overview is a DEX — its fees are LP-side
    const dexNames = new Set<string>()
    for (const p of dex.data?.protocols ?? []) {
      dexNames.add(p.name)
      if (p.displayName) dexNames.add(p.displayName)
    }
    return computeInsights(
      dex.data?.totalDataChart ?? [],
      fees.data?.totalDataChart ?? [],
      tvlSeries,
      stables.data ?? [],
      dex.data?.totalDataChartBreakdown ?? [],
      fees.data?.totalDataChartBreakdown ?? [],
      dexNames,
    )
  }, [dex.data, fees.data, tvlSeries, stables.data])

  const loading = tvl.isLoading && dex.isLoading && fees.isLoading
  if (loading)
    return (
      <div className="dim">
        {t('an.loading')}
        <span className="spin">▮</span>
      </div>
    )
  const allFailed = tvl.isError && dex.isError && fees.isError
  if (allFailed) return <div className="red">{t('an.failed', { err: String(tvl.error).slice(0, 80) })}</div>

  const lastTvl = tvlSeries.length ? tvlSeries[tvlSeries.length - 1][1] : undefined
  const prevTvl = tvlSeries.length > 1 ? tvlSeries[tvlSeries.length - 2][1] : undefined
  const tvlChg = lastTvl != null && prevTvl ? ((lastTvl - prevTvl) / prevTvl) * 100 : undefined
  const lastStable = stables.data?.length ? stables.data[stables.data.length - 1][1] : undefined

  const th = (k: ProtoSort, label: string) => (
    <th
      className={`num sortable ${sort === k ? 'on' : ''}`}
      onClick={() => setSort(k)}
      title={t('an.sortTip')}
    >
      {label}
      {sort === k ? ' ▼' : ''}
    </th>
  )

  return (
    <div className="tab-fill">
      <div className="an-tiles">
        <Tile label={t('an.tvl')} value={fmtUsdC(lastTvl)} chg={tvlChg} chgLbl={t('an.chg1d')} />
        <Tile label={t('an.vol24')} value={fmtUsdC(dex.data?.total24h)} chg={dex.data?.change_1d} chgLbl={t('an.chg1d')} />
        <Tile label={t('an.fees24')} value={fmtUsdC(fees.data?.total24h)} chg={fees.data?.change_1d} chgLbl={t('an.chg1d')} />
        <Tile label={t('an.stables')} value={fmtUsdC(lastStable)} />
        <Tile label={t('an.vol7')} value={fmtUsdC(dex.data?.total7d)} sub={`${t('an.d30')} ${fmtUsdC(dex.data?.total30d)}`} />
        <Tile label={t('an.fees7')} value={fmtUsdC(fees.data?.total7d)} sub={`${t('an.d30')} ${fmtUsdC(fees.data?.total30d)}`} />
      </div>
      <div className="section-title">{t('an.insTitle')}</div>
      <div className="an-ins">
        {ins.vol && (
          <>
            <span className="k">{t('an.insVol')}</span>
            <span>
              <Dir pct={ins.vol.pct} /> <b className={chgCls(ins.vol.pct)}>{fmtChg(ins.vol.pct)}</b>{' '}
              {t('an.insWow', { cur: fmtUsdC(ins.vol.cur), prev: fmtUsdC(ins.vol.prev) })}
            </span>
          </>
        )}
        {ins.fees && (
          <>
            <span className="k">{t('an.insFees')}</span>
            <span>
              <Dir pct={ins.fees.pct} /> <b className={chgCls(ins.fees.pct)}>{fmtChg(ins.fees.pct)}</b>{' '}
              {t('an.insWow', { cur: fmtUsdC(ins.fees.cur), prev: fmtUsdC(ins.fees.prev) })}
            </span>
          </>
        )}
        {ins.apr && (
          <>
            <span className="k">{t('an.insApr')}</span>
            <span>
              <Dir pct={ins.apr.cur - ins.apr.prev} th={0.3} /> <b>{ins.apr.cur.toFixed(1)}%</b>{' '}
              {t('an.insAprTxt', { prev: ins.apr.prev.toFixed(1) })}
            </span>
          </>
        )}
        {ins.take && (
          <>
            <span className="k">{t('an.insTake')}</span>
            <span>
              <Dir pct={ins.take.cur - ins.take.prev} th={0.3} /> <b>{ins.take.cur.toFixed(1)}bps</b>{' '}
              {t('an.insTakeTxt', { prev: ins.take.prev.toFixed(1) })}
            </span>
          </>
        )}
        {ins.tvl && (
          <>
            <span className="k">{t('an.insTvl')}</span>
            <span>
              <Dir pct={ins.tvl.pct} /> <b className={chgCls(ins.tvl.pct)}>{fmtChg(ins.tvl.pct)}</b>{' '}
              {t('an.insTvlTxt', { flow: fmtUsdC(Math.abs(ins.tvl.flow)) })}{' '}
              <span className="dim">
                (
                {ins.tvl.kind === 'new'
                  ? t('an.insKindNew')
                  : ins.tvl.kind === 'price'
                    ? t('an.insKindPrice')
                    : t('an.insKindOut')}
                )
              </span>
            </span>
          </>
        )}
        {ins.spike !== undefined && (
          <>
            <span className="k">{t('an.insSpike')}</span>
            {ins.spike ? (
              <span className="amber">
                ! {t('an.insSpikeTxt', { v: fmtUsdC(ins.spike.v), x: ins.spike.x.toFixed(1) })}
              </span>
            ) : (
              <span className="dim">{t('an.insSpikeNone')}</span>
            )}
          </>
        )}
        {ins.lead && (
          <>
            <span className="k">{t('an.insLead')}</span>
            <span>
              <b>{ins.lead.name}</b> {t('an.insLeadTxt', { share: ins.lead.share.toFixed(0) })} ·{' '}
              {t('an.insRiser')} <b>{ins.lead.riser}</b>{' '}
              <span className={chgCls(ins.lead.delta)}>
                {ins.lead.delta >= 0 ? '+' : ''}
                {ins.lead.delta.toFixed(1)}pp
              </span>
            </span>
          </>
        )}
      </div>
      <div className="form-row">
        {([30, 90, 0] as const).map((r) => (
          <button key={r} className={`chip ${range === r ? 'on' : ''}`} onClick={() => setRange(r)}>
            {r === 30 ? t('an.r30') : r === 90 ? t('an.r90') : t('an.rAll')}
          </button>
        ))}
        {(tvl.isError || dex.isError || fees.isError) && (
          <span className="red mono-sm">
            {t('an.failed', { err: String(tvl.error ?? dex.error ?? fees.error).slice(0, 60) })}
          </span>
        )}
      </div>
      <div className="an-charts">
        <TermChart label={t('an.chTvl')} points={clip(tvlSeries)} kind="line" />
        <TermChart label={t('an.chVol')} points={clip(dex.data?.totalDataChart ?? [])} kind="bars" />
        <TermChart label={t('an.chFees')} points={clip(fees.data?.totalDataChart ?? [])} kind="bars" />
      </div>
      <div className="section-title">{t('an.protocols', { n: protoRows.length })}</div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('an.thProto')}</th>
              <th>{t('an.thCat')}</th>
              {th('vol24', t('an.thVol24'))}
              <th className="num">{t('an.thChg')}</th>
              {th('vol7', t('an.thVol7'))}
              {th('fees24', t('an.thFees24'))}
              {th('fees7', t('an.thFees7'))}
            </tr>
          </thead>
          <tbody>
            {protoRows.map((r) => (
              <tr key={r.name} className="rowhover">
                <td>{r.name}</td>
                <td className="dim">{r.category ?? '—'}</td>
                <td className="num">{fmtUsdC(r.vol24)}</td>
                <td className={`num ${chgCls(r.volChg)}`}>{fmtChg(r.volChg)}</td>
                <td className="num">{fmtUsdC(r.vol7)}</td>
                <td className="num">{fmtUsdC(r.fees24)}</td>
                <td className="num">{fmtUsdC(r.fees7)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="dim mono-sm" style={{ marginTop: 6 }}>
        {t('an.source')}
      </div>
    </div>
  )
}

function Tile(props: { label: string; value: string; chg?: number | null; chgLbl?: string; sub?: string }) {
  return (
    <div className="an-tile">
      <div className="lbl">{props.label}</div>
      <div className="val">{props.value}</div>
      {props.chg !== undefined && (
        <div className={`sub ${chgCls(props.chg)}`}>
          {fmtChg(props.chg)} {props.chgLbl}
        </div>
      )}
      {props.sub && <div className="sub dim">{props.sub}</div>}
    </div>
  )
}

// minimal terminal-styled chart: single series in the theme accent, recessive
// gridlines, crosshair + tooltip on hover. Axis text stays in --dim ink.
const CH_H = 150
const PAD = { t: 8, r: 8, b: 16, l: 8 }

function TermChart(props: { label: string; points: SeriesPoint[]; kind: 'line' | 'bars' }) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(0)
  const [hover, setHover] = useState<number | null>(null)

  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(el.clientWidth))
    ro.observe(el)
    setW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const pts = props.points
  const n = pts.length
  const innerW = Math.max(0, w - PAD.l - PAD.r)
  const innerH = CH_H - PAD.t - PAD.b
  const max = n ? Math.max(...pts.map((p) => p[1])) : 0
  const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * innerW : innerW / 2)
  const y = (v: number) => PAD.t + (max > 0 ? innerH * (1 - v / max) : innerH)

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!n) return
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    const i = Math.round(((px - PAD.l) / Math.max(1, innerW)) * (n - 1))
    setHover(Math.max(0, Math.min(n - 1, i)))
  }

  const hoverPt = hover != null && pts[hover] ? pts[hover] : null
  // keep the tooltip inside the panel: flip to the left past the midpoint
  const tipLeft = hoverPt ? x(hover!) : 0
  const flip = w > 0 && tipLeft > w / 2

  const barW = n > 0 ? Math.max(1, innerW / n - 2) : 0
  const xTicks = n > 1 ? [0, Math.floor((n - 1) / 2), n - 1] : n === 1 ? [0] : []

  return (
    <div className="an-chart" ref={wrapRef}>
      <div className="lbl">{props.label}</div>
      {n === 0 || w === 0 ? (
        <div className="dim mono-sm" style={{ height: CH_H, display: 'flex', alignItems: 'center' }}>
          —
        </div>
      ) : (
        <svg width={w} height={CH_H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {/* gridlines: top(max) / mid / baseline */}
          {[max, max / 2, 0].map((v, gi) => (
            <g key={gi}>
              <line x1={PAD.l} x2={PAD.l + innerW} y1={y(v)} y2={y(v)} className="an-grid" />
              {v > 0 && (
                // top label sits under its line so it never clips the panel edge
                <text x={PAD.l + 2} y={gi === 0 ? y(v) + 11 : y(v) - 3} className="an-axis">
                  ${fmtCompact(v)}
                </text>
              )}
            </g>
          ))}
          {props.kind === 'bars' ? (
            pts.map((p, i) => (
              <rect
                key={i}
                x={x(i) - barW / 2}
                y={y(p[1])}
                width={barW}
                height={Math.max(0, PAD.t + innerH - y(p[1]))}
                className={`an-bar ${hover === i ? 'hi' : ''}`}
              />
            ))
          ) : (
            <>
              <polygon
                className="an-area"
                points={`${x(0)},${PAD.t + innerH} ${pts.map((p, i) => `${x(i)},${y(p[1])}`).join(' ')} ${x(n - 1)},${PAD.t + innerH}`}
              />
              <polyline className="an-line" points={pts.map((p, i) => `${x(i)},${y(p[1])}`).join(' ')} />
            </>
          )}
          {xTicks.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={CH_H - 4}
              className="an-axis"
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
            >
              {day(pts[i][0])}
            </text>
          ))}
          {hoverPt && (
            <>
              <line x1={x(hover!)} x2={x(hover!)} y1={PAD.t} y2={PAD.t + innerH} className="an-cross" />
              {props.kind === 'line' && <circle cx={x(hover!)} cy={y(hoverPt[1])} r={3} className="an-dot" />}
            </>
          )}
        </svg>
      )}
      {hoverPt && (
        <div
          className="an-tip"
          style={flip ? { right: w - tipLeft + 6, top: PAD.t } : { left: tipLeft + 6, top: PAD.t }}
        >
          {day(hoverPt[0])} · {fmtUsd(hoverPt[1])}
        </div>
      )}
    </div>
  )
}
