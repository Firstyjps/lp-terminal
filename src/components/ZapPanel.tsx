// ZAP panel — fund a position with ONE token. Shared by POOLS (mint/add) and
// POSITIONS (increase): the parent picks the target, this panel solves the
// split, previews it, and walks the tx sequence. See lib/zap.ts for the math.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { formatUnits, parseUnits, type Address } from 'viem'
import { ADDR } from '../config/addresses'
import { simulateClAdd, simulateV2Add, fmtApr } from '../lib/apr'
import { applySlippage } from '../lib/clmath'
import { fmtAmount, fmtUsd } from '../lib/format'
import { NATIVE } from '../lib/kyber'
import { txlog } from '../lib/txlog'
import { executeZap, planZap, zapStages, type ZapPlan, type ZapTarget } from '../lib/zap'
import { useBalances } from '../hooks/useBalances'
import type { PoolStat } from '../lib/poolstats'
import type { TokenInfo } from '../types'
import { Btn, NumInput } from './ui'

const ETH_GAS_BUFFER = parseUnits('0.001', 18)

export function ZapPanel(props: {
  target: ZapTarget
  t0: TokenInfo
  t1: TokenInfo
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}) {
  const { target, t0, t1 } = props
  const { t } = useTranslation()
  const pool = target.pool
  const { address: user } = useAccount()

  const hasWeth = [t0.address.toLowerCase(), t1.address.toLowerCase()].includes(ADDR.WETH.toLowerCase())
  const wethIs0 = t0.address.toLowerCase() === ADDR.WETH.toLowerCase()
  const [sel, setSel] = useState<'0' | '1' | 'eth'>(hasWeth ? (wethIs0 ? '0' : '1') : '0')
  const [amtStr, setAmtStr] = useState('')
  const [amount, setAmount] = useState(0n)
  const [slip, setSlip] = useState(100)
  const [running, setRunning] = useState(false)
  const [runAt, setRunAt] = useState<{ i: number; failed: boolean } | null>(null)
  const [runPlan, setRunPlan] = useState<ZapPlan | null>(null)
  const [done, setDone] = useState(false)

  const tokenInAddr: Address = sel === 'eth' ? NATIVE : sel === '0' ? t0.address : t1.address
  const tIn: TokenInfo =
    sel === 'eth' ? { address: NATIVE, symbol: 'ETH', decimals: 18, native: true } : sel === '0' ? t0 : t1

  useEffect(() => {
    const h = setTimeout(() => {
      try {
        setAmount(parseUnits(amtStr === '' ? '0' : amtStr, tIn.decimals))
      } catch {
        setAmount(0n)
      }
    }, 350)
    return () => clearTimeout(h)
  }, [amtStr, tIn.decimals])

  const bal = useBalances(user, [t0.address, t1.address, ...(hasWeth ? [NATIVE as Address] : [])])
  const balIn = bal.data?.[tokenInAddr.toLowerCase()]
  const spendable = balIn === undefined ? undefined : sel === 'eth' ? (balIn > ETH_GAS_BUFFER ? balIn - ETH_GAS_BUFFER : 0n) : balIn
  const insufficient = spendable !== undefined && amount > spendable

  // ticks key parts (cl targets re-plan when the parent's range changes)
  const lo = target.kind === 'v2' ? 0 : target.tickLower
  const hi = target.kind === 'v2' ? 0 : target.tickUpper

  const plan = useQuery({
    queryKey: ['zapPlan', pool.address, lo, hi, tokenInAddr, amount.toString()],
    enabled: amount > 0n && !running,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
    queryFn: ({ signal }) => planZap({ target, tokenIn: tokenInAddr, amountIn: amount, signal }),
  })
  const p = running ? runPlan : (plan.data ?? null)
  const stages = useMemo(() => (p ? zapStages(p, target, t0, t1) : []), [p, target, t0, t1])
  const tOut = p ? (p.inIs0 ? t1 : t0) : null

  // projected APRs on the planned deposit (mint/add previews only — an
  // increase's projection is the parent card's business)
  const sim = useMemo(() => {
    if (!p || target.kind === 'cl-increase') return null
    const a0h = Number(formatUnits(p.dep0, t0.decimals))
    const a1h = Number(formatUnits(p.dep1, t1.decimals))
    if (target.kind === 'cl-mint')
      return simulateClAdd({
        pool: target.pool,
        tickLower: target.tickLower,
        tickUpper: target.tickUpper,
        liquidity: p.liquidity,
        amount0h: a0h,
        amount1h: a1h,
        dec0: t0.decimals,
        dec1: t1.decimals,
        stat: props.stat,
        upUsd: props.upUsd,
        wethUsd: props.wethUsd,
      })
    return simulateV2Add({
      pool: target.pool,
      amount0h: a0h,
      amount1h: a1h,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat: props.stat,
      upUsd: props.upUsd,
    })
  }, [p, target, t0, t1, props.stat, props.upUsd, props.wethUsd])

  // impact-vs-band honesty: a swap that eats a big slice of the band's width
  // will land the deposit off-ratio (dust) or out of band entirely
  const bandWarn = useMemo(() => {
    if (!p || p.impactBps === null || target.kind === 'v2') return null
    const halfPct = (Math.pow(1.0001, (target.tickUpper - target.tickLower) / 2) - 1) * 100
    const impactPct = p.impactBps / 100
    if (impactPct > Math.max(halfPct / 3, 2))
      return t('zap.bandWarn', { impact: impactPct.toFixed(2), band: halfPct.toFixed(1) })
    return null
  }, [p, target, t])

  const dustNote = (side: 0 | 1): string | null => {
    if (!p) return null
    const dust = side === 0 ? p.dust0 : p.dust1
    const dep = side === 0 ? p.dep0 : p.dep1
    if (dust === 0n || dep === 0n) return null
    if (dust * 200n < dep) return null // <0.5% — noise
    const t = side === 0 ? t0 : t1
    return `${fmtAmount(dust, t.decimals)} ${t.symbol}`
  }
  const dusts = [dustNote(0), dustNote(1)].filter(Boolean)

  const run = async () => {
    if (!user || amount === 0n || running) return
    setRunning(true)
    setDone(false)
    setRunAt({ i: 0, failed: false })
    try {
      // plan fresh for execution — the preview may be up to 30s old
      let fresh: ZapPlan
      try {
        fresh = await planZap({ target, tokenIn: tokenInAddr, amountIn: amount })
      } catch (e) {
        txlog.push('err', t('zap.replanFailed', { err: (e as Error).message }))
        setRunAt({ i: 0, failed: true })
        setRunPlan(null)
        return
      }
      setRunPlan(fresh)
      const res = await executeZap({
        plan: fresh,
        target,
        user,
        slipBps: slip,
        t0,
        t1,
        onStage: (i) => setRunAt({ i, failed: false }),
      })
      if (res.ok) {
        setRunAt(null)
        setRunPlan(null)
        setDone(true)
        setAmtStr('')
      } else {
        setRunAt({ i: res.failedAt ?? 0, failed: true })
      }
    } finally {
      setRunning(false)
    }
  }

  const failed = runAt?.failed ?? false

  return (
    <div className="zap">
      <div className="form-row">
        <span className="lbl">{t('zap.zapIn')}</span>
        <button className={`chip ${sel === '0' ? 'on' : ''}`} onClick={() => setSel('0')} disabled={running}>
          {t0.symbol}
        </button>
        <button className={`chip ${sel === '1' ? 'on' : ''}`} onClick={() => setSel('1')} disabled={running}>
          {t1.symbol}
        </button>
        {hasWeth && (
          <button
            className={`chip ${sel === 'eth' ? 'on' : ''}`}
            onClick={() => setSel('eth')}
            disabled={running}
            title={t('zap.ethTip')}
          >
            ETH
          </button>
        )}
        <NumInput value={amtStr} onChange={setAmtStr} disabled={running} width={220} />
        {spendable !== undefined && (
          <>
            <span className="dim mono-sm">
              {t('common.bal')} {fmtAmount(spendable, tIn.decimals)}
            </span>
            <button className="chip" disabled={running} onClick={() => setAmtStr(formatUnits(spendable, tIn.decimals))}>
              {t('common.max')}
            </button>
          </>
        )}
        {insufficient && <span className="red mono-sm">{t('common.exceedsBalance')}</span>}
      </div>
      <div className="form-row">
        <span className="lbl">{t('zap.slip')}</span>
        {[50, 100, 300].map((b) => (
          <button key={b} className={`chip ${slip === b ? 'on' : ''}`} onClick={() => setSlip(b)} disabled={running}>
            {b / 100}%
          </button>
        ))}
        <span className="dim mono-sm">{t('zap.slipHint')}</span>
      </div>

      {amount > 0n && plan.isLoading && (
        <div className="dim mono-sm">
          {t('zap.solving')}
          <span className="spin">▮</span>
        </div>
      )}
      {amount > 0n && plan.isError && !running && (
        <div className="red mono-sm">{t('zap.cantPlan', { err: (plan.error as Error).message })}</div>
      )}

      {p && (
        <div className="spec">
          <div className="spec-hd">{t('zap.planTitle')}</div>
          <div className="spec-row">
            <span className="sk">{t('zap.split')}</span>
            <span className="sv">
              {p.swapIn === 0n
                ? t('zap.keepAll', { amt: fmtAmount(p.keep, tIn.decimals), sym: p.inIs0 ? t0.symbol : t1.symbol })
                : t('zap.keepSwap', {
                    keep: fmtAmount(p.keep, tIn.decimals),
                    swap: fmtAmount(p.swapIn, tIn.decimals),
                    sym: p.inIs0 ? t0.symbol : t1.symbol,
                  })}
            </span>
            <span className="sd">{p.swapIn === 0n ? t('zap.splitSdSingle') : t('zap.splitSd')}</span>
          </div>
          {p.swapIn > 0n && tOut && (
            <div className="spec-row">
              <span className="sk">{t('zap.swapRow')}</span>
              <span className="sv">
                → ≈ {fmtAmount(p.estOut, tOut.decimals)} {tOut.symbol}
              </span>
              <span className="sd">
                {t('zap.swapMin', { amt: fmtAmount(applySlippage(p.estOut, slip), tOut.decimals), slip: slip / 100 })}
                {p.impactBps !== null &&
                  (p.impactBps < -500 ? (
                    // a >5% "gain" means kyber's USD marks are off for this token
                    // (common for launchpad tokens) — the number isn't actionable
                    <span> · {t('zap.impactOff')}</span>
                  ) : (
                    <span className={p.impactBps > 300 ? ' red' : p.impactBps > 150 ? ' amber' : ''}>
                      {' '}
                      · {t('zap.impact', { pct: (p.impactBps / 100).toFixed(2) })}
                    </span>
                  ))}
                {p.routeLabel && <> · {t('zap.via', { route: p.routeLabel })}</>}
              </span>
            </div>
          )}
          <div className="spec-row">
            <span className="sk">{t('zap.depositRow')}</span>
            <span className="sv">
              ≈ {fmtAmount(p.dep0, t0.decimals)} {t0.symbol} + {fmtAmount(p.dep1, t1.decimals)} {t1.symbol}
            </span>
            <span className="sd">
              {dusts.length > 0 ? t('zap.dustSd', { dust: dusts.join(' + ') }) : t('zap.actualSd')}
            </span>
          </div>
          {sim && (
            <div className="spec-row">
              <span className="sk">{t('add.projected')}</span>
              {sim.inRange ? (
                <>
                  <span className="sv">
                    {t('add.projDep', { usd: fmtUsd(sim.depositUsd) })}
                    {Number.isFinite(sim.feeApr) && (
                      <>
                        {' '}
                        · {t('add.projFeeApr')}
                        {pool.protocol === 'up33' ? <span className="dim"> {t('add.projIfUnstaked')}</span> : ''} ≈{' '}
                        {fmtApr(sim.feeApr)}
                      </>
                    )}
                    {Number.isFinite(sim.emitApr) && (
                      <>
                        {' '}
                        · {t('add.projEmitApr')}
                        <span className="dim"> {t('add.projIfStaked')}</span> ≈{' '}
                        <span className="green">{fmtApr(sim.emitApr)}</span>
                      </>
                    )}
                  </span>
                  <span className="sd">
                    {t('add.projShare', { pct: sim.sharePct < 0.01 ? '<0.01' : sim.sharePct.toFixed(2) })}
                  </span>
                </>
              ) : (
                <span className="sv red">{t('add.projOut')}</span>
              )}
            </div>
          )}
          {bandWarn && (
            <div className="spec-row">
              <span className="sk">!!</span>
              <span className="sv amber">{bandWarn}</span>
            </div>
          )}
        </div>
      )}

      {stages.length > 0 && (
        <div className="zap-steps mono-sm">
          {stages.map((s, i) => {
            const state = !runAt
              ? 'todo'
              : i < runAt.i
                ? 'done'
                : i === runAt.i
                  ? failed
                    ? 'fail'
                    : running
                      ? 'run'
                      : 'todo'
                  : 'todo'
            const mark = state === 'done' ? '✓' : state === 'run' ? '▮' : state === 'fail' ? '✗' : '·'
            return (
              <div key={i} className={`zstep ${state}`}>
                <span className="zn">{i + 1}</span>
                <span className="zm">{mark}</span>
                <span>{s.label}</span>
              </div>
            )
          })}
        </div>
      )}

      {failed && <div className="red mono-sm">{t('zap.halted', { n: (runAt?.i ?? 0) + 1 })}</div>}
      {done && <div className="green mono-sm">{t('zap.done')}</div>}

      <div className="form-row">
        <Btn busy={running} onClick={run} disabled={!user || amount === 0n || !plan.data || insufficient || running}>
          {!user
            ? t('common.connectWallet')
            : stages.length > 0
              ? t('zap.runTx', { n: stages.length })
              : t('zap.run')}
        </Btn>
        <span className="dim mono-sm">{t('zap.runHint')}</span>
      </div>
    </div>
  )
}
