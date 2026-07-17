// LIMIT mode — "sell a token by deploying a one-sided LP" (CL range order).
// The band sits strictly beyond the current price on the side that fills as the
// sell token appreciates; a full traversal converts the deposit into the buy
// token at avg price √(pa·pb), plus swap fees earned in-band.
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { writeContract } from 'wagmi/actions'
import { formatUnits, parseUnits, type Address } from 'viem'
import { clPmAbi } from '../../abi'
import { ADDR, CHAIN_ID } from '../../config/addresses'
import { wagmiConfig } from '../../config/wagmi'
import {
  alignTick,
  applySlippage,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  sqrtPriceToPrice,
  tickDeltaForPct,
  tickToPrice,
} from '../../lib/clmath'
import { clTokenUsd } from '../../lib/apr'
import { fmtAmount, fmtNum, fmtUsd } from '../../lib/format'
import { limitSideFor, mintedTokenId, tagLimit, type LimitSide } from '../../lib/limit'
import { deadline, ensureAllowance, fetchSqrtPriceX96, step } from '../../lib/tx'
import { txlog } from '../../lib/txlog'
import { usePools } from '../../hooks/usePools'
import { usePoolStats } from '../../hooks/usePoolStats'
import { useUpPrice } from '../../hooks/useUpPrice'
import { useBalances } from '../../hooks/useBalances'
import { useLiveSlot0 } from '../../hooks/useLiveSlot0'
import type { ClPool, TokenInfo } from '../../types'
import { Flash } from '../Flash'
import { RangeBar } from '../RangeBar'
import { TokenSelect } from '../TokenSelect'
import { Btn, NumInput } from '../ui'

const BANDS = [
  { id: 'b1', lo: 1, hi: 3 },
  { id: 'b2', lo: 2, hi: 5 },
  { id: 'b5', lo: 5, hi: 10 },
  { id: 'b10', lo: 10, hi: 25 },
]
const MIN_SELL_SLIP_BPS = 10 // out-of-range one-sided mint uses the full amount; 0.1% covers rounding

/** narrowest possible band hugging the market: one tick-spacing right beyond
 *  current price — the maker version of "sell at the touch" */
function tightTicks(pool: ClPool, side: LimitSide): { lower: number; upper: number } {
  const s = pool.tickSpacing
  if (side === 'sell0') {
    let lower = alignTick(pool.tick, s, 'ceil')
    while (getSqrtRatioAtTick(lower) <= pool.sqrtPriceX96) lower += s
    return { lower, upper: lower + s }
  }
  let upper = alignTick(pool.tick, s, 'floor')
  while (getSqrtRatioAtTick(upper) >= pool.sqrtPriceX96) upper -= s
  return { lower: upper - s, upper }
}

/** premium band (% above market for the SELL token) -> snapped ticks, strictly out of range */
function bandTicks(
  pool: ClPool,
  side: LimitSide,
  loPct: number,
  hiPct: number,
): { lower: number; upper: number } | null {
  if (!(loPct > 0) || !(hiPct > loPct)) return null
  const s = pool.tickSpacing
  if (side === 'sell0') {
    // sell token0: fills as token1/token0 price rises — band above
    let lower = alignTick(pool.tick + tickDeltaForPct(loPct / 100), s, 'ceil')
    while (getSqrtRatioAtTick(lower) <= pool.sqrtPriceX96) lower += s
    let upper = alignTick(pool.tick + tickDeltaForPct(hiPct / 100), s, 'ceil')
    if (upper <= lower) upper = lower + s
    return { lower, upper }
  }
  // sell token1: fills as token1/token0 price falls — band below
  let upper = alignTick(pool.tick - tickDeltaForPct(loPct / 100), s, 'floor')
  while (getSqrtRatioAtTick(upper) >= pool.sqrtPriceX96) upper -= s
  let lower = alignTick(pool.tick - tickDeltaForPct(hiPct / 100), s, 'floor')
  if (lower >= upper) lower = upper - s
  return { lower, upper }
}

