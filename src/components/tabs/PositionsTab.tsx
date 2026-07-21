import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { readContract, writeContract } from 'wagmi/actions'
import { parseUnits } from 'viem'
import { clGaugeAbi, clPmAbi, clPoolAbi, uniV3PoolAbi, v2GaugeAbi, v2PoolAbi, v2RouterAbi } from '../../abi'
import { ADDR, CHAIN_ID, EXPLORER, UNI } from '../../config/addresses'
import { wagmiConfig } from '../../config/wagmi'
import {
  MAX_TICK,
  MAX_UINT128,
  MIN_TICK,
  applySlippage,
  getAmountsForLiquidity,
  getLiquidityForAmounts,
  getSqrtRatioAtTick,
  minAmountsForLiquidity,
  previewDeposit,
} from '../../lib/clmath'
import { fmtApr } from '../../lib/apr'
import { fmtAmount, fmtNum, fmtUsd, shortAddr } from '../../lib/format'
import { limitFillFrac, limitSideFor, limitTagOf, untagLimit } from '../../lib/limit'
import { clPosMetrics, v2PosMetrics, type Earning } from '../../lib/posmetrics'
import type { PoolStat } from '../../lib/poolstats'
import { deadline, ensureAllowance, fetchSqrtPriceX96, offerSwapClaimedUp, receivedOf, step } from '../../lib/tx'
import { txlog } from '../../lib/txlog'
import { executeZap, planZap, type ZapTarget } from '../../lib/zap'
import { tokenOf, usePools } from '../../hooks/usePools'
import { useBalances } from '../../hooks/useBalances'
import { usePositions } from '../../hooks/usePositions'
import { useWatch, type WatchRow } from '../../hooks/useWatch'
import { usePoolStats } from '../../hooks/usePoolStats'
import { useUniPoolStats } from '../../hooks/useUniPoolStats'
import { useUpPrice } from '../../hooks/useUpPrice'
import { useLiveSlot0, type LiveSlot0 } from '../../hooks/useLiveSlot0'
import type { Address } from 'viem'
import type { ClPosition, Pool, PoolsData, TokenInfo, V2Position } from '../../types'
import { Flash } from '../Flash'
import { ProtoBadge } from '../ProtoBadge'
import { RangeBar } from '../RangeBar'
import { ZapPanel } from '../ZapPanel'
import { FundSwitch } from './PoolsTab'
import { AmountRow, Badge, Btn, Stat } from '../ui'

const SLIP_BPS = 100 // 1% mins on liquidity ops

