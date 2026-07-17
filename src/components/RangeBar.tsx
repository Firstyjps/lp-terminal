import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { sqrtPriceToPrice, tickToPrice } from '../lib/clmath'
import { fmtNum } from '../lib/format'
import { Flash } from './Flash'

/**
 * The LP range bar:
 *   [lower price] ▕░░▓▓▓▓▓┃▓▓░░▏ [upper price]
 * - both ends are the position's price bounds
 * - the marker is the CURRENT pool price
 * - shows drift: % move to each bound, % position inside the range, and when
 *   out of range, the move needed to re-enter.
 * Marker position is linear in tick space; a padding zone on both sides makes
 * out-of-range drift visible instead of clamping at the border.
 */
export function RangeBar(props: {
  tickLower: number
  tickUpper: number
  tick: number
  sqrtPriceX96: bigint
  dec0: number
  dec1: number
  sym0: string
  sym1: string
  /** order mode: this position is a range order — out-of-range is the intended
   *  resting state, so relabel the status instead of alarming in red */
  order?: { fillFrac: number; sellSym: string; buySym: string }
}) {
  const { t } = useTranslation()
  // order mode defaults to the SELL token's price orientation ("fills as it rises")
  const [flipped, setFlipped] = useState(props.order ? props.order.sellSym === props.sym1 : false)
  const { tickLower, tickUpper, tick, sqrtPriceX96, dec0, dec1, sym0, sym1, order } = props

  // prices in token1-per-token0 orientation
  const pLower = tickToPrice(tickLower, dec0, dec1)
  const pUpper = tickToPrice(tickUpper, dec0, dec1)
  const pCur = sqrtPriceToPrice(sqrtPriceX96, dec0, dec1)

  // displayed orientation
  const dLower = flipped ? 1 / pUpper : pLower
  const dUpper = flipped ? 1 / pLower : pUpper
  const dCur = flipped ? 1 / pCur : pCur
  const base = flipped ? sym1 : sym0
  const quote = flipped ? sym0 : sym1

  // marker fraction, linear in ticks, padded 15% each side
  const width = tickUpper - tickLower
  const pad = Math.max(1, Math.round(width * 0.15))
  const lo = tickLower - pad
  const hi = tickUpper + pad
  let frac = (tick - lo) / (hi - lo)
  if (flipped) frac = 1 - frac
  const fracPct = Math.min(99.5, Math.max(0.5, frac * 100))
  const winLeft = (pad / (hi - lo)) * 100
  const winWidth = (width / (hi - lo)) * 100

  const inRange = tick >= tickLower && tick < tickUpper
  const posPct = ((tick - tickLower) / width) * 100
  const nearEdge = inRange && (posPct < 12 || posPct > 88)
  const tone = order ? '' : !inRange ? 'red' : nearEdge ? 'amber' : ''

  // phosphor trail: on a real price move, smear a decaying gradient over the
  // path the marker just glided across (oscilloscope persistence). Suppressed
  // on flip (display-space jump, price didn't move) and on sub-pixel jitter.
  const prevRef = useRef<{ pct: number; tick: number; flipped: boolean } | null>(null)
  const [trail, setTrail] = useState<{ left: number; width: number; rev: boolean; n: number } | null>(null)
  useEffect(() => {
    const prev = prevRef.current
    prevRef.current = { pct: fracPct, tick, flipped }
    if (!prev || prev.flipped !== flipped || prev.tick === tick) return
    const d = fracPct - prev.pct
    if (Math.abs(d) < 0.4) return
    setTrail((tr) => ({ left: Math.min(prev.pct, fracPct), width: Math.abs(d), rev: d < 0, n: (tr?.n ?? 0) + 1 }))
  }, [fracPct, tick, flipped])

  // out of range: a dashed excursion line from the window edge to the marker
  // makes "how far out" visible (glides with the marker). Not in order mode —
  // resting outside the band is the intended state there.
  const winRight = winLeft + winWidth
  const exc =
    !order && !inRange
      ? fracPct < winLeft
        ? { left: fracPct, width: winLeft - fracPct }
        : { left: winRight, width: Math.max(0, fracPct - winRight) }
      : null
  // near-edge: mark the threatened bound post amber (display-space side)
  const warnSide = !order && nearEdge ? ((posPct < 12) !== flipped ? ' warn-lo' : ' warn-hi') : ''

  // % price move (in displayed units) to each bound
  const toLeft = (dLower / dCur - 1) * 100
  const toRight = (dUpper / dCur - 1) * 100
  // band half-width, geometric: ±x% around mid
  const bandPct = (Math.sqrt(dUpper / dLower) - 1) * 100

  let statusText: string
  let statusTone: string
  if (order) {
    if (order.fillFrac >= 0.999) {
      statusText = t('rbar.orderFilled', { sym: order.buySym })
      statusTone = 'green'
    } else if (inRange || order.fillFrac > 0.001) {
      statusText = t('rbar.orderFilling', { pct: (order.fillFrac * 100).toFixed(1), sym: order.sellSym })
      statusTone = 'amber'
    } else {
      const need = fmtNum(dCur < dLower ? toLeft : Math.abs(toRight), 3)
      statusText = dCur < dLower ? t('rbar.orderWaitRise', { pct: need }) : t('rbar.orderWaitFall', { pct: need })
      statusTone = 'cyan'
    }
  } else if (inRange) {
    statusText = t('rbar.inRange', { pct: posPct.toFixed(1), band: fmtNum(bandPct, 3) })
    statusTone = nearEdge ? 'amber' : 'green'
  } else if (dCur < dLower) {
    statusText = t('rbar.outRise', { pct: fmtNum(toLeft, 3) })
    statusTone = 'red'
  } else {
    statusText = t('rbar.outFall', { pct: fmtNum(Math.abs(toRight), 3) })
    statusTone = 'red'
  }

  return (
    <div className="rbar-wrap">
      <div className="rbar">
        <span className="rbar-price">{fmtNum(dLower)}</span>
        <div
          className="rbar-track"
          title={t('rbar.ticksTip', { lo: tickLower, hi: tickUpper, tick })}
        >
          <div
            className={`rbar-window${!order && !inRange ? ' out' : ''}${warnSide}`}
            style={{ left: `${winLeft}%`, width: `${winWidth}%` }}
          />
          {trail && (
            <div
              key={trail.n}
              className={`rbar-trail${trail.rev ? ' rev' : ''} ${tone}`}
              style={{ left: `${trail.left}%`, width: `${trail.width}%` }}
            />
          )}
          {exc && exc.width > 0.2 && (
            <div className="rbar-exc" style={{ left: `${exc.left}%`, width: `${exc.width}%` }} />
          )}
          <div className={`rbar-marker ${tone}`} style={{ left: `${fracPct}%` }} />
        </div>
        <span className="rbar-price">{fmtNum(dUpper)}</span>
      </div>
      <div className="rbar-sub">
        <span className={!order && !inRange && dCur < dLower ? 'red' : 'dim'}>
          {toLeft >= 0 ? '+' : ''}
          {fmtNum(toLeft, 3)}% {t('rbar.toLow')}
        </span>
        <span>
          px{' '}
          <Flash v={dCur} arrow>
            <span className={tone || 'green'}>{fmtNum(dCur)}</span>
          </Flash>{' '}
          <span className="dim">
            {quote}/{base}
          </span>
          <button className="rbar-flip" title={t('rbar.flipTip')} onClick={() => setFlipped(!flipped)}>
            ⇄
          </button>
        </span>
        <span className={!order && !inRange && dCur > dUpper ? 'red' : 'dim'}>
          {t('rbar.fromHigh')} {toRight >= 0 ? '+' : ''}
          {fmtNum(toRight, 3)}%
        </span>
      </div>
      <div className="rbar-sub">
        <Flash v={order ? order.fillFrac : undefined} arrow>
          <span className={statusTone}>{statusText}</span>
        </Flash>
      </div>
    </div>
  )
}