export function LimitPanel() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const pools = usePools()
  const data = pools.data

  const [sellAddr, setSellAddr] = useState<Address | null>(null)
  const [buyAddr, setBuyAddr] = useState<Address | null>(null)
  const [poolAddr, setPoolAddr] = useState<Address | null>(null)
  const [amtStr, setAmtStr] = useState('')
  const [bandId, setBandId] = useState('tight')
  const [loStr, setLoStr] = useState('3')
  const [hiStr, setHiStr] = useState('8')
  const [explain, setExplain] = useState(false)
  const [busy, setBusy] = useState(false)

  const clPools = useMemo(
    () => (data?.pools.filter((p) => p.kind === 'cl' && p.sqrtPriceX96 > 0n) ?? []) as ClPool[],
    [data],
  )
  const sellList = useMemo(() => {
    const seen = new Map<string, TokenInfo>()
    for (const p of clPools) {
      for (const a of [p.token0, p.token1]) {
        const t = data?.tokens[a.toLowerCase()]
        if (t && !seen.has(a.toLowerCase())) seen.set(a.toLowerCase(), t)
      }
    }
    return [...seen.values()]
  }, [clPools, data])

  const buyList = useMemo(() => {
    if (!sellAddr) return []
    const s = sellAddr.toLowerCase()
    const seen = new Map<string, TokenInfo>()
    for (const p of clPools) {
      const other =
        p.token0.toLowerCase() === s ? p.token1 : p.token1.toLowerCase() === s ? p.token0 : null
      if (other) {
        const t = data?.tokens[other.toLowerCase()]
        if (t && !seen.has(other.toLowerCase())) seen.set(other.toLowerCase(), t)
      }
    }
    return [...seen.values()]
  }, [clPools, data, sellAddr])

  const sell = sellAddr ? (data?.tokens[sellAddr.toLowerCase()] ?? null) : null
  const buy = buyAddr ? (data?.tokens[buyAddr.toLowerCase()] ?? null) : null

  // defaults: sell UP → WETH (the "exit farm rewards" case)
  useEffect(() => {
    if (!sellAddr && sellList.length) {
      const up = sellList.find((t) => t.address.toLowerCase() === ADDR.UP.toLowerCase())
      setSellAddr((up ?? sellList[0]).address)
    }
  }, [sellList, sellAddr])
  useEffect(() => {
    if (!buyList.length) return
    if (!buyAddr || !buyList.some((t) => t.address.toLowerCase() === buyAddr.toLowerCase())) {
      const weth = buyList.find((t) => t.address.toLowerCase() === ADDR.WETH.toLowerCase())
      setBuyAddr((weth ?? buyList[0]).address)
    }
  }, [buyList, buyAddr])

  const pairPools = useMemo(() => {
    if (!sellAddr || !buyAddr) return []
    const a = sellAddr.toLowerCase()
    const b = buyAddr.toLowerCase()
    return clPools
      .filter((p) => {
        const t0 = p.token0.toLowerCase()
        const t1 = p.token1.toLowerCase()
        return (t0 === a && t1 === b) || (t0 === b && t1 === a)
      })
      .sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0))
  }, [clPools, sellAddr, buyAddr])
  const poolBase = pairPools.find((p) => p.address === poolAddr) ?? pairPools[0] ?? null

  // fast slot0 feed for the selected pool: band + market price track live
  const liveQ = useLiveSlot0(poolBase ? [poolBase.address] : [])
  const pool = useMemo(() => {
    if (!poolBase) return null
    const l = liveQ.data?.[poolBase.address.toLowerCase()]
    return l ? { ...poolBase, tick: l.tick, sqrtPriceX96: l.sqrtPriceX96 } : poolBase
  }, [poolBase, liveQ.data])

  const bal = useBalances(user, sellAddr ? [sellAddr] : [])
  const balSell = sellAddr ? bal.data?.[sellAddr.toLowerCase()] : undefined
  const upPrice = useUpPrice()
  const stats = usePoolStats()

  const t0 = pool ? (data?.tokens[pool.token0.toLowerCase()] ?? null) : null
  const t1 = pool ? (data?.tokens[pool.token1.toLowerCase()] ?? null) : null
  const side: LimitSide | null = pool && sellAddr ? limitSideFor(pool, sellAddr) : null

  // USD context via USDG/WETH/UP anchors (display only)
  const usd = useMemo(() => {
    if (!pool || !t0 || !t1 || !side) return null
    const px = clTokenUsd(pool, t0.decimals, t1.decimals, upPrice.data, stats.data?.wethUsd)
    if (!px) return null
    return { sell: side === 'sell0' ? px.p0 : px.p1, buy: side === 'sell0' ? px.p1 : px.p0 }
  }, [pool, t0, t1, side, upPrice.data, stats.data?.wethUsd])

  const preset = BANDS.find((b) => b.id === bandId)
  const loPct = preset ? preset.lo : Number(loStr)
  const hiPct = preset ? preset.hi : Number(hiStr)
  const ticks =
    pool && side ? (bandId === 'tight' ? tightTicks(pool, side) : bandTicks(pool, side, loPct, hiPct)) : null
  // does a preset/custom band collapse onto the tight band? (sub-spacing inputs snap)
  const tight = pool && side ? tightTicks(pool, side) : null
  const isTightBand = !!(ticks && tight && ticks.lower === tight.lower && ticks.upper === tight.upper)

  const amt = useMemo(() => {
    try {
      return sell ? parseUnits(amtStr === '' ? '0' : amtStr, sell.decimals) : 0n
    } catch {
      return 0n
    }
  }, [amtStr, sell])
  const insufficient = balSell !== undefined && amt > balSell

  // band premiums after tick snapping + full-fill projection
  const calc = useMemo(() => {
    if (!pool || !side || !ticks || !t0 || !t1 || !sell || !buy) return null
    const spot01 = sqrtPriceToPrice(pool.sqrtPriceX96, t0.decimals, t1.decimals)
    if (!Number.isFinite(spot01) || spot01 <= 0) return null
    const px = (t: number) => tickToPrice(t, t0.decimals, t1.decimals)
    const spotSell = side === 'sell0' ? spot01 : 1 / spot01
    const premLo = side === 'sell0' ? px(ticks.lower) / spot01 - 1 : spot01 / px(ticks.upper) - 1
    const premHi = side === 'sell0' ? px(ticks.upper) / spot01 - 1 : spot01 / px(ticks.lower) - 1
    const sqrtA = getSqrtRatioAtTick(ticks.lower)
    const sqrtB = getSqrtRatioAtTick(ticks.upper)
    // avg fill premium = geometric mean of the band (amount-independent)
    const avgPrem = Math.sqrt((1 + premLo) * (1 + premHi)) - 1
    let proceeds: bigint | null = null
    let avgPx: number | null = null
    let feeShare: number | null = null
    if (amt > 0n) {
      const L =
        side === 'sell0'
          ? getLiquidityForAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, amt, 0n)
          : getLiquidityForAmounts(pool.sqrtPriceX96, sqrtA, sqrtB, 0n, amt)
      if (L > 0n) {
        proceeds =
          side === 'sell0'
            ? getAmountsForLiquidity(sqrtB, sqrtA, sqrtB, L).amount1
            : getAmountsForLiquidity(sqrtA, sqrtA, sqrtB, L).amount0
        const amtH = Number(formatUnits(amt, sell.decimals))
        const outH = Number(formatUnits(proceeds, buy.decimals))
        if (amtH > 0) avgPx = outH / amtH
        // your share of active liquidity while price sits inside your band
        feeShare = Number(L) / (Number(pool.liquidity) + Number(L))
      }
    }
    return { spotSell, premLo, premHi, avgPrem, sqrtA, sqrtB, proceeds, avgPx, feeShare }
  }, [pool, side, ticks?.lower, ticks?.upper, t0, t1, sell, buy, amt])

  const setPct = (pct: number) => {
    if (balSell !== undefined && sell) setAmtStr(formatUnits((balSell * BigInt(pct)) / 100n, sell.decimals))
  }

  const place = async () => {
    if (!user || !pool || !side || !ticks || !sell || !buy || amt === 0n || !calc) return
    setBusy(true)
    try {
      if (!(await ensureAllowance(sell.address, user, ADDR.CL_PM, amt, sell.symbol))) return
      // re-check with a fresh price: the band must still be strictly out of range
      const fresh = await fetchSqrtPriceX96(pool.address)
      const stillOut = side === 'sell0' ? fresh < calc.sqrtA : fresh > calc.sqrtB
      if (!stillOut) {
        txlog.push('err', t('limit.bandEntered'))
        return
      }
      const minSell = applySlippage(amt, MIN_SELL_SLIP_BPS)
      await step(
        t('limit.stPlace', { amt: amtStr, sell: sell.symbol, buy: buy.symbol }),
        () =>
          writeContract(wagmiConfig, {
            abi: clPmAbi,
            address: ADDR.CL_PM,
            functionName: 'mint',
            args: [
              {
                token0: pool.token0,
                token1: pool.token1,
                tickSpacing: pool.tickSpacing,
                tickLower: ticks.lower,
                tickUpper: ticks.upper,
                amount0Desired: side === 'sell0' ? amt : 0n,
                amount1Desired: side === 'sell1' ? amt : 0n,
                amount0Min: side === 'sell0' ? minSell : 0n,
                amount1Min: side === 'sell1' ? minSell : 0n,
                recipient: user,
                deadline: deadline(),
                sqrtPriceX96: 0n,
              },
            ],
            chainId: CHAIN_ID,
          }),
        {
          onSuccess: (rcpt) => {
            const id = mintedTokenId(rcpt, user)
            if (id === null) return
            tagLimit(id, {
              sell: sell.address,
              buy: buy.address,
              sellSym: sell.symbol,
              buySym: buy.symbol,
              amountIn: amt.toString(),
              pool: pool.address,
              ts: Date.now(),
            })
            txlog.push('info', t('limit.orderLive', { id: id.toString(), sym: sell.symbol }), rcpt.transactionHash, {
              label: t('limit.track'),
              onClick: () => {
                location.hash = 'positions'
              },
            })
          },
        },
      )
      setAmtStr('')
    } finally {
      setBusy(false)
    }
  }

  if (pools.isLoading || !data)
    return (
      <div className="dim">
        {t('limit.loadingPools')}
        <span className="spin">▮</span>
      </div>
    )
  if (!sell) return <div className="dim">{t('limit.noPools')}</div>

  const amtH = sell && amt > 0n ? Number(formatUnits(amt, sell.decimals)) : 0

  return (
    <div>
      <div className="dim mono-sm" style={{ marginBottom: 8 }}>
        {t('limit.intro')}
      </div>
      <div className="form-row">
        <span className="lbl">{t('limit.sell')}</span>
        <TokenSelect list={sellList} value={sell} exclude={buy?.address} onChange={(tok) => setSellAddr(tok.address)} />
        <NumInput value={amtStr} onChange={setAmtStr} width={180} />
        {[25, 50, 75].map((p) => (
          <button key={p} className="chip" onClick={() => setPct(p)}>
            {p}%
          </button>
        ))}
        <button className="chip" onClick={() => setPct(100)}>
          {t('common.max')}
        </button>
        <span className="dim mono-sm">
          {t('common.bal')} {balSell !== undefined ? fmtAmount(balSell, sell.decimals) : '—'}
          {usd && amtH > 0 && <span> · ≈ {fmtUsd(amtH * usd.sell)}</span>}
          {insufficient && <span className="red"> {t('common.insufficient')}</span>}
        </span>
      </div>
      <div className="form-row">
        <span className="lbl">{t('limit.for')}</span>
        {buy ? (
          <TokenSelect list={buyList} value={buy} exclude={sell.address} onChange={(tok) => setBuyAddr(tok.address)} />
        ) : (
          <span className="dim mono-sm">{t('limit.noPairs', { sym: sell.symbol })}</span>
        )}
        {pool && buy && (
          <span className="dim mono-sm">
            {t('limit.market', { sell: sell.symbol })}{' '}
            <Flash v={calc?.spotSell} arrow>
              {calc ? fmtNum(calc.spotSell) : '—'} {buy.symbol}
            </Flash>{' '}
            · 1 {buy.symbol} = {calc ? fmtNum(1 / calc.spotSell) : '—'} {sell.symbol}
            {pairPools.length === 1 && (
              <>
                {' '}
                · {t('limit.poolChip', { ts: pool.tickSpacing, fee: (pool.feePpm / 10_000).toFixed(2) })}
              </>
            )}
          </span>
        )}
      </div>
      {pairPools.length > 1 && (
        <div className="form-row">
          <span className="lbl">{t('limit.pool')}</span>
          {pairPools.map((p) => (
            <button
              key={p.address}
              className={`chip ${p.address === pool?.address ? 'on' : ''}`}
              onClick={() => setPoolAddr(p.address)}
            >
              ts{p.tickSpacing} · {(p.feePpm / 10_000).toFixed(2)}%
            </button>
          ))}
        </div>
      )}
      {!pool && buy && <div className="dim mono-sm">{t('limit.noPoolFor', { pair: `${sell.symbol}/${buy.symbol}` })}</div>}

      {pool && buy && (
        <>
          <div className="form-row">
            <span className="lbl">{t('limit.sellBand')}</span>
            <button className={`chip ${explain ? 'on' : ''}`} onClick={() => setExplain(!explain)} title={t('limit.explainTip')}>
              ?
            </button>
            <button
              className={`chip ${bandId === 'tight' ? 'on' : ''}`}
              onClick={() => setBandId('tight')}
              title={t('limit.tightTip')}
            >
              {t('limit.tight')}
            </button>
            {BANDS.map((b) => (
              <button key={b.id} className={`chip ${bandId === b.id ? 'on' : ''}`} onClick={() => setBandId(b.id)}>
                +{b.lo}→{b.hi}%
              </button>
            ))}
            <button className={`chip ${bandId === 'custom' ? 'on' : ''}`} onClick={() => setBandId('custom')}>
              {t('limit.custom')}
            </button>
            {bandId === 'custom' && (
              <>
                <span className="dim mono-sm">+</span>
                <NumInput value={loStr} onChange={setLoStr} width={64} />
                <span className="dim mono-sm">% → +</span>
                <NumInput value={hiStr} onChange={setHiStr} width={64} />
                <span className="dim mono-sm">{t('limit.aboveMarket')}</span>
              </>
            )}
          </div>
          {explain && (
            <div className="spec">
              <div className="spec-hd">{t('limit.exTitle')}</div>
              <div className="spec-row">
                <span className="sk">{t('limit.exStart')}</span>
                <span className="sv green">{calc ? `+${(calc.premLo * 100).toFixed(1)}%` : '+x%'}</span>
                <span className="sd">{t('limit.exStartSd', { sym: sell.symbol })}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.exEnd')}</span>
                <span className="sv green">{calc ? `+${(calc.premHi * 100).toFixed(1)}%` : '+y%'}</span>
                <span className="sd">{t('limit.exEndSd', { sym: sell.symbol })}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.exAvg')}</span>
                <span className="sv green">{calc ? `+${(calc.avgPrem * 100).toFixed(1)}%` : '√(s·e)'}</span>
                <span className="sd">{t('limit.exAvgSd')}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.exGrid')}</span>
                <span className="sv">ts{pool.tickSpacing}</span>
                <span className="sd">
                  {t('limit.exGridSd', { ts: pool.tickSpacing, pct: (pool.tickSpacing / 100).toFixed(1) })}
                </span>
              </div>
            </div>
          )}

          {ticks && calc ? (
            <div className="spec">
              <div className="spec-hd">{t('limit.orderTitle')}</div>
              <div className="spec-row">
                <span className="sk">{t('limit.fillStarts')}</span>
                <span className="sv green">
                  <Flash v={calc.premLo}>+{(calc.premLo * 100).toFixed(1)}%</Flash>
                </span>
                <span className="sd">
                  {t('limit.priceEq', {
                    sell: sell.symbol,
                    px: fmtNum(calc.spotSell * (1 + calc.premLo)),
                    buy: buy.symbol,
                  })}
                </span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.fullySold')}</span>
                <span className="sv green">
                  <Flash v={calc.premHi}>+{(calc.premHi * 100).toFixed(1)}%</Flash>
                </span>
                <span className="sd">
                  {t('limit.priceEq', {
                    sell: sell.symbol,
                    px: fmtNum(calc.spotSell * (1 + calc.premHi)),
                    buy: buy.symbol,
                  })}
                </span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.avgFill')}</span>
                <span className="sv green">+{(calc.avgPrem * 100).toFixed(1)}%</span>
                <span className="sd">
                  {t('limit.priceApprox', {
                    sell: sell.symbol,
                    px: fmtNum(calc.spotSell * (1 + calc.avgPrem)),
                    buy: buy.symbol,
                  })}
                </span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.band')}</span>
                <span className="sv">
                  [{ticks.lower} → {ticks.upper}]
                </span>
                <span className="sd">
                  {t('limit.bandSd', { ts: pool.tickSpacing, pct: (pool.tickSpacing / 100).toFixed(1) })}
                  {bandId === 'tight' ? (
                    <> · {t('limit.bandTight')}</>
                  ) : isTightBand ? (
                    <span className="cyan"> · {t('limit.bandSnaps')}</span>
                  ) : null}
                </span>
              </div>
              {t0 && t1 && (
                <div style={{ padding: '0 10px' }}>
                  <RangeBar
                    tickLower={ticks.lower}
                    tickUpper={ticks.upper}
                    tick={pool.tick}
                    sqrtPriceX96={pool.sqrtPriceX96}
                    dec0={t0.decimals}
                    dec1={t1.decimals}
                    sym0={t0.symbol}
                    sym1={t1.symbol}
                    order={{ fillFrac: 0, sellSym: sell.symbol, buySym: buy.symbol }}
                  />
                </div>
              )}
              {calc.avgPx != null && calc.proceeds != null && (
                <>
                  <div className="spec-hd">{t('limit.projTitle')}</div>
                  <div className="spec-row">
                    <span className="sk">{t('limit.projSell')}</span>
                    <span className="sv">
                      {amtStr} {sell.symbol}
                    </span>
                    <span className="sd">
                      {t('limit.projSellSd', { px: fmtNum(calc.avgPx), buy: buy.symbol })}{' '}
                      <span className="green">
                        {t('limit.projVsMarket', { pct: ((calc.avgPx / calc.spotSell - 1) * 100).toFixed(1) })}
                      </span>
                    </span>
                  </div>
                  <div className="spec-row">
                    <span className="sk">{t('limit.projReceive')}</span>
                    <span className="sv green">
                      {fmtAmount(calc.proceeds, buy.decimals)} {buy.symbol}
                    </span>
                    <span className="sd">
                      {usd && <>≈ {fmtUsd(Number(formatUnits(calc.proceeds, buy.decimals)) * usd.buy)} · </>}
                      {t('limit.projWhenFilled')}
                    </span>
                  </div>
                  {(() => {
                    const stat = stats.data?.byPool[pool.address.toLowerCase()]
                    return calc.feeShare != null && stat?.vol24hUsd != null ? (
                      <div className="spec-row">
                        <span className="sk">{t('limit.projFeeIncome')}</span>
                        <span className="sv green">
                          ≈ {fmtUsd(stat.vol24hUsd * (pool.feePpm / 1e6) * (1 - pool.unstakedFeePpm / 1e6) * calc.feeShare)}
                          /d
                        </span>
                        <span className="sd">{t('limit.projFeeIncomeSd', { share: (calc.feeShare * 100).toFixed(1) })}</span>
                      </div>
                    ) : (
                      <div className="spec-row">
                        <span className="sk">{t('limit.projFeeIncome')}</span>
                        <span className="sv green">{(pool.feePpm / 10_000).toFixed(2)}%</span>
                        <span className="sd">{t('limit.projFeePct')}</span>
                      </div>
                    )
                  })()}
                </>
              )}
              <div className="spec-hd">{t('limit.feesTitle')}</div>
              <div className="spec-row">
                <span className="sk">{t('limit.thisOrder')}</span>
                <span className="sv green">0%</span>
                <span className="sd">{t('limit.makerSd')}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.marketSwap')}</span>
                <span className="sv red">{(pool.feePpm / 10_000).toFixed(2)}%</span>
                <span className="sd">
                  {amt > 0n && usd
                    ? t('limit.takerLoss', { usd: fmtUsd(amtH * usd.sell * (pool.feePpm / 1e6)) })
                    : t('limit.takerSd')}
                </span>
              </div>
              <div className="spec-hd">{t('limit.mechTitle')}</div>
              <div className="spec-row">
                <span className="sk">{t('limit.mechFills')}</span>
                <span className="sv green">{sell.symbol} ↑</span>
                <span className="sd">{t('limit.mechFillsSd', { buy: buy.symbol })}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.mechUnfills')}</span>
                <span className="sv amber">{sell.symbol} ↓</span>
                <span className="sd">{t('limit.mechUnfillsSd')}</span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.mechAfter')}</span>
                <span className="sv">{t('limit.mechWithdraw')}</span>
                <span className="sd">
                  <a href="#positions">{t('hdr.positions')}</a> {t('limit.mechAfterSd')}
                </span>
              </div>
              <div className="spec-row">
                <span className="sk">{t('limit.mechStaking')}</span>
                <span className="sv amber">{t('limit.mechDont')}</span>
                <span className="sd">{t('limit.mechStakingSd')}</span>
              </div>
            </div>
          ) : (
            <div className="dim mono-sm">{t('limit.invalidBand')}</div>
          )}

          <div className="form-row" style={{ marginTop: 8 }}>
            <Btn
              big
              busy={busy}
              disabled={!user || !ticks || amt === 0n || insufficient || !calc}
              onClick={place}
            >
              {!user ? t('common.connectWallet') : insufficient ? t('common.insufficientBalance') : t('limit.place')}
            </Btn>
            {user && ticks && calc && amt > 0n && <span className="dim mono-sm">{t('limit.placeHint')}</span>}
          </div>
        </>
      )}
    </div>
  )
}