export function PositionsTab() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const pools = usePools()
  const positions = usePositions(user)
  const stats = usePoolStats() // up33 pool 24h stats + the WETH/USD anchor
  const upPrice = useUpPrice()
  const watch = useWatch(user) // indexer-side tracking (PnL history + alerts)
  const [claimBusy, setClaimBusy] = useState(false)

  // indexer stats for the specific uniswap pools the user is LPing
  const uniAddrs = useMemo(
    () =>
      [...new Set((positions.data?.cl ?? []).filter((p) => p.pool.protocol === 'univ3').map((p) => p.pool.address))],
    [positions.data],
  )
  const uniStats = useUniPoolStats(uniAddrs)

  // pools hosting range orders get a fast (4s) slot0 feed so fill % feels live.
  // limit tags are keyed by tokenId, which is only unique per NPM — they are
  // minted via the UP33 CL_PM, so never attribute them to univ3 positions.
  const orderPools = useMemo(() => {
    const set = new Set<Address>()
    for (const p of positions.data?.cl ?? [])
      if (p.pool.protocol === 'up33' && limitTagOf(p.tokenId)) set.add(p.pool.address)
    return [...set]
  }, [positions.data])
  const live = useLiveSlot0(orderPools)
  const liveOf = (p: ClPosition): LiveSlot0 | undefined => live.data?.[p.pool.address.toLowerCase()]
  const statOf = (pool: Pool): PoolStat | undefined =>
    pool.protocol === 'univ3'
      ? uniStats.data?.[pool.address.toLowerCase()]
      : stats.data?.byPool[pool.address.toLowerCase()]

  const claimables = useMemo(() => {
    const cl = positions.data?.cl.filter((p) => p.staked && p.earned > 0n && p.pool.gauge) ?? []
    const v2 = positions.data?.v2.filter((p) => p.earned > 0n && p.pool.gauge) ?? []
    return { cl, v2, count: cl.length + v2.length }
  }, [positions.data])

  if (!user)
    return (
      <div className="dim">
        {t('pos.connectPrompt')} <a href="#pools">{t('pos.browsePools')}</a>
      </div>
    )
  if (positions.isLoading || !pools.data)
    return (
      <div className="dim">
        {t('pos.scanning')}
        <span className="spin">▮</span>
      </div>
    )
  if (positions.isError) return <div className="red">{t('pos.scanFailed', { err: String(positions.error) })}</div>

  const data = positions.data!
  const pendingUp = data.cl.reduce((a, x) => a + x.earned, 0n) + data.v2.reduce((a, x) => a + x.earned, 0n)
  const upUsd = upPrice.data
  const wethUsd = stats.data?.wethUsd

  // portfolio roll-up: value / uncollected fees / UP accrual rate. Uses the
  // 15s positions snapshot (cards refine with the fast feed where they have it)
  const tokAll: Record<string, TokenInfo> = { ...pools.data.tokens, ...data.tokens }
  const clVal = new Map<ClPosition, number | null>()
  const v2Val = new Map<V2Position, number | null>()
  let lpValue = 0
  let unpriced = 0
  let feesUsdTotal = 0
  let upPerDayTotal = 0
  for (const p of data.cl) {
    const t0 = tokAll[p.pool.token0.toLowerCase()]
    const t1 = tokAll[p.pool.token1.toLowerCase()]
    if (!t0 || !t1) {
      unpriced++
      clVal.set(p, null)
      continue
    }
    const m = clPosMetrics({
      pos: p,
      amount0: p.amount0,
      amount1: p.amount1,
      tick: liveOf(p)?.tick ?? p.pool.tick,
      dec0: t0.decimals,
      dec1: t1.decimals,
      stat: statOf(p.pool),
      upUsd,
      wethUsd,
    })
    clVal.set(p, m.valueUsd)
    if (m.valueUsd === null) unpriced++
    else lpValue += m.valueUsd + (m.feesUsd ?? 0)
    if (m.feesUsd) feesUsdTotal += m.feesUsd
    if (m.earning.kind === 'emissions') upPerDayTotal += m.earning.upPerDay
  }
  for (const p of data.v2) {
    const t0 = tokAll[p.pool.token0.toLowerCase()]
    const t1 = tokAll[p.pool.token1.toLowerCase()]
    if (!t0 || !t1) {
      unpriced++
      v2Val.set(p, null)
      continue
    }
    const m = v2PosMetrics({ pos: p, dec0: t0.decimals, dec1: t1.decimals, stat: statOf(p.pool), upUsd, wethUsd })
    v2Val.set(p, m.valueUsd)
    if (m.valueUsd === null) unpriced++
    else lpValue += m.valueUsd + (m.feesUsd ?? 0)
    if (m.feesUsd) feesUsdTotal += m.feesUsd
    if (m.staked?.kind === 'emissions') upPerDayTotal += m.staked.upPerDay
  }
  const pendingUpUsd = upUsd !== undefined ? (Number(pendingUp) / 1e18) * upUsd : null

  // display order: staked first, then up33 wallet, then uniswap — biggest first
  const rank = (p: ClPosition) => (p.staked ? 0 : p.pool.protocol === 'up33' ? 1 : 2)
  const clSorted = [...data.cl].sort(
    (a, b) => rank(a) - rank(b) || (clVal.get(b) ?? -1) - (clVal.get(a) ?? -1),
  )
  const v2Sorted = [...data.v2].sort((a, b) => (v2Val.get(b) ?? -1) - (v2Val.get(a) ?? -1))
  // a range order is SUPPOSED to sit out of range — don't count it as an anomaly
  const outOfRange = data.cl.filter((x) => {
    if (x.pool.protocol === 'up33' && limitTagOf(x.tokenId)) return false
    const tick = liveOf(x)?.tick ?? x.pool.tick
    return tick < x.tickLower || tick >= x.tickUpper
  }).length

  // range orders placed via SWAP → LIMIT (tagged locally, UP33-minted only)
  const orders = data.cl
    .map((p) => ({ p, tag: p.pool.protocol === 'up33' ? limitTagOf(p.tokenId) : null }))
    .filter((x): x is { p: ClPosition; tag: NonNullable<ReturnType<typeof limitTagOf>> } => !!x.tag && x.p.liquidity > 0n)
  const ordersFilled = orders.filter(
    (x) =>
      limitFillFrac(
        limitSideFor(x.p.pool, x.tag.sell),
        liveOf(x.p)?.sqrtPriceX96 ?? x.p.pool.sqrtPriceX96,
        getSqrtRatioAtTick(x.p.tickLower),
        getSqrtRatioAtTick(x.p.tickUpper),
      ) >= 0.999,
  ).length

  const claimAll = async () => {
    setClaimBusy(true)
    try {
      for (const p of claimables.cl) {
        const h = await step(
          t('pos.stClaim', { id: p.tokenId.toString() }),
          () =>
            writeContract(wagmiConfig, {
              abi: clGaugeAbi,
              address: p.pool.gauge!,
              functionName: 'getReward',
              args: [p.tokenId],
              chainId: CHAIN_ID,
            }),
          { onSuccess: offerSwapClaimedUp(user) },
        )
        if (!h) return
      }
      for (const p of claimables.v2) {
        const t0 = tokenOf(pools.data, p.pool.token0)
        const t1 = tokenOf(pools.data, p.pool.token1)
        const h = await step(
          t('pos.stClaimV2', { pair: `${t0.symbol}/${t1.symbol}` }),
          () =>
            writeContract(wagmiConfig, {
              abi: v2GaugeAbi,
              address: p.pool.gauge!,
              functionName: 'getReward',
              args: [user],
              chainId: CHAIN_ID,
            }),
          { onSuccess: offerSwapClaimedUp(user) },
        )
        if (!h) return
      }
    } finally {
      setClaimBusy(false)
    }
  }

  if (data.cl.length === 0 && data.v2.length === 0)
    return (
      <div className="dim">
        {t('pos.empty', { addr: user.slice(0, 8) })} <a href="#pools">{t('pos.emptyCta')}</a>
      </div>
    )

  return (
    <div>
      <div className="grid2">
        <Stat
          k={t('pos.lpValue')}
          v={
            lpValue > 0 ? (
              <Flash v={lpValue}>
                <span>{fmtUsd(lpValue)}</span>
              </Flash>
            ) : (
              '—'
            )
          }
          sub={`${t('pos.lpValueSub', {
            cl: data.cl.length,
            v2: data.v2.length,
            staked: data.cl.filter((p) => p.staked).length,
          })}${feesUsdTotal > 0.01 ? ` · ${t('pos.lpValueFees', { usd: fmtUsd(feesUsdTotal) })}` : ''}${
            unpriced > 0 ? ` · ${t('pos.lpValueUnpriced', { n: unpriced })}` : ''
          }`}
        />
        <Stat
          k={t('pos.pendingUp')}
          v={
            <Flash v={Number(pendingUp)} arrow>
              <span className={pendingUp > 0n ? 'green' : ''}>
                {fmtAmount(pendingUp, 18)}
                {pendingUpUsd !== null && pendingUp > 0n && (
                  <span className="dim"> ≈ {fmtUsd(pendingUpUsd)}</span>
                )}
              </span>
            </Flash>
          }
          sub={
            <>
              {upPerDayTotal > 0 && (
                <span className="green">
                  {t('pos.upPerDay', { n: fmtNum(upPerDayTotal, 3) })}
                  {upUsd !== undefined ? ` ${t('pos.upPerDayUsd', { usd: fmtUsd(upPerDayTotal * upUsd) })}` : ''}
                  {claimables.count > 0 ? ' · ' : ''}
                </span>
              )}
              {claimables.count > 0 ? (
                <Btn busy={claimBusy} onClick={claimAll}>
                  {t('pos.claimAll', { n: claimables.count })}
                </Btn>
              ) : upPerDayTotal > 0 ? null : (
                t('pos.nothingClaimable')
              )}
            </>
          }
        />
        <Stat
          k={t('pos.rangeStatus')}
          v={
            outOfRange > 0 ? (
              <span className="red">{t('pos.outOfRangeN', { n: outOfRange })}</span>
            ) : (
              <span className="green">{t('pos.allInRange')}</span>
            )
          }
          sub={`${t('pos.rangeStatusSub')}${orders.length > 0 ? ` · ${t('pos.ordersNotCounted')}` : ''}`}
        />
        {orders.length > 0 && (
          <Stat
            k={t('pos.rangeOrders')}
            v={t('pos.ordersOpen', { n: orders.length })}
            sub={
              ordersFilled > 0 ? (
                <span className="green">{t('pos.ordersFilled', { n: ordersFilled })}</span>
              ) : (
                t('pos.ordersNone')
              )
            }
          />
        )}
        {watch.data?.watched && watch.data.rows.length > 0 && (
          <Stat
            k={t('pos.trackedPnl')}
            v={(() => {
              // closed rows keep contributing what they earned while tracked
              const earned = watch.data.rows.reduce((a, r) => a + r.collectedUsd + (r.closed ? 0 : (r.feesUsd ?? 0)), 0)
              return <span className={earned > 0 ? 'green' : ''}>{t('pos.trackedEarned', { usd: fmtUsd(earned) })}</span>
            })()}
            sub={t('pos.trackedSub', {
              n: watch.data.rows.filter((r) => !r.closed).length,
              date: new Date(Math.min(...watch.data.rows.map((r) => r.firstTs)) * 1000).toISOString().slice(0, 10),
              tg: watch.data.telegram ? 'ON' : 'OFF',
            })}
          />
        )}
      </div>

      <div className="section-title">{t('pos.sectionCl', { n: data.cl.length })}</div>
      {data.cl.length === 0 && (
        <div className="dim">
          {t('pos.noCl')} <a href="#pools">{t('pos.noClCta')}</a>
        </div>
      )}
      {clSorted.map((p) => (
        // tokenIds are only unique per NPM — prefix the protocol in the key
        <ClCard
          key={`${p.pool.protocol}-${p.tokenId}`}
          pos={p}
          data={pools.data!}
          xtokens={data.tokens}
          user={user}
          live={liveOf(p)}
          stat={statOf(p.pool)}
          upUsd={upUsd}
          wethUsd={wethUsd}
          watchRow={watch.data?.byKey.get(`${p.pool.protocol === 'univ3' ? 'univ3' : 'up33'}|${p.tokenId}`)}
        />
      ))}
      <div className="section-title">{t('pos.sectionV2', { n: data.v2.length })}</div>
      {data.v2.length === 0 && (
        <div className="dim">
          {t('pos.noV2')} <a href="#pools">{t('pos.noV2Cta')}</a>
        </div>
      )}
      {v2Sorted.map((p) => (
        <V2Card
          key={p.pool.address}
          pos={p}
          data={pools.data!}
          user={user}
          stat={statOf(p.pool)}
          upUsd={upUsd}
          wethUsd={wethUsd}
        />
      ))}
    </div>
  )
}

