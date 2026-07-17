import { useEffect, useMemo, useRef, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { readContract, writeContract } from 'wagmi/actions'
import { formatUnits, parseUnits } from 'viem'
import { clPmAbi, uniV2RouterAbi, uniV3PmAbi, v2RouterAbi } from '../../abi'
import { ADDR, CHAIN_ID, EXPLORER, UNI, WEEK } from '../../config/addresses'
import { wagmiConfig } from '../../config/wagmi'
import {
  alignTick,
  applySlippage,
  fullRangeTicks,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  previewDeposit,
  priceToTick,
  sqrtPriceToPrice,
  tickDeltaForPct,
  tickToPrice,
} from '../../lib/clmath'
import {
  emitAprOf,
  feeAprOf,
  fees24Of,
  fmtApr,
  simulateClAdd,
  simulateV2Add,
  stakedShareOf,
  type AddSim,
} from '../../lib/apr'
import { fmtAmount, fmtCompactAmount, fmtNum, fmtUsd, nowSec } from '../../lib/format'
import { deadline, ensureAllowance, fetchSqrtPriceX96, step } from '../../lib/tx'
import { useBalances } from '../../hooks/useBalances'
import { usePositions } from '../../hooks/usePositions'
import { usePoolStats } from '../../hooks/usePoolStats'
import { useUpPrice } from '../../hooks/useUpPrice'
import type { PoolStat } from '../../lib/poolstats'
import { poolTypeLabel, tokenOf, usePools } from '../../hooks/usePools'
import { useUniPools } from '../../hooks/useUniPools'
import type { ClPool, Pool, PoolsData, V2Pool } from '../../types'
import { Flash } from '../Flash'
import { ProtoBadge } from '../ProtoBadge'
import { RangeBar } from '../RangeBar'
import { ZapPanel } from '../ZapPanel'
import { AmountRow, Btn, NumInput } from '../ui'

const SLIP_BPS = 100

type SortKey = 'vol' | 'fees24' | 'tvl' | 'feeApr' | 'rewards' | null
type ProtoFilter = 'all' | 'up33' | 'univ3' | 'univ2'

export function PoolsTab() {
  const { t } = useTranslation()
  const pools = usePools()
  const stats = usePoolStats()
  const upPrice = useUpPrice()
  const { address: user } = useAccount()
  const positions = usePositions(user)
  const [q, setQ] = useState('') // one input: filters up33 locally + queries the indexer
  const [open, setOpen] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('tvl') // browse default: biggest pools first
  const [onlyMine, setOnlyMine] = useState(false)
  const [proto, setProto] = useState<ProtoFilter>('all')
  const [uniQuery, setUniQuery] = useState('') // '' = whole catalog by TVL (index) / WETH pools (fallback)
  const [hideDust, setHideDust] = useState(true) // 95% of the uniswap catalog is <$1k meme dust
  const uni = useUniPools(uniQuery, hideDust ? 1_000 : 0, proto === 'univ2' || proto === 'univ3' ? proto : undefined)
  const filterRef = useRef<HTMLInputElement>(null)

  // typing filters the local list instantly; the catalog query follows 350ms behind
  useEffect(() => {
    const id = setTimeout(() => setUniQuery(q.trim()), 350)
    return () => clearTimeout(id)
  }, [q])

  // "/" focuses the filter — terminal habit
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (e.key === '/') {
        e.preventDefault()
        filterRef.current?.focus()
      }
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const mySet = useMemo(() => {
    const s = new Set<string>()
    positions.data?.cl.forEach((p) => s.add(p.pool.address.toLowerCase()))
    positions.data?.v2.forEach((p) => s.add(p.pool.address.toLowerCase()))
    return s
  }, [positions.data])

  if (pools.isLoading)
    return (
      <div className="dim">
        {t('pools.loading')}
        <span className="spin">▮</span>
      </div>
    )
  if (pools.isError || !pools.data)
    return <div className="red">{t('pools.scanFailed', { err: String(pools.error) })}</div>

  // UP33 registry pools + on-chain-verified uniswap v3 browse results, one table
  const data: PoolsData = uni.data
    ? { ...pools.data, tokens: { ...pools.data.tokens, ...uni.data.tokens } }
    : pools.data
  const byPool = stats.data?.byPool
  const uniStats = uni.data?.stats
  const statOf = (p: Pool) => byPool?.[p.address.toLowerCase()] ?? uniStats?.[p.address.toLowerCase()]
  let list = [...pools.data.pools, ...(uni.data?.pools ?? [])].filter((p) => {
    if (onlyMine && !mySet.has(p.address.toLowerCase())) return false
    if (proto !== 'all' && p.protocol !== proto) return false
    if (!q) return true
    // uniswap rows arrive already query-matched by the API (which also handles
    // reversed pairs and raw addresses) — only up33 rows filter locally
    if (p.protocol !== 'up33') return true
    const label = `${tokenOf(data, p.token0).symbol}/${tokenOf(data, p.token1).symbol} ${poolTypeLabel(p)}`.toLowerCase()
    return label.includes(q.toLowerCase())
  })
  if (sort) {
    list = [...list].sort((a, b) => {
      if (sort === 'vol') return (statOf(b)?.vol24hUsd ?? -1) - (statOf(a)?.vol24hUsd ?? -1)
      if (sort === 'fees24') return (fees24Of(b, statOf(b)) ?? -1) - (fees24Of(a, statOf(a)) ?? -1)
      if (sort === 'tvl') return (statOf(b)?.liqUsd ?? -1) - (statOf(a)?.liqUsd ?? -1)
      if (sort === 'feeApr') return (feeAprOf(b, statOf(b)) ?? -1) - (feeAprOf(a, statOf(a)) ?? -1)
      return (
        (emitAprOf(b, statOf(b), upPrice.data) ?? -1) - (emitAprOf(a, statOf(a), upPrice.data) ?? -1)
      )
    })
  }

  const totalWeight = data.protocol.totalWeight
  const th = (key: Exclude<SortKey, null>, label: string) => (
    <th
      className={`num sortable ${sort === key ? 'on' : ''}`}
      onClick={() => setSort(sort === key ? null : key)}
      title={t('pools.sortTip')}
    >
      {label}
      {sort === key ? ' ▼' : ''}
    </th>
  )

  return (
    <div className="tab-fill">
      <div className="form-row">
        <input
          ref={filterRef}
          className="input"
          style={{ maxWidth: 360 }}
          placeholder={t('pools.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {(
          [
            ['all', t('pools.protoAll'), t('pools.protoAllTip')],
            ['up33', 'UP33', t('pools.protoUp33Tip')],
            ['univ3', 'UNI V3', t('pools.protoV3Tip')],
            ['univ2', 'UNI V2', t('pools.protoV2Tip')],
          ] as const
        ).map(([k, label, tip]) => (
          <button key={k} className={`chip ${proto === k ? 'on' : ''}`} onClick={() => setProto(k)} title={tip}>
            {label}
          </button>
        ))}
        <button className={`chip ${hideDust ? 'on' : ''}`} onClick={() => setHideDust(!hideDust)} title={t('pools.hideDustTip')}>
          {t('pools.hideDust')}
        </button>
        {user && mySet.size > 0 && (
          <button className={`chip ${onlyMine ? 'on' : ''}`} onClick={() => setOnlyMine(!onlyMine)}>
            {t('pools.mine', { n: mySet.size })}
          </button>
        )}
      </div>
      <div className="form-row">
        <span className="dim mono-sm">
          {t('pools.statShown', { n: list.length })} · {t('pools.statUp33', { n: pools.data.pools.length })} ·{' '}
          {t('pools.statUniswap')}{' '}
          {uni.isLoading ? (
            <span className="spin">▮</span>
          ) : uni.data?.source === 'index' ? (
            <>
              {t('pools.statCatalog', { n: uni.data.indexed.toLocaleString('en-US') })} ·{' '}
              {t('pools.statMatch', { n: uni.data.total.toLocaleString('en-US') })}
            </>
          ) : uni.data ? (
            <>{t('pools.statTop', { n: uni.data.pools.length })}</>
          ) : (
            '—'
          )}
          {stats.isLoading && (
            <>
              {' '}
              · {t('pools.statVol')}
              <span className="spin">▮</span>
            </>
          )}
          {uni.isFetching && !uni.isLoading && <span className="spin"> ▮</span>}
          {uni.isError && (
            <span className="red"> · {t('pools.uniScanFailed', { err: String(uni.error).slice(0, 60) })}</span>
          )}
          {uni.data?.source === 'fallback' && (
            <span className="amber">
              {' '}
              · {t('pools.fallbackNote')}
              {uni.data.dropped > 0 ? <> · {t('pools.spoofDropped', { n: uni.data.dropped })}</> : ''}
            </span>
          )}
        </span>
      </div>
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>{t('pools.thPair')}</th>
              <th>{t('pools.thPrice')}</th>
              {th('tvl', t('pools.thTvl'))}
              {th('vol', t('pools.thVol'))}
              {th('fees24', t('pools.thFees'))}
              {th('feeApr', t('pools.thFeeApr'))}
              {th('rewards', t('pools.thRewards'))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => (
              <PoolRow
                key={p.address}
                p={p}
                data={data}
                stat={statOf(p)}
                upUsd={upPrice.data}
                wethUsd={stats.data?.wethUsd}
                totalWeight={totalWeight}
                mine={mySet.has(p.address.toLowerCase())}
                open={open === p.address}
                onToggle={() => setOpen(open === p.address ? null : p.address)}
                rewardsSub={proto === 'up33'}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="dim mono-sm" style={{ marginTop: 6 }} title={t('pools.footnoteTip')}>
        <Trans i18nKey="pools.footnote" components={[<b className="dim" key="0" />, <b className="dim" key="1" />]} />
      </div>
    </div>
  )
}

function PoolRow(props: {
  p: Pool
  data: PoolsData
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
  totalWeight: bigint
  mine: boolean
  open: boolean
  onToggle: () => void
  /** UP33 filter view: show the emissions detail sub-line (wide column) */
  rewardsSub: boolean
}) {
  const { t } = useTranslation()
  const { p, data, totalWeight, stat } = props
  const t0 = tokenOf(data, p.token0)
  const t1 = tokenOf(data, p.token1)
  const feePct = p.kind === 'v2' ? p.feeBps / 100 : p.feePpm / 10_000
  const emitting = p.periodFinish > BigInt(nowSec())
  const upWk = emitting ? p.rewardRate * BigInt(WEEK) : 0n
  const votePct = totalWeight > 0n ? Number((p.weight * 1_000_000n) / totalWeight) / 10_000 : 0
  const fees24 = fees24Of(p, stat)
  const feeApr = feeAprOf(p, stat)
  const emitApr = emitAprOf(p, stat, props.upUsd)
  const stakedPct = stakedShareOf(p) * 100

  return (
    <>
      <tr className="rowhover">
        <td>
          <div>
            {props.mine && (
              <span className="mydot" title={t('pools.mineDotTip')}>
                ●
              </span>
            )}
            <b>
              {t0.symbol}/{t1.symbol}
            </b>
            {p.protocol !== 'up33' && <ProtoBadge proto={p.protocol} mini />}
          </div>
          <div className="pair-sub">
            <span className="cyan">
              {p.kind === 'v2'
                ? p.protocol === 'univ2'
                  ? 'v2'
                  : p.stable
                    ? 'v2 stable'
                    : 'v2 volatile'
                : p.protocol === 'univ3'
                  ? `v3 ts${p.tickSpacing}`
                  : `CL ts${p.tickSpacing}`}
            </span>
            {' · '}
            <span
              title={
                p.protocol === 'up33' ? undefined : p.kind === 'v2' ? t('pools.feeTipUniV2') : t('pools.feeTipUniV3')
              }
            >
              {feePct.toFixed(feePct < 0.1 ? 3 : 2)}%
            </span>
            {p.protocol === 'up33' && (
              <>
                {' · '}
                {p.gauge ? (
                  p.gaugeAlive ? (
                    <span className="green">{t('pools.gauge')}</span>
                  ) : (
                    <span className="red">{t('pools.killed')}</span>
                  )
                ) : (
                  <span>{t('pools.noGauge')}</span>
                )}
              </>
            )}
          </div>
        </td>
        <td className="mono-sm">
          {p.kind === 'v2' ? (
            <>
              {fmtCompactAmount(p.reserve0, t0.decimals)} {t0.symbol} + {fmtCompactAmount(p.reserve1, t1.decimals)} {t1.symbol}
            </>
          ) : (
            <PxCell sqrtPriceX96={p.sqrtPriceX96} d0={t0.decimals} d1={t1.decimals} s0={t0.symbol} s1={t1.symbol} />
          )}
        </td>
        <td className="num">
          {stat?.liqUsd != null && stat.liqUsd > 0 ? fmtUsd(stat.liqUsd) : <span className="dim">—</span>}
        </td>
        <td className="num">
          {stat?.vol24hUsd != null ? fmtUsd(stat.vol24hUsd) : <span className="dim">—</span>}
        </td>
        <td className="num">
          {fees24 != null ? <span className="amber">{fmtUsd(fees24)}</span> : <span className="dim">—</span>}
        </td>
        <td className="num" title="unstaked LP net fee yield (staked LPs earn 0 fees)">
          {feeApr != null ? fmtApr(feeApr) : <span className="dim">—</span>}
        </td>
        <td className="num" title={t('pools.rewardsTip')}>
          {p.protocol === 'up33' ? (
            <>
              {emitApr != null ? <span className="green">{fmtApr(emitApr)}</span> : <span className="dim">—</span>}
              {props.rewardsSub && (
                <span className="cell-sub">
                  {upWk > 0n ? t('pools.upWk', { n: fmtCompactAmount(upWk, 18) }) : t('pools.noEmissions')}
                  {votePct > 0 ? ` · ${t('pools.vote', { n: votePct.toFixed(2) })}` : ''}
                  {stakedPct > 0 ? ` · ${t('pools.stakedPct', { n: stakedPct.toFixed(0) })}` : ''}
                </span>
              )}
            </>
          ) : (
            <span className="dim">—</span>
          )}
        </td>
        <td className="num">
          <Btn tone="ghost" onClick={props.onToggle}>
            {props.open ? t('common.close') : t('pools.addLp')}
          </Btn>{' '}
          <a href={`${EXPLORER}/address/${p.address}`} target="_blank" rel="noreferrer" className="dim">
            ↗
          </a>
        </td>
      </tr>
      {props.open && (
        <tr>
          <td colSpan={8}>
            {p.kind === 'v2' ? (
              <AddV2 pool={p} data={data} stat={stat} upUsd={props.upUsd} />
            ) : (
              <AddCl pool={p} data={data} stat={stat} upUsd={props.upUsd} wethUsd={props.wethUsd} />
            )}
          </td>
        </tr>
      )}
    </>
  )
}

/** pool price, auto-oriented so the number is >= 1 (small prices flip quote/base) */
function PxCell(props: { sqrtPriceX96: bigint; d0: number; d1: number; s0: string; s1: string }) {
  const px = sqrtPriceToPrice(props.sqrtPriceX96, props.d0, props.d1)
  // absurd magnitudes = pool initialized at a nonsense price (usually zero liquidity)
  if (!Number.isFinite(px) || px <= 1e-15 || px >= 1e15) return <span className="dim">—</span>
  const flip = px < 1
  return (
    <>
      <Flash v={flip ? 1 / px : px}>
        <span>{fmtNum(flip ? 1 / px : px)}</span>
      </Flash>{' '}
      <span className="dim">{flip ? `${props.s0}/${props.s1}` : `${props.s1}/${props.s0}`}</span>
    </>
  )
}

/** projected APRs line shown in the add-LP panels; emitless = no gauge system (univ3) */
function SimLine({ sim, emitless }: { sim: AddSim | null; emitless?: boolean }) {
  const { t } = useTranslation()
  if (!sim) return null
  if (!sim.inRange)
    return (
      <div className="form-row sim-line mono-sm">
        <span className="lbl">{t('add.projected')}</span>
        <span className="red">{t('add.projOut')}</span>
      </div>
    )
  return (
    <div className="form-row sim-line mono-sm">
      <span className="lbl">{t('add.projected')}</span>
      <span className="dim">{t('add.projDep', { usd: fmtUsd(sim.depositUsd) })}</span>
      <span>
        {t('add.projFeeApr')} {!emitless && <span className="dim">{t('add.projIfUnstaked')}</span>} ≈{' '}
        <b>{fmtApr(sim.feeApr)}</b>
      </span>
      {!emitless && (
        <span>
          {t('add.projEmitApr')} <span className="dim">{t('add.projIfStaked')}</span> ≈{' '}
          <b className="green">{fmtApr(sim.emitApr)}</b>
        </span>
      )}
      <span className="dim">{t('add.projShare', { pct: sim.sharePct < 0.01 ? '<0.01' : sim.sharePct.toFixed(2) })}</span>
    </div>
  )
}

// ---------------- add liquidity: v2 ----------------

export function AddV2({ pool, data, stat, upUsd }: { pool: V2Pool; data: PoolsData; stat?: PoolStat; upUsd?: number }) {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const t0 = tokenOf(data, pool.token0)
  const t1 = tokenOf(data, pool.token1)
  const [fund, setFund] = useState<'pair' | 'zap'>('pair')
  const [a0, setA0] = useState('')
  const [a1, setA1] = useState('')
  const [busy, setBusy] = useState(false)
  const bal = useBalances(user, [pool.token0, pool.token1])

  const link = (v: string, is0: boolean) => {
    if (is0) setA0(v)
    else setA1(v)
    if (pool.reserve0 === 0n || pool.reserve1 === 0n) return
    try {
      const amt = parseUnits(v === '' ? '0' : v, is0 ? t0.decimals : t1.decimals)
      if (is0) {
        const other = (amt * pool.reserve1) / pool.reserve0
        setA1(trim(formatUnits(other, t1.decimals)))
      } else {
        const other = (amt * pool.reserve0) / pool.reserve1
        setA0(trim(formatUnits(other, t0.decimals)))
      }
    } catch {
      /* partial input */
    }
  }

  const sim = useMemo(
    () =>
      simulateV2Add({
        pool,
        amount0h: Number(a0) || 0,
        amount1h: Number(a1) || 0,
        dec0: t0.decimals,
        dec1: t1.decimals,
        stat,
        upUsd,
      }),
    [pool, a0, a1, t0.decimals, t1.decimals, stat, upUsd],
  )

  const uni2 = pool.protocol === 'univ2'
  const router = uni2 ? UNI.V2_ROUTER : ADDR.V2_ROUTER

  const add = async () => {
    if (!user) return
    setBusy(true)
    try {
      const amt0 = safeParse(a0, t0.decimals)
      const amt1 = safeParse(a1, t1.decimals)
      if (amt0 === 0n || amt1 === 0n) return
      if (!(await ensureAllowance(pool.token0, user, router, amt0, t0.symbol))) return
      if (!(await ensureAllowance(pool.token1, user, router, amt1, t1.symbol))) return
      if (uni2) {
        // vanilla Router02: no on-chain quote helper — amounts are already
        // reserve-ratio-linked by the UI, the router pins the optimal ratio
        // and the mins bound the drift since linking
        await step(t('add.stepAddV2', { pair: `${t0.symbol}/${t1.symbol}` }), () =>
          writeContract(wagmiConfig, {
            abi: uniV2RouterAbi,
            address: UNI.V2_ROUTER,
            functionName: 'addLiquidity',
            args: [
              pool.token0,
              pool.token1,
              amt0,
              amt1,
              applySlippage(amt0, SLIP_BPS),
              applySlippage(amt1, SLIP_BPS),
              user,
              deadline(),
            ],
            chainId: CHAIN_ID,
          }),
        )
        return
      }
      const quote = await readContract(wagmiConfig, {
        abi: v2RouterAbi,
        address: ADDR.V2_ROUTER,
        functionName: 'quoteAddLiquidity',
        args: [pool.token0, pool.token1, pool.stable, ADDR.V2_FACTORY, amt0, amt1],
        chainId: CHAIN_ID,
      })
      await step(t('add.stepAdd', { pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2RouterAbi,
          address: ADDR.V2_ROUTER,
          functionName: 'addLiquidity',
          args: [
            pool.token0,
            pool.token1,
            pool.stable,
            amt0,
            amt1,
            applySlippage(quote[0], SLIP_BPS),
            applySlippage(quote[1], SLIP_BPS),
            user,
            deadline(),
          ],
          chainId: CHAIN_ID,
        }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="expander">
      <FundSwitch fund={fund} onFund={setFund} />
      {fund === 'zap' ? (
        <ZapPanel target={{ kind: 'v2', pool }} t0={t0} t1={t1} stat={stat} upUsd={upUsd} />
      ) : (
        <>
          <AmountRow
            sym={t0.symbol}
            value={a0}
            onChange={(v) => link(v, true)}
            bal={bal.data?.[pool.token0.toLowerCase()]}
            dec={t0.decimals}
            onMax={(v) => link(v, true)}
          />
          <AmountRow
            sym={t1.symbol}
            value={a1}
            onChange={(v) => link(v, false)}
            bal={bal.data?.[pool.token1.toLowerCase()]}
            dec={t1.decimals}
            onMax={(v) => link(v, false)}
          />
          <SimLine sim={sim} emitless={uni2} />
          <div className="form-row">
            <Btn busy={busy} onClick={add} disabled={!user}>
              {t('add.addLiquidity')}
            </Btn>
            <span className="dim mono-sm">
              {t('add.v2Hint', { slip: SLIP_BPS / 100 })} · {uni2 ? t('add.v2HintUni') : t('add.v2HintUp33')}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** PAIR = supply both tokens yourself · ZAP = fund with one token, the
 *  terminal swaps the right slice into the counter-token first */
export function FundSwitch(props: { fund: 'pair' | 'zap'; onFund: (f: 'pair' | 'zap') => void }) {
  const { t } = useTranslation()
  return (
    <div className="form-row">
      <span className="lbl">{t('add.fund')}</span>
      <button
        className={`chip ${props.fund === 'pair' ? 'on' : ''}`}
        onClick={() => props.onFund('pair')}
        title={t('add.fundPairTip')}
      >
        {t('add.fundPair')}
      </button>
      <button
        className={`chip ${props.fund === 'zap' ? 'on' : ''}`}
        onClick={() => props.onFund('zap')}
        title={t('add.fundZapTip')}
      >
        {t('add.fundZap')}
      </button>
    </div>
  )
}

// ---------------- add liquidity: CL ----------------

const PRESETS = [
  { id: 'p05', label: '±0.5%', pct: 0.005 },
  { id: 'p1', label: '±1%', pct: 0.01 },
  { id: 'p2', label: '±2%', pct: 0.02 },
  { id: 'p5', label: '±5%', pct: 0.05 },
  { id: 'p10', label: '±10%', pct: 0.1 },
  { id: 'p20', label: '±20%', pct: 0.2 },
  { id: 'p30', label: '±30%', pct: 0.3 },
] as const

type RangeMode = (typeof PRESETS)[number]['id'] | 'full' | 'pct' | 'above' | 'below' | 'price' | 'ticks'

function symRange(tick: number, pct: number, spacing: number) {
  const d = tickDeltaForPct(pct)
  const lower = alignTick(tick - d, spacing, 'floor')
  let upper = alignTick(tick + d, spacing, 'ceil')
  if (upper <= lower) upper = lower + spacing
  return { lower, upper }
}

/** plain decimal string (no grouping) for editable price inputs */
function plainNum(x: number): string {
  if (!Number.isFinite(x)) return ''
  const s = x >= 1 ? x.toPrecision(7) : x.toPrecision(5)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

export function AddCl({
  pool,
  data,
  stat,
  upUsd,
  wethUsd,
}: {
  pool: ClPool
  data: PoolsData
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}) {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const t0 = tokenOf(data, pool.token0)
  const t1 = tokenOf(data, pool.token1)
  const [fund, setFund] = useState<'pair' | 'zap'>('pair')
  const [mode, setMode] = useState<RangeMode>('p10')
  const [pctStr, setPctStr] = useState('10')
  const [priceLo, setPriceLo] = useState('')
  const [priceHi, setPriceHi] = useState('')
  const [custom, setCustom] = useState<{ lower: string; upper: string }>({ lower: '', upper: '' })
  const [a0, setA0] = useState('')
  const [a1, setA1] = useState('')
  const [busy, setBusy] = useState(false)
  const bal = useBalances(user, [pool.token0, pool.token1])

  const ticks = useMemo(() => {
    const s = pool.tickSpacing
    const preset = PRESETS.find((x) => x.id === mode)
    if (preset) return symRange(pool.tick, preset.pct, s)
    if (mode === 'full') return fullRangeTicks(s)
    if (mode === 'pct') {
      const pct = Number(pctStr) / 100
      return pct > 0 ? symRange(pool.tick, pct, s) : null
    }
    if (mode === 'above' || mode === 'below') {
      // one-sided: range starts at the current price and extends one way.
      // ABOVE deposits token0 only (sells into rises); BELOW token1 only.
      const pct = Number(pctStr) / 100
      if (!(pct > 0)) return null
      const d = tickDeltaForPct(pct)
      if (mode === 'above') {
        const lower = alignTick(pool.tick, s, 'ceil')
        let upper = alignTick(pool.tick + d, s, 'ceil')
        if (upper <= lower) upper = lower + s
        return { lower, upper }
      }
      const upper = alignTick(pool.tick, s, 'floor')
      let lower = alignTick(pool.tick - d, s, 'floor')
      if (lower >= upper) lower = upper - s
      return { lower, upper }
    }
    if (mode === 'price') {
      const lo = Number(priceLo)
      const hi = Number(priceHi)
      if (!(lo > 0) || !(hi > 0) || lo >= hi) return null
      const tA = priceToTick(lo, t0.decimals, t1.decimals)
      const tB = priceToTick(hi, t0.decimals, t1.decimals)
      const lower = alignTick(Math.min(tA, tB), s, 'floor')
      let upper = alignTick(Math.max(tA, tB), s, 'ceil')
      if (upper <= lower) upper = lower + s
      return { lower, upper }
    }
    const lo = parseInt(custom.lower, 10)
    const hi = parseInt(custom.upper, 10)
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo < hi)
      return { lower: alignTick(lo, s, 'floor'), upper: alignTick(hi, s, 'ceil') }
    return null
  }, [mode, pctStr, priceLo, priceHi, custom, pool.tick, pool.tickSpacing, t0.decimals, t1.decimals])

  const enterPriceMode = () => {
    const base = ticks ?? symRange(pool.tick, 0.1, pool.tickSpacing)
    setPriceLo(plainNum(tickToPrice(base.lower, t0.decimals, t1.decimals)))
    setPriceHi(plainNum(tickToPrice(base.upper, t0.decimals, t1.decimals)))
    setMode('price')
  }

  const below = ticks ? pool.tick < ticks.lower : false
  const above = ticks ? pool.tick >= ticks.upper : false

  const link = (v: string, is0: boolean) => {
    if (is0) setA0(v)
    else setA1(v)
    if (!ticks) return
    try {
      const amt = parseUnits(v === '' ? '0' : v, is0 ? t0.decimals : t1.decimals)
      const prev = previewDeposit(pool.sqrtPriceX96, ticks.lower, ticks.upper, amt, is0)
      if (!prev) return
      if (is0) setA1(prev.amount1 === 0n ? '0' : trim(formatUnits(prev.amount1, t1.decimals)))
      else setA0(prev.amount0 === 0n ? '0' : trim(formatUnits(prev.amount0, t0.decimals)))
    } catch {
      /* partial input */
    }
  }

  // range changed -> rebalance the linked amounts to the new band
  useEffect(() => {
    if (!ticks) return
    if (a0 && a0 !== '0' && !above) link(a0, true)
    else if (a1 && a1 !== '0' && !below) link(a1, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticks?.lower, ticks?.upper])

  const sim = useMemo(() => {
    if (!ticks) return null
    const amt0 = safeParse(a0, t0.decimals)
    const amt1 = safeParse(a1, t1.decimals)
    if (amt0 === 0n && amt1 === 0n) return null
    const liq = getLiquidityForAmounts(
      pool.sqrtPriceX96,
      getSqrtRatioAtTick(ticks.lower),
      getSqrtRatioAtTick(ticks.upper),
      amt0,
      amt1,
    )
    return simulateClAdd({
      pool,
      tickLower: ticks.lower,
      tickUpper: ticks.upper,
      liquidity: liq,
      amount0h: Number(a0) || 0,
      amount1h: Number(a1) || 0,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat,
      upUsd,
      wethUsd,
    })
  }, [ticks, a0, a1, pool, t0.decimals, t1.decimals, stat, upUsd, wethUsd])

  const mint = async () => {
    if (!user || !ticks) return
    setBusy(true)
    try {
      const amt0 = safeParse(a0, t0.decimals)
      const amt1 = safeParse(a1, t1.decimals)
      if (amt0 === 0n && amt1 === 0n) return
      // univ3 and Slipstream NPMs share everything except mint's struct shape
      const npm = pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM
      if (amt0 > 0n && !(await ensureAllowance(pool.token0, user, npm, amt0, t0.symbol))) return
      if (amt1 > 0n && !(await ensureAllowance(pool.token1, user, npm, amt1, t1.symbol))) return
      // fresh price + band-edge mins (see minAmountsForLiquidity) — avoids 'PS' reverts
      const sqrtP = await fetchSqrtPriceX96(pool.address)
      const sqrtA = getSqrtRatioAtTick(ticks.lower)
      const sqrtB = getSqrtRatioAtTick(ticks.upper)
      const liq = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amt0, amt1)
      const mins = minAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liq, SLIP_BPS)
      const common = {
        token0: pool.token0,
        token1: pool.token1,
        tickLower: ticks.lower,
        tickUpper: ticks.upper,
        amount0Desired: amt0,
        amount1Desired: amt1,
        amount0Min: mins.amount0Min,
        amount1Min: mins.amount1Min,
        recipient: user,
        deadline: deadline(),
      }
      await step(
        t('add.stepMint', {
          kind: pool.protocol === 'univ3' ? 'v3' : 'CL',
          pair: `${t0.symbol}/${t1.symbol}`,
          lo: ticks.lower,
          hi: ticks.upper,
        }),
        () =>
          pool.protocol === 'univ3'
            ? writeContract(wagmiConfig, {
                abi: uniV3PmAbi,
                address: UNI.V3_NPM,
                functionName: 'mint',
                args: [{ ...common, fee: pool.feePpm }],
                chainId: CHAIN_ID,
              })
            : writeContract(wagmiConfig, {
                abi: clPmAbi,
                address: ADDR.CL_PM,
                functionName: 'mint',
                args: [{ ...common, tickSpacing: pool.tickSpacing, sqrtPriceX96: 0n }],
                chainId: CHAIN_ID,
              }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="expander">
      <div className="form-row">
        <span className="lbl">{t('add.range')}</span>
        {PRESETS.map((p) => (
          <button key={p.id} className={`chip ${mode === p.id ? 'on' : ''}`} onClick={() => setMode(p.id)}>
            {p.label}
          </button>
        ))}
        <button className={`chip ${mode === 'full' ? 'on' : ''}`} onClick={() => setMode('full')}>
          {t('add.full')}
        </button>
      </div>
      <div className="form-row">
        <span className="lbl"></span>
        <button className={`chip ${mode === 'pct' ? 'on' : ''}`} onClick={() => setMode('pct')} title={t('add.pctCustomTip')}>
          {t('add.pctCustom')}
        </button>
        <button
          className={`chip ${mode === 'above' ? 'on' : ''}`}
          onClick={() => setMode('above')}
          title={t('add.aboveTip', { sym: t0.symbol })}
        >
          {t('add.above')}
        </button>
        <button
          className={`chip ${mode === 'below' ? 'on' : ''}`}
          onClick={() => setMode('below')}
          title={t('add.belowTip', { sym: t1.symbol })}
        >
          {t('add.below')}
        </button>
        <button className={`chip ${mode === 'price' ? 'on' : ''}`} onClick={enterPriceMode} title={t('add.priceTip')}>
          {t('add.price')}
        </button>
        <button className={`chip ${mode === 'ticks' ? 'on' : ''}`} onClick={() => setMode('ticks')} title={t('add.ticksTip')}>
          {t('add.ticks')}
        </button>
        {(mode === 'pct' || mode === 'above' || mode === 'below') && (
          <>
            <span className="dim">{mode === 'above' ? '+' : mode === 'below' ? '−' : '±'}</span>
            <NumInput value={pctStr} onChange={setPctStr} width={70} placeholder="10" />
            <span className="dim">%</span>
          </>
        )}
        {mode === 'price' && (
          <>
            <NumInput value={priceLo} onChange={setPriceLo} width={130} placeholder={t('add.priceLo')} />
            <span className="dim">→</span>
            <NumInput value={priceHi} onChange={setPriceHi} width={130} placeholder={t('add.priceHi')} />
            <span className="dim mono-sm">
              {t('add.priceUnits', { quote: t1.symbol, base: t0.symbol, ts: pool.tickSpacing })}
            </span>
          </>
        )}
        {mode === 'ticks' && (
          <>
            <NumInputSigned value={custom.lower} onChange={(v) => setCustom({ ...custom, lower: v })} placeholder={t('add.tickLower')} />
            <NumInputSigned value={custom.upper} onChange={(v) => setCustom({ ...custom, upper: v })} placeholder={t('add.tickUpper')} />
            <span className="dim mono-sm">{t('add.spacing', { ts: pool.tickSpacing })}</span>
          </>
        )}
        {(mode === 'above' || mode === 'below') && (
          <span className="dim mono-sm">
            {t('add.limitHint')} <a href="#limit">{t('add.limitHintLink')}</a> {t('add.limitHintRest')}
          </span>
        )}
      </div>
      {ticks && (
        <RangeBar
          tickLower={ticks.lower}
          tickUpper={ticks.upper}
          tick={pool.tick}
          sqrtPriceX96={pool.sqrtPriceX96}
          dec0={t0.decimals}
          dec1={t1.decimals}
          sym0={t0.symbol}
          sym1={t1.symbol}
        />
      )}
      <FundSwitch fund={fund} onFund={setFund} />
      {fund === 'zap' ? (
        ticks ? (
          <ZapPanel
            target={{ kind: 'cl-mint', pool, tickLower: ticks.lower, tickUpper: ticks.upper }}
            t0={t0}
            t1={t1}
            stat={stat}
            upUsd={upUsd}
            wethUsd={wethUsd}
          />
        ) : (
          <div className="dim mono-sm">{t('add.setRangeFirst')}</div>
        )
      ) : (
        <>
          <AmountRow
            sym={t0.symbol}
            value={a0}
            onChange={(v) => link(v, true)}
            bal={bal.data?.[pool.token0.toLowerCase()]}
            dec={t0.decimals}
            onMax={(v) => link(v, true)}
            disabled={above}
            note={above ? t('add.aboveNote') : undefined}
          />
          <AmountRow
            sym={t1.symbol}
            value={a1}
            onChange={(v) => link(v, false)}
            bal={bal.data?.[pool.token1.toLowerCase()]}
            dec={t1.decimals}
            onMax={(v) => link(v, false)}
            disabled={below}
            note={below ? t('add.belowNote') : undefined}
          />
          <SimLine sim={sim} emitless={pool.protocol === 'univ3'} />
          <div className="form-row">
            <Btn busy={busy} onClick={mint} disabled={!user || !ticks}>
              {t('add.mint')}
            </Btn>
            <span className="dim mono-sm">
              {pool.protocol === 'univ3' ? t('add.mintHintUni') : t('add.mintHintUp33')}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------- shared bits ----------------

function NumInputSigned(props: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      className="input"
      style={{ width: 110 }}
      placeholder={props.placeholder}
      value={props.value}
      onChange={(e) => {
        const v = e.target.value
        if (v === '' || /^-?\d*$/.test(v)) props.onChange(v)
      }}
    />
  )
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
function safeParse(s: string, dec: number): bigint {
  try {
    return parseUnits(s === '' ? '0' : s, dec)
  } catch {
    return 0n
  }
}