// ---------------- CL ----------------

export function ClCard({
  pos,
  data,
  xtokens,
  user,
  live,
  stat,
  upUsd,
  wethUsd,
  watchRow,
}: {
  pos: ClPosition
  data: PoolsData
  xtokens: Record<string, TokenInfo>
  user: `0x${string}`
  live?: LiveSlot0
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
  watchRow?: WatchRow
}) {
  const { t } = useTranslation()
  const t0 = xtokens[pos.pool.token0.toLowerCase()] ?? tokenOf(data, pos.pool.token0)
  const t1 = xtokens[pos.pool.token1.toLowerCase()] ?? tokenOf(data, pos.pool.token1)
  const [busy, setBusy] = useState(false)
  const [panel, setPanel] = useState<null | 'inc' | 'dec' | 'rr'>(null)
  const [armed, setArmed] = useState(false)

  // all NPM write entrypoints are signature-identical across protocols —
  // only the manager address differs
  const npm = pos.pool.protocol === 'univ3' ? UNI.V3_NPM : ADDR.CL_PM

  // prefer the fast slot0 feed (range-order pools) over the 20s pools query
  const curTick = live?.tick ?? pos.pool.tick
  const curSqrtP = live?.sqrtPriceX96 ?? pos.pool.sqrtPriceX96
  const sqrtA = getSqrtRatioAtTick(pos.tickLower)
  const sqrtB = getSqrtRatioAtTick(pos.tickUpper)
  const held =
    live && pos.liquidity > 0n ? getAmountsForLiquidity(curSqrtP, sqrtA, sqrtB, pos.liquidity) : { amount0: pos.amount0, amount1: pos.amount1 }

  // range-order bookkeeping (placed via SWAP → LIMIT on this frontend; tags
  // are tokenId-keyed and UP33-minted, so never read them for univ3 ids)
  const limitTag = pos.pool.protocol === 'up33' ? limitTagOf(pos.tokenId) : null
  const limitFill = limitTag ? limitFillFrac(limitSideFor(pos.pool, limitTag.sell), curSqrtP, sqrtA, sqrtB) : 0

  const m = clPosMetrics({
    pos,
    amount0: held.amount0,
    amount1: held.amount1,
    tick: curTick,
    dec0: t0.decimals,
    dec1: t1.decimals,
    stat,
    upUsd,
    wethUsd,
  })

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const withdrawClick = () => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 3000)
      return
    }
    setArmed(false)
    void decrease(100)
  }

  const stake = () =>
    run(async () => {
      if (!pos.pool.gauge) return
      const approved = await readContract(wagmiConfig, {
        abi: clPmAbi,
        address: npm,
        functionName: 'getApproved',
        args: [pos.tokenId],
        chainId: CHAIN_ID,
      })
      if (approved.toLowerCase() !== pos.pool.gauge.toLowerCase()) {
        const ok = await step(t('pos.stApproveNft', { id: pos.tokenId.toString() }), () =>
          writeContract(wagmiConfig, {
            abi: clPmAbi,
            address: npm,
            functionName: 'approve',
            args: [pos.pool.gauge!, pos.tokenId],
            chainId: CHAIN_ID,
          }),
        )
        if (!ok) return
      }
      await step(t('pos.stStake', { id: pos.tokenId.toString() }), () =>
        writeContract(wagmiConfig, {
          abi: clGaugeAbi,
          address: pos.pool.gauge!,
          functionName: 'deposit',
          args: [pos.tokenId],
          chainId: CHAIN_ID,
        }),
      )
    })

  // CLGauge.withdraw auto-claims accrued UP, so the swap offer applies here too
  const unstake = () =>
    run(() =>
      step(
        t('pos.stUnstake', { id: pos.tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            abi: clGaugeAbi,
            address: pos.pool.gauge!,
            functionName: 'withdraw',
            args: [pos.tokenId],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    )

  const claim = () =>
    run(() =>
      step(
        t('pos.stClaim', { id: pos.tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            abi: clGaugeAbi,
            address: pos.pool.gauge!,
            functionName: 'getReward',
            args: [pos.tokenId],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    )

  const collect = () =>
    run(() =>
      step(t('pos.stCollect', { id: pos.tokenId.toString() }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: npm,
          functionName: 'collect',
          args: [{ tokenId: pos.tokenId, recipient: user, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
          chainId: CHAIN_ID,
        }),
      ),
    )

  const decrease = (pct: number) =>
    run(async () => {
      const liq = (pos.liquidity * BigInt(Math.round(pct * 100))) / 10_000n
      if (liq === 0n) {
        txlog.push('err', t('pos.stNothingRemove'))
        return
      }
      // fresh price + band-edge mins: in-range token split is far more volatile
      // than value, flat mins on a cached price revert with 'PS'
      const sqrtP = await fetchSqrtPriceX96(pos.pool.address)
      const { amount0Min, amount1Min } = minAmountsForLiquidity(
        sqrtP,
        getSqrtRatioAtTick(pos.tickLower),
        getSqrtRatioAtTick(pos.tickUpper),
        liq,
        SLIP_BPS,
      )
      const ok1 = await step(t('pos.stDecrease', { id: pos.tokenId.toString(), pct }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: npm,
          functionName: 'decreaseLiquidity',
          args: [
            {
              tokenId: pos.tokenId,
              liquidity: liq,
              amount0Min,
              amount1Min,
              deadline: deadline(),
            },
          ],
          chainId: CHAIN_ID,
        }),
      )
      if (!ok1) return
      await step(t('pos.stCollectAll', { id: pos.tokenId.toString() }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: npm,
          functionName: 'collect',
          args: [{ tokenId: pos.tokenId, recipient: user, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
          chainId: CHAIN_ID,
        }),
      )
      if (pct === 100) untagLimit(pos.tokenId) // range order closed
      setPanel(null)
    })

  const gaugeOk = !!pos.pool.gauge && pos.pool.gaugeAlive
  const hasFees = pos.fees0 > 0n || pos.fees1 > 0n
  // out-of-range non-order positions earn nothing — offer the re-range flow
  const offBand = pos.liquidity > 0n && !limitTag && (curTick < pos.tickLower || curTick >= pos.tickUpper)

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">
          {t0.symbol}/{t1.symbol}
        </span>
        <ProtoBadge proto={pos.pool.protocol} />
        <Badge tone="cyan">
          CL {(pos.pool.feePpm / 10_000).toFixed(2)}% · ts{pos.pool.tickSpacing}
        </Badge>
        <a
          className="dim mono-sm"
          href={`${EXPLORER}/token/${npm}/instance/${pos.tokenId}`}
          target="_blank"
          rel="noreferrer"
        >
          #{pos.tokenId.toString()}↗
        </a>
        {pos.staked ? <Badge tone="green">{t('pos.staked')}</Badge> : <Badge tone="amber">{t('pos.wallet')}</Badge>}
        {limitTag && <Badge tone="cyan">{t('pos.limitBadge', { sell: limitTag.sellSym, buy: limitTag.buySym })}</Badge>}
        <div className="card-actions">
          {offBand && (
            <Btn busy={busy} onClick={() => setPanel(panel === 'rr' ? null : 'rr')} title={t('pos.rerangeTip')}>
              {t('pos.rerange')}
            </Btn>
          )}
          {pos.staked ? (
            <>
              <Btn busy={busy} onClick={claim} disabled={pos.earned === 0n} title={t('pos.claimUpTip')}>
                {t('pos.claimUp')}
              </Btn>
              <Btn busy={busy} onClick={unstake} tone="ghost" title={t('pos.unstakeTip')}>
                {t('pos.unstake')}
              </Btn>
            </>
          ) : (
            <>
              {gaugeOk && pos.liquidity > 0n && (
                <Btn busy={busy} onClick={stake} title={t('pos.stakeTip')}>
                  {t('pos.stake')}
                </Btn>
              )}
              <Btn busy={busy} onClick={collect} disabled={!hasFees} title={t('pos.collectFeesTip')}>
                {t('pos.collectFees')}
              </Btn>
              <Btn
                busy={busy}
                onClick={() => setPanel(panel === 'inc' ? null : 'inc')}
                tone="ghost"
                disabled={pos.liquidity === 0n && !hasFees}
                title={t('pos.incTip')}
              >
                {t('pos.inc')}
              </Btn>
              <Btn busy={busy} onClick={() => setPanel(panel === 'dec' ? null : 'dec')} tone="ghost" disabled={pos.liquidity === 0n}>
                {t('pos.dec')}
              </Btn>
              <Btn
                busy={busy}
                onClick={withdrawClick}
                tone="danger"
                disabled={pos.liquidity === 0n}
                title={t('pos.withdrawTip')}
              >
                {armed ? t('pos.withdrawConfirm') : t('pos.withdraw')}
              </Btn>
            </>
          )}
        </div>
      </div>

      <RangeBar
        tickLower={pos.tickLower}
        tickUpper={pos.tickUpper}
        tick={curTick}
        sqrtPriceX96={curSqrtP}
        dec0={t0.decimals}
        dec1={t1.decimals}
        sym0={t0.symbol}
        sym1={t1.symbol}
        order={limitTag ? { fillFrac: limitFill, sellSym: limitTag.sellSym, buySym: limitTag.buySym } : undefined}
      />

      {limitTag && !pos.staked && pos.liquidity > 0n && (
        <div className="form-row">
          <span className={`mono-sm ${limitFill >= 0.999 ? 'green' : limitFill > 0 ? 'amber' : 'dim'}`}>
            {t('pos.orderRow', { sell: limitTag.sellSym, buy: limitTag.buySym })}
          </span>
          <Btn busy={busy} tone={limitFill >= 0.999 ? 'default' : 'ghost'} onClick={() => decrease(100)}>
            {limitFill >= 0.999
              ? t('pos.orderLockIn', { sym: limitTag.buySym })
              : limitFill > 0
                ? t('pos.orderClose')
                : t('pos.orderCancel', { sym: limitTag.sellSym })}
          </Btn>
        </div>
      )}

      <div className="kv mono-sm">
        <span>
          <span className="k">{t('pos.value')}</span>
          {m.valueUsd !== null ? (
            <Flash v={m.valueUsd}>
              <b>{fmtUsd(m.valueUsd)}</b>
            </Flash>
          ) : (
            <span className="dim">{t('pos.noAnchor')}</span>
          )}
        </span>
        <span>
          <span className="k">{t('pos.holds')}</span>
          <Flash v={Number(held.amount0)}>
            <span>
              {fmtAmount(held.amount0, t0.decimals)} {t0.symbol}
            </span>
          </Flash>{' '}
          +{' '}
          <Flash v={Number(held.amount1)}>
            <span>
              {fmtAmount(held.amount1, t1.decimals)} {t1.symbol}
            </span>
          </Flash>
        </span>
        {pos.staked ? (
          <span>
            <span className="k">{t('pos.pendingUpK')}</span>
            <Flash v={Number(pos.earned)} arrow>
              <span className="green">
                {fmtAmount(pos.earned, 18)}
                {upUsd !== undefined && pos.earned > 0n && (
                  <span className="dim"> ≈ {fmtUsd((Number(pos.earned) / 1e18) * upUsd)}</span>
                )}
              </span>
            </Flash>
          </span>
        ) : (
          <span>
            <span className="k">{t('pos.fees')}</span>
            {fmtAmount(pos.fees0, t0.decimals)} {t0.symbol} + {fmtAmount(pos.fees1, t1.decimals)} {t1.symbol}
            {m.feesUsd !== null && m.feesUsd > 0.01 && <span className="amber"> ≈ {fmtUsd(m.feesUsd)}</span>}
            {pos.pool.protocol === 'up33' && <span className="dim"> {t('pos.levyNote')}</span>}
          </span>
        )}
      </div>
      {!limitTag && (
        <div className="kv mono-sm pos-earn">
          <span>
            <span className="k">{t('pos.earning')}</span>
            <EarnLine e={m.earning} />
          </span>
          {watchRow && (
            <span>
              <span className="k">{t('pos.pnlK')}</span>
              {(() => {
                const earned = watchRow.collectedUsd + (watchRow.feesUsd ?? 0)
                const dv =
                  m.valueUsd !== null && watchRow.firstValueUsd !== null ? m.valueUsd - watchRow.firstValueUsd : null
                return (
                  <>
                    <span className={earned > 0.005 ? 'green' : 'dim'}>
                      {t('pos.pnlEarned', { usd: fmtUsd(earned) })}
                    </span>
                    {dv !== null && Math.abs(dv) >= 0.01 && (
                      <span className={dv >= 0 ? 'green' : 'red'}>
                        {' '}· Δ {dv >= 0 ? '+' : '−'}{fmtUsd(Math.abs(dv))}
                      </span>
                    )}
                    <span className="dim">
                      {' '}{t('pos.pnlSince', { date: new Date(watchRow.firstTs * 1000).toISOString().slice(5, 10) })}
                    </span>
                  </>
                )
              })()}
            </span>
          )}
        </div>
      )}

      {panel === 'rr' && offBand && (
        <RerangePanel
          pos={pos}
          npm={npm}
          t0={t0}
          t1={t1}
          user={user}
          busy={busy}
          run={run}
          curTick={curTick}
          onDone={() => setPanel(null)}
        />
      )}

      {panel === 'inc' && !pos.staked && (
        <IncreasePanel
          pos={pos}
          npm={npm}
          t0sym={t0.symbol}
          t1sym={t1.symbol}
          dec0={t0.decimals}
          dec1={t1.decimals}
          user={user}
          busy={busy}
          run={run}
          sqrtP={curSqrtP}
          tick={curTick}
          held={held}
          isOrder={!!limitTag}
        />
      )}
      {panel === 'dec' && !pos.staked && (
        <div className="expander">
          <div className="form-row">
            <span className="lbl">{t('pos.remove')}</span>
            {[25, 50, 75, 100].map((p) => (
              <Btn key={p} busy={busy} onClick={() => decrease(p)} tone="ghost">
                {p}%
              </Btn>
            ))}
            <span className="dim mono-sm">{t('pos.removeHint', { slip: SLIP_BPS / 100 })}</span>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * RE-RANGE: close an out-of-range position and re-mint it centered on the
 * current price, funded by whatever the withdrawal returned (a single token
 * when fully out of range — the zap planner swaps ≈half via the gated Kyber
 * path). Every tx is wallet-signed individually; a halt at any step leaves all
 * value as plain wallet balances, never stranded.
 */
export function RerangePanel(props: {
  pos: ClPosition
  npm: Address
  t0: TokenInfo
  t1: TokenInfo
  user: `0x${string}`
  busy: boolean
  run: (fn: () => Promise<unknown>) => Promise<void>
  curTick: number
  onDone: () => void
}) {
  const { pos, t0, t1 } = props
  const { t } = useTranslation()
  const [mult, setMult] = useState<0.5 | 1 | 2>(1)
  const [armed, setArmed] = useState(false)

  const spacing = pos.pool.tickSpacing
  const baseWidth = pos.tickUpper - pos.tickLower

  /** band of width ≈ baseWidth·m centered on tick, snapped to spacing, tick strictly inside */
  const bandFor = (tick: number, m: number): { lower: number; upper: number } => {
    const width = Math.max(spacing, Math.round((baseWidth * m) / spacing) * spacing)
    let lower = Math.floor((tick - width / 2) / spacing) * spacing
    let upper = lower + width
    while (upper <= tick) {
      lower += spacing
      upper += spacing
    }
    const minU = Math.ceil(MIN_TICK / spacing) * spacing
    const maxU = Math.floor(MAX_TICK / spacing) * spacing
    return { lower: Math.max(lower, minU), upper: Math.min(upper, maxU) }
  }

  const prev = bandFor(props.curTick, mult)
  const px = (tk: number) => 1.0001 ** tk * 10 ** (t0.decimals - t1.decimals)
  const fp = (n: number) =>
    n >= 1000 ? Math.round(n).toLocaleString('en-US') : n >= 1 ? n.toPrecision(5) : n.toExponential(3)
  const halfPct = (1.0001 ** ((prev.upper - prev.lower) / 2) - 1) * 100

  const doIt = () =>
    props.run(async () => {
      const pool = pos.pool
      // 1) staked NFTs go back to the wallet first (withdraw auto-claims UP)
      if (pos.staked) {
        const h = await step(
          t('pos.stUnstake', { id: pos.tokenId.toString() }),
          () =>
            writeContract(wagmiConfig, {
              abi: clGaugeAbi,
              address: pool.gauge!,
              functionName: 'withdraw',
              args: [pos.tokenId],
              chainId: CHAIN_ID,
            }),
          { onSuccess: offerSwapClaimedUp(props.user) },
        )
        if (!h) return
      }
      // 2) close: decrease 100% then collect everything (fees compound into the new band)
      const sqrtPNow = await fetchSqrtPriceX96(pool.address)
      const mins = minAmountsForLiquidity(
        sqrtPNow,
        getSqrtRatioAtTick(pos.tickLower),
        getSqrtRatioAtTick(pos.tickUpper),
        pos.liquidity,
        SLIP_BPS,
      )
      const h1 = await step(t('pos.stDecrease', { id: pos.tokenId.toString(), pct: 100 }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: props.npm,
          functionName: 'decreaseLiquidity',
          args: [
            {
              tokenId: pos.tokenId,
              liquidity: pos.liquidity,
              amount0Min: mins.amount0Min,
              amount1Min: mins.amount1Min,
              deadline: deadline(),
            },
          ],
          chainId: CHAIN_ID,
        }),
      )
      if (!h1) return
      let got0 = 0n
      let got1 = 0n
      const h2 = await step(
        t('pos.stCollectAll', { id: pos.tokenId.toString() }),
        () =>
          writeContract(wagmiConfig, {
            abi: clPmAbi,
            address: props.npm,
            functionName: 'collect',
            args: [{ tokenId: pos.tokenId, recipient: props.user, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 }],
            chainId: CHAIN_ID,
          }),
        {
          onSuccess: (r) => {
            got0 = receivedOf(r, pool.token0, props.user)
            got1 = receivedOf(r, pool.token1, props.user)
          },
        },
      )
      if (!h2) return
      if (got0 === 0n && got1 === 0n) {
        txlog.push('err', t('pos.rrNothing'))
        return
      }
      // 3) fresh price → final band around it (the preview band may have drifted)
      const s0 = await readContract(wagmiConfig, {
        abi: pool.protocol === 'univ3' ? uniV3PoolAbi : clPoolAbi,
        address: pool.address,
        functionName: 'slot0',
        chainId: CHAIN_ID,
      })
      const freshSqrt = s0[0] as bigint
      const freshTick = Number(s0[1])
      const { lower, upper } = bandFor(freshTick, mult)
      // 4) fund the mint with the bigger side; the smaller stays as wallet dust
      const p1per0 = (Number(freshSqrt) / 2 ** 96) ** 2
      const inIs0 = Number(got0) * p1per0 >= Number(got1)
      const amountIn = inIs0 ? got0 : got1
      const target: ZapTarget = {
        kind: 'cl-mint',
        pool: { ...pool, sqrtPriceX96: freshSqrt, tick: freshTick },
        tickLower: lower,
        tickUpper: upper,
      }
      try {
        const plan = await planZap({ target, tokenIn: inIs0 ? pool.token0 : pool.token1, amountIn })
        const res = await executeZap({ plan, target, user: props.user, slipBps: SLIP_BPS, t0, t1 })
        if (!res.ok) return
      } catch (e) {
        txlog.push('err', t('pos.rrPlanFailed', { err: (e as Error).message }))
        return
      }
      const dust = inIs0 ? got1 : got0
      if (dust > 0n)
        txlog.push(
          'info',
          t('pos.rrDust', {
            amt: fmtAmount(dust, inIs0 ? t1.decimals : t0.decimals),
            sym: inIs0 ? t1.symbol : t0.symbol,
          }),
        )
      props.onDone()
    })

  const goClick = () => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 4000)
      return
    }
    setArmed(false)
    void doIt()
  }

  return (
    <div className="expander">
      <div className="form-row">
        <span className="lbl">{t('pos.rrWidth')}</span>
        {([0.5, 1, 2] as const).map((m) => (
          <Btn key={m} busy={props.busy} tone={mult === m ? 'default' : 'ghost'} onClick={() => setMult(m)}>
            {m === 1 ? t('pos.rrSame') : m === 0.5 ? t('pos.rrTight') : t('pos.rrWide')}
          </Btn>
        ))}
        <span className="dim mono-sm">
          {t('pos.rrPreview', {
            lo: fp(px(prev.lower)),
            hi: fp(px(prev.upper)),
            sym1: t1.symbol,
            sym0: t0.symbol,
            pct: halfPct.toFixed(1),
          })}
        </span>
      </div>
      <div className="form-row">
        <Btn busy={props.busy} tone="danger" onClick={goClick}>
          {armed ? t('pos.rrConfirm') : t('pos.rrGo')}
        </Btn>
        <span className="dim mono-sm">
          {(pos.staked ? t('pos.rrStepUnstake') : '') + t('pos.rrSteps')}
        </span>
      </div>
    </div>
  )
}

export function IncreasePanel(props: {
  pos: ClPosition
  npm: Address // position manager the NFT lives in (protocol-resolved)
  t0sym: string
  t1sym: string
  dec0: number
  dec1: number
  user: `0x${string}`
  busy: boolean
  run: (fn: () => Promise<unknown>) => Promise<void>
  sqrtP: bigint // live-aware current price (falls back to the 20s pools feed)
  tick: number
  held: { amount0: bigint; amount1: bigint }
  isOrder: boolean
}) {
  const { pos, dec0, dec1, sqrtP } = props
  const { t } = useTranslation()
  const [fund, setFund] = useState<'pair' | 'zap'>('pair')
  const [a0, setA0] = useState('')
  const [a1, setA1] = useState('')
  const bal = useBalances(props.user, [pos.pool.token0, pos.pool.token1])
  const bal0 = bal.data?.[pos.pool.token0.toLowerCase()]
  const bal1 = bal.data?.[pos.pool.token1.toLowerCase()]

  const below = props.tick < pos.tickLower // token0-only
  const above = props.tick >= pos.tickUpper // token1-only
  const sqrtA = getSqrtRatioAtTick(pos.tickLower)
  const sqrtB = getSqrtRatioAtTick(pos.tickUpper)

  const link = (v: string, editedIs0: boolean) => {
    if (editedIs0) setA0(v)
    else setA1(v)
    try {
      const amt = parseUnits(v === '' ? '0' : v, editedIs0 ? dec0 : dec1)
      const prev = previewDeposit(sqrtP, pos.tickLower, pos.tickUpper, amt, editedIs0)
      if (!prev) return
      if (editedIs0) setA1(prev.amount1 === 0n ? '0' : trimZeros(fmt(prev.amount1, dec1)))
      else setA0(prev.amount0 === 0n ? '0' : trimZeros(fmt(prev.amount0, dec0)))
    } catch {
      /* partial input */
    }
  }

  const amt0 = safeParse(a0, dec0)
  const amt1 = safeParse(a1, dec1)

  // what increaseLiquidity will actually do with the typed amounts: mint the
  // max liquidity both sides can fund at the live price, pull exactly that
  const sim = useMemo(() => {
    if (amt0 === 0n && amt1 === 0n) return null
    const liq = getLiquidityForAmounts(sqrtP, sqrtA, sqrtB, amt0, amt1)
    if (liq === 0n) return null
    const pull = getAmountsForLiquidity(sqrtP, sqrtA, sqrtB, liq)
    const growPct = pos.liquidity > 0n ? Number((liq * 10_000n) / pos.liquidity) / 100 : null
    return { liq, pull, growPct }
  }, [amt0, amt1, sqrtP, sqrtA, sqrtB, pos.liquidity])

  const over0 = bal0 !== undefined && amt0 > bal0
  const over1 = bal1 !== undefined && amt1 > bal1

  const increase = () =>
    props.run(async () => {
      if (amt0 === 0n && amt1 === 0n) return
      if (amt0 > 0n && !(await ensureAllowance(pos.pool.token0, props.user, props.npm, amt0, props.t0sym))) return
      if (amt1 > 0n && !(await ensureAllowance(pos.pool.token1, props.user, props.npm, amt1, props.t1sym))) return
      // fresh price + band-edge mins (see minAmountsForLiquidity) — avoids 'PSC' reverts
      const fresh = await fetchSqrtPriceX96(pos.pool.address)
      const liq = getLiquidityForAmounts(fresh, sqrtA, sqrtB, amt0, amt1)
      const mins = minAmountsForLiquidity(fresh, sqrtA, sqrtB, liq, SLIP_BPS)
      const ok = await step(t('zap.stIncrease', { id: pos.tokenId.toString() }), () =>
        writeContract(wagmiConfig, {
          abi: clPmAbi,
          address: props.npm,
          functionName: 'increaseLiquidity',
          args: [
            {
              tokenId: pos.tokenId,
              amount0Desired: amt0,
              amount1Desired: amt1,
              amount0Min: mins.amount0Min,
              amount1Min: mins.amount1Min,
              deadline: deadline(),
            },
          ],
          chainId: CHAIN_ID,
        }),
      )
      if (ok) {
        setA0('')
        setA1('')
      }
    })

  if (fund === 'zap')
    return (
      <div className="expander">
        <FundSwitch fund={fund} onFund={setFund} />
        <ZapPanel
          target={{
            kind: 'cl-increase',
            pool: pos.pool,
            tickLower: pos.tickLower,
            tickUpper: pos.tickUpper,
            tokenId: pos.tokenId,
            npm: props.npm,
          }}
          t0={{ address: pos.pool.token0, symbol: props.t0sym, decimals: dec0 }}
          t1={{ address: pos.pool.token1, symbol: props.t1sym, decimals: dec1 }}
        />
        {props.isOrder && <div className="dim mono-sm">{t('zap.orderGrows')}</div>}
      </div>
    )

  return (
    <div className="expander">
      <FundSwitch fund={fund} onFund={setFund} />
      <AmountRow
        sym={props.t0sym}
        value={a0}
        onChange={(v) => link(v, true)}
        bal={bal0}
        dec={dec0}
        onMax={(v) => link(v, true)}
        disabled={above}
        note={above ? t('add.aboveNote') : over0 ? t('common.exceedsBalance') : undefined}
      />
      <AmountRow
        sym={props.t1sym}
        value={a1}
        onChange={(v) => link(v, false)}
        bal={bal1}
        dec={dec1}
        onMax={(v) => link(v, false)}
        disabled={below}
        note={below ? t('add.belowNote') : over1 ? t('common.exceedsBalance') : undefined}
      />
      <div className="spec">
        <div className="spec-hd">{t('pos.incBtn')}</div>
        <div className="spec-row">
          <span className="sk">{t('pos.incRange')}</span>
          <span className="sv">
            [{pos.tickLower} → {pos.tickUpper}]
          </span>
          <span className="sd">{t('pos.incRangeSd')}</span>
        </div>
        <div className="spec-row">
          <span className="sk">{t('pos.incSize')}</span>
          <span className="sv">{t('pos.incSizeAny')}</span>
          <span className="sd">{below || above ? t('pos.incSizeSdSingle') : t('pos.incSizeSd')}</span>
        </div>
        {sim && (
          <>
            <div className="spec-row">
              <span className="sk">{t('pos.incPulls')}</span>
              <span className="sv">
                {fmtAmount(sim.pull.amount0, dec0)} {props.t0sym} + {fmtAmount(sim.pull.amount1, dec1)} {props.t1sym}
              </span>
              <span className="sd">{t('pos.incPullsSd')}</span>
            </div>
            <div className="spec-row">
              <span className="sk">{t('pos.incNew')}</span>
              <span className="sv">
                {fmtAmount(props.held.amount0 + sim.pull.amount0, dec0)} {props.t0sym} +{' '}
                {fmtAmount(props.held.amount1 + sim.pull.amount1, dec1)} {props.t1sym}
              </span>
              <span className="sd">
                {sim.growPct === null
                  ? t('pos.incNewReseed')
                  : t('pos.incNewGrow', {
                      pct: sim.growPct >= 100 ? sim.growPct.toFixed(0) : sim.growPct.toFixed(1),
                    })}
              </span>
            </div>
          </>
        )}
        <div className="spec-row">
          <span className="sk">{t('pos.incFees')}</span>
          <span className="sv">{t('pos.incFeesKept')}</span>
          <span className="sd">{t('pos.incFeesSd')}</span>
        </div>
        {props.isOrder && (
          <div className="spec-row">
            <span className="sk">{t('pos.incOrder')}</span>
            <span className="sv">{t('pos.incOrderGrows')}</span>
            <span className="sd">{t('pos.incOrderSd')}</span>
          </div>
        )}
      </div>
      <div className="form-row">
        <Btn busy={props.busy} onClick={increase} disabled={!sim || over0 || over1}>
          {t('pos.incBtn')}
        </Btn>
        <span className="dim mono-sm">{t('pos.incMins', { slip: SLIP_BPS / 100 })}</span>
      </div>
    </div>
  )
}

// ---------------- v2 ----------------

export function V2Card({
  pos,
  data,
  user,
  stat,
  upUsd,
  wethUsd,
}: {
  pos: V2Position
  data: PoolsData
  user: `0x${string}`
  stat?: PoolStat
  upUsd?: number
  wethUsd?: number | null
}) {
  const { t } = useTranslation()
  const t0 = tokenOf(data, pos.pool.token0)
  const t1 = tokenOf(data, pos.pool.token1)
  const [busy, setBusy] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const m = v2PosMetrics({ pos, dec0: t0.decimals, dec1: t1.decimals, stat, upUsd, wethUsd })

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const stakeAll = () =>
    run(async () => {
      if (!pos.pool.gauge || pos.walletLp === 0n) return
      if (!(await ensureAllowance(pos.pool.address, user, pos.pool.gauge, pos.walletLp, 'LP'))) return
      await step(t('pos.stStakeLp', { pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2GaugeAbi,
          address: pos.pool.gauge!,
          functionName: 'deposit',
          args: [pos.walletLp],
          chainId: CHAIN_ID,
        }),
      )
    })

  const unstakeAll = () =>
    run(() =>
      step(t('pos.stUnstakeLp', { pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2GaugeAbi,
          address: pos.pool.gauge!,
          functionName: 'withdraw',
          args: [pos.stakedLp],
          chainId: CHAIN_ID,
        }),
      ),
    )

  const claimUp = () =>
    run(() =>
      step(
        t('pos.stClaimPair', { pair: `${t0.symbol}/${t1.symbol}` }),
        () =>
          writeContract(wagmiConfig, {
            abi: v2GaugeAbi,
            address: pos.pool.gauge!,
            functionName: 'getReward',
            args: [user],
            chainId: CHAIN_ID,
          }),
        { onSuccess: offerSwapClaimedUp(user) },
      ),
    )

  const claimFees = () =>
    run(() =>
      step(t('pos.stClaimPoolFees', { pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2PoolAbi,
          address: pos.pool.address,
          functionName: 'claimFees',
          chainId: CHAIN_ID,
        }),
      ),
    )

  const remove = (pct: number) =>
    run(async () => {
      const lp = (pos.walletLp * BigInt(Math.round(pct * 100))) / 10_000n
      if (lp === 0n) {
        txlog.push('err', t('pos.stNoWalletLp'))
        return
      }
      const quote = await readContract(wagmiConfig, {
        abi: v2RouterAbi,
        address: ADDR.V2_ROUTER,
        functionName: 'quoteRemoveLiquidity',
        args: [pos.pool.token0, pos.pool.token1, pos.pool.stable, ADDR.V2_FACTORY, lp],
        chainId: CHAIN_ID,
      })
      if (!(await ensureAllowance(pos.pool.address, user, ADDR.V2_ROUTER, lp, 'LP'))) return
      await step(t('pos.stRemoveLp', { pct, pair: `${t0.symbol}/${t1.symbol}` }), () =>
        writeContract(wagmiConfig, {
          abi: v2RouterAbi,
          address: ADDR.V2_ROUTER,
          functionName: 'removeLiquidity',
          args: [
            pos.pool.token0,
            pos.pool.token1,
            pos.pool.stable,
            lp,
            applySlippage(quote[0], SLIP_BPS),
            applySlippage(quote[1], SLIP_BPS),
            user,
            deadline(),
          ],
          chainId: CHAIN_ID,
        }),
      )
      setRemoveOpen(false)
    })

  const gaugeOk = !!pos.pool.gauge && pos.pool.gaugeAlive
  const hasFees = pos.claimable0 > 0n || pos.claimable1 > 0n

  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">
          {t0.symbol}/{t1.symbol}
        </span>
        <Badge tone="cyan">
          {pos.pool.stable ? 'v2 stable' : 'v2 volatile'} · {(pos.pool.feeBps / 100).toFixed(2)}%
        </Badge>
        <a className="dim mono-sm" href={`${EXPLORER}/address/${pos.pool.address}`} target="_blank" rel="noreferrer">
          {shortAddr(pos.pool.address)}↗
        </a>
        <div className="card-actions">
          {gaugeOk && pos.walletLp > 0n && (
            <Btn busy={busy} onClick={stakeAll}>
              {t('pos.v2StakeAll')}
            </Btn>
          )}
          {pos.stakedLp > 0n && (
            <Btn busy={busy} onClick={unstakeAll} tone="ghost">
              {t('pos.v2UnstakeAll')}
            </Btn>
          )}
          {pos.earned > 0n && (
            <Btn busy={busy} onClick={claimUp}>
              {t('pos.claimUp')}
            </Btn>
          )}
          {hasFees && (
            <Btn busy={busy} onClick={claimFees}>
              {t('pos.v2ClaimFees')}
            </Btn>
          )}
          {pos.walletLp > 0n && (
            <Btn busy={busy} onClick={() => setRemoveOpen(!removeOpen)} tone="danger">
              {t('pos.remove')}
            </Btn>
          )}
        </div>
      </div>

      <div className="kv mono-sm">
        <span>
          <span className="k">{t('pos.value')}</span>
          {m.valueUsd !== null ? <b>{fmtUsd(m.valueUsd)}</b> : <span className="dim">{t('pos.noAnchor')}</span>}
        </span>
        <span>
          <span className="k">{t('pos.v2Total')}</span>
          {fmtAmount(pos.amount0, t0.decimals)} {t0.symbol} + {fmtAmount(pos.amount1, t1.decimals)} {t1.symbol}
        </span>
        <span>
          <span className="k">{t('pos.v2WalletLp')}</span>
          {fmtAmount(pos.walletLp, 18)}
        </span>
        <span>
          <span className="k">{t('pos.v2StakedLp')}</span>
          <span className={pos.stakedLp > 0n ? 'green' : ''}>{fmtAmount(pos.stakedLp, 18)}</span>
        </span>
        {pos.earned > 0n && (
          <span>
            <span className="k">{t('pos.pendingUpK')}</span>
            <span className="green">
              {fmtAmount(pos.earned, 18)}
              {upUsd !== undefined && <span className="dim"> ≈ {fmtUsd((Number(pos.earned) / 1e18) * upUsd)}</span>}
            </span>
          </span>
        )}
        {hasFees && (
          <span>
            <span className="k">{t('pos.v2Claimable')}</span>
            {fmtAmount(pos.claimable0, t0.decimals)} {t0.symbol} + {fmtAmount(pos.claimable1, t1.decimals)} {t1.symbol}
            {m.feesUsd !== null && m.feesUsd > 0.01 && <span className="amber"> ≈ {fmtUsd(m.feesUsd)}</span>}
          </span>
        )}
      </div>
      {(m.staked || m.wallet) && (
        <div className="kv mono-sm pos-earn">
          {m.staked && (
            <span>
              <span className="k">{m.wallet ? t('pos.earningStaked') : t('pos.earning')}</span>
              <EarnLine e={m.staked} v2 />
            </span>
          )}
          {m.wallet && (
            <span>
              <span className="k">{m.staked ? t('pos.earningWallet') : t('pos.earning')}</span>
              <EarnLine e={m.wallet} v2 />
            </span>
          )}
        </div>
      )}

      {removeOpen && (
        <div className="expander">
          <div className="form-row">
            <span className="lbl">{t('pos.remove')}</span>
            {[25, 50, 75, 100].map((p) => (
              <Btn key={p} busy={busy} onClick={() => remove(p)} tone="ghost">
                {p}%
              </Btn>
            ))}
            <span className="dim mono-sm">
              {t('pos.v2RemoveOf')}
              {pos.stakedLp > 0n ? ` ${t('pos.v2RemoveStakedNote')}` : ''}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- helpers ----------------

/** one-line "what is this position earning right now" renderer */
function EarnLine({ e, v2 }: { e: Earning; v2?: boolean }) {
  const { t } = useTranslation()
  const share = (s: number) => (s < 0.01 ? '<0.01%' : s.toFixed(2) + '%')
  switch (e.kind) {
    case 'emissions':
      return (
        <span className="green">
          {t('pos.earnEmit', { n: fmtNum(e.upPerDay, 3) })}
          {e.usdPerDay !== null ? ` ${t('pos.earnUsdDay', { usd: fmtUsd(e.usdPerDay) })}` : ''}
          {e.aprPct !== null ? ` · ${t('pos.earnApr', { apr: fmtApr(e.aprPct) })}` : ''} ·{' '}
          {v2
            ? t('pos.earnShareGauge', { share: share(e.sharePct) })
            : t('pos.earnShareStaked', { share: share(e.sharePct) })}
        </span>
      )
    case 'emissions-idle':
      return e.reason === 'out-of-range' ? (
        <span className="red" title={t('pos.earnOutStakedTip')}>
          {t('pos.earnOutStaked')}
        </span>
      ) : (
        <span className="amber">{t('pos.earnEnded')}</span>
      )
    case 'fees':
      return (
        <span>
          {t('pos.earnFeeApr')} <b>{fmtApr(e.aprPct)}</b> {t('pos.earnUsdDay', { usd: fmtUsd(e.usdPerDay) })} ·{' '}
          {v2
            ? t('pos.earnSharePool', { share: share(e.sharePct) })
            : t('pos.earnShareActive', { share: share(e.sharePct) })}
          {!v2 && <> · {t('pos.earnWhileInRange')}</>}
        </span>
      )
    case 'fees-unknown':
      return <span className="dim">{t('pos.earnUnknown')}</span>
    case 'out-of-range':
      return <span className="red">{t('pos.earnOut')}</span>
    case 'empty':
      return <span className="dim">{t('pos.earnEmpty')}</span>
  }
}

import { formatUnits } from 'viem'

function fmt(v: bigint, dec: number): string {
  return formatUnits(v, dec)
}
function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}
function safeParse(s: string, dec: number): bigint {
  try {
    return parseUnits(s === '' ? '0' : s, dec)
  } catch {
    return 0n
  }
}
