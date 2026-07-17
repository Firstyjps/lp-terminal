import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAccount } from 'wagmi'
import { sendTransaction, writeContract } from 'wagmi/actions'
import { formatUnits, parseUnits, type Address } from 'viem'
import { clSwapRouterAbi, v2RouterAbi, wethAbi } from '../../abi'
import { ADDR, CHAIN_ID } from '../../config/addresses'
import { ENV } from '../../config/env'
import { wagmiConfig } from '../../config/wagmi'
import { applySlippage } from '../../lib/clmath'
import { bpsDiff, fmtAmount, fmtNum, fmtUsd, shortAddr } from '../../lib/format'
import { routeBreakdown } from '../../lib/kyber'
import { buildGatedKyberTx } from '../../lib/kyberExec'
import { peekSwapIntent, takeSwapIntent } from '../../lib/swapIntent'
import { deadline, ensureAllowance, step } from '../../lib/tx'
import { txlog } from '../../lib/txlog'
import { useBalances } from '../../hooks/useBalances'
import { erc20Of, isNative, useKyberQuote, useNativeQuote } from '../../hooks/useQuotes'
import { useTokenList } from '../../hooks/useTokenList'
import type { TokenInfo } from '../../types'
import { TokenSelect } from '../TokenSelect'
import { Badge, Btn } from '../ui'
import { LimitPanel } from './LimitPanel'

const ETH_GAS_BUFFER = parseUnits('0.001', 18)

type SwapMode = 'market' | 'limit'

export function SwapTab() {
  const { t } = useTranslation()
  const { address: user } = useAccount()
  const list = useTokenList()

  const [mode, setModeState] = useState<SwapMode>(() => (location.hash === '#limit' ? 'limit' : 'market'))
  const [tIn, setTIn] = useState<TokenInfo | null>(null)
  const [tOut, setTOut] = useState<TokenInfo | null>(null)
  const [amtStr, setAmtStr] = useState('')
  const [amount, setAmount] = useState<bigint>(0n)
  const [slip, setSlip] = useState(50)
  const [override, setOverride] = useState<'kyber' | 'native' | null>(null)
  const [invRate, setInvRate] = useState(false)
  const [busy, setBusy] = useState(false)

  const setMode = (m: SwapMode) => {
    setModeState(m)
    history.replaceState(null, '', m === 'limit' ? '#limit' : '#swap')
  }

  // deep links: #limit / #swap navigation while this tab is already mounted
  useEffect(() => {
    const onHash = () => {
      if (location.hash === '#limit') setModeState('limit')
      else if (location.hash === '#swap') setModeState('market')
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // consume a pending "swap claimed UP" handoff once both tokens are resolvable
  useEffect(() => {
    const i = peekSwapIntent()
    if (!i || !list.length) return
    const tin = list.find((t) => t.address.toLowerCase() === i.tokenIn.toLowerCase())
    const tout = list.find((t) => t.address.toLowerCase() === i.tokenOut.toLowerCase())
    if (!tin || !tout) return // token list still loading — try again next render
    takeSwapIntent()
    setModeState('market')
    setTIn(tin)
    setTOut(tout)
    setAmtStr(formatUnits(i.amount, tin.decimals))
  }, [list])

  // defaults: ETH -> UP. Wait until UP is actually present (pool tokens load async)
  useEffect(() => {
    if (!tIn && list.length) setTIn(list.find((t) => t.native) ?? list[0])
    if (!tOut) {
      const up = list.find((t) => t.address.toLowerCase() === ADDR.UP.toLowerCase())
      if (up) setTOut(up)
    }
  }, [list, tIn, tOut])

  // debounce amount parsing
  useEffect(() => {
    const h = setTimeout(() => {
      try {
        setAmount(tIn ? parseUnits(amtStr === '' ? '0' : amtStr, tIn.decimals) : 0n)
      } catch {
        setAmount(0n)
      }
    }, 350)
    return () => clearTimeout(h)
  }, [amtStr, tIn])

  useEffect(() => setOverride(null), [tIn?.address, tOut?.address, amount])

  const bal = useBalances(user, [tIn?.address, tOut?.address].filter(Boolean) as Address[])

  const isWrap = !!tIn?.native && tOut?.address.toLowerCase() === ADDR.WETH.toLowerCase()
  const isUnwrap = !!tOut?.native && tIn?.address.toLowerCase() === ADDR.WETH.toLowerCase()

  const kyber = useKyberQuote(tIn?.address, tOut?.address, amount)
  const native = useNativeQuote(tIn?.address, tOut?.address, amount)

  const kyberOut = kyber.data ? BigInt(kyber.data.routeSummary.amountOut) : undefined
  const nativeBest = native.data?.best ?? null

  const auto: 'kyber' | 'native' | null =
    kyberOut !== undefined && nativeBest
      ? kyberOut >= nativeBest.amountOut
        ? 'kyber'
        : 'native'
      : kyberOut !== undefined
        ? 'kyber'
        : nativeBest
          ? 'native'
          : null
  const sel = override ?? auto
  const selOut = sel === 'kyber' ? kyberOut : sel === 'native' ? nativeBest?.amountOut : undefined

  const flip = () => {
    const a = tIn
    setTIn(tOut)
    setTOut(a)
    setAmtStr('')
  }

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const doWrap = () =>
    run(() =>
      step(t('swap.stWrap', { amt: amtStr }), () =>
        writeContract(wagmiConfig, {
          abi: wethAbi,
          address: ADDR.WETH,
          functionName: 'deposit',
          value: amount,
          chainId: CHAIN_ID,
        }),
      ),
    )
  const doUnwrap = () =>
    run(() =>
      step(t('swap.stUnwrap', { amt: amtStr }), () =>
        writeContract(wagmiConfig, {
          abi: wethAbi,
          address: ADDR.WETH,
          functionName: 'withdraw',
          args: [amount],
          chainId: CHAIN_ID,
        }),
      ),
    )

  const doSwap = () =>
    run(async () => {
      if (!user || !tIn || !tOut || amount === 0n || !sel) return
      if (sel === 'kyber') {
        const fresh = await kyber.refetch()
        const data = fresh.data
        if (!data) {
          txlog.push('err', t('swap.errNoQuote'))
          return
        }
        if (!isNative(tIn.address)) {
          if (!(await ensureAllowance(tIn.address, user, ENV.kyberRouter, amount, tIn.symbol))) return
        }
        // build + safety gates (router whitelist, tx value, build-vs-quote drift)
        // live in lib/kyberExec — shared with ZAP so the gates can never diverge
        let tx
        try {
          tx = await buildGatedKyberTx({
            routeSummary: data.routeSummary,
            sender: user,
            recipient: user,
            slippageBps: slip,
            amountIn: amount,
            nativeIn: isNative(tIn.address),
          })
        } catch (e) {
          txlog.push('err', (e as Error).message)
          return
        }
        await step(t('swap.stSwapKyber', { amt: amtStr, a: tIn.symbol, b: tOut.symbol }), () =>
          sendTransaction(wagmiConfig, { to: tx.to, data: tx.data, value: tx.value, chainId: CHAIN_ID }),
        )
      } else {
        if (!nativeBest) return
        if (isNative(tIn.address)) {
          txlog.push('err', t('swap.errNeedsWeth'))
          return
        }
        const minOut = applySlippage(nativeBest.amountOut, slip)
        if (nativeBest.kind === 'v2') {
          if (!(await ensureAllowance(tIn.address, user, ADDR.V2_ROUTER, amount, tIn.symbol))) return
          await step(t('swap.stSwapV2', { amt: amtStr, a: tIn.symbol, b: tOut.symbol }), () =>
            writeContract(wagmiConfig, {
              abi: v2RouterAbi,
              address: ADDR.V2_ROUTER,
              functionName: 'swapExactTokensForTokens',
              args: [
                amount,
                minOut,
                [
                  {
                    from: tIn.address,
                    to: erc20Of(tOut.address),
                    stable: nativeBest.pool.stable,
                    factory: ADDR.V2_FACTORY,
                  },
                ],
                user,
                deadline(),
              ],
              chainId: CHAIN_ID,
            }),
          )
        } else {
          if (!(await ensureAllowance(tIn.address, user, ADDR.CL_SWAP_ROUTER, amount, tIn.symbol))) return
          await step(
            t('swap.stSwapCl', { amt: amtStr, a: tIn.symbol, b: tOut.symbol, ts: nativeBest.pool.tickSpacing }),
            () =>
            writeContract(wagmiConfig, {
              abi: clSwapRouterAbi,
              address: ADDR.CL_SWAP_ROUTER,
              functionName: 'exactInputSingle',
              args: [
                {
                  tokenIn: tIn.address,
                  tokenOut: erc20Of(tOut.address),
                  tickSpacing: nativeBest.pool.tickSpacing,
                  recipient: user,
                  deadline: deadline(),
                  amountIn: amount,
                  amountOutMinimum: minOut,
                  sqrtPriceLimitX96: 0n,
                },
              ],
              chainId: CHAIN_ID,
            }),
          )
        }
      }
    })

  const modeRow = (
    <div className="form-row" style={{ marginBottom: 10 }}>
      <span className="lbl">{t('swap.mode')}</span>
      <button className={`chip ${mode === 'market' ? 'on' : ''}`} onClick={() => setMode('market')}>
        {t('swap.market')}
      </button>
      <button
        className={`chip ${mode === 'limit' ? 'on' : ''}`}
        onClick={() => setMode('limit')}
        title={t('swap.limitTip')}
      >
        {t('swap.limit')}
      </button>
    </div>
  )

  if (mode === 'limit')
    return (
      <div className="swap-box">
        {modeRow}
        <LimitPanel />
      </div>
    )

  if (!tIn || !tOut)
    return (
      <div className="swap-box">
        {modeRow}
        <div className="dim">{t('swap.loadingTokens')}</div>
      </div>
    )

  const balIn = bal.data?.[tIn.address.toLowerCase()]
  const balOut = bal.data?.[tOut.address.toLowerCase()]
  const insufficient = balIn !== undefined && amount > balIn

  const setMax = () => {
    if (balIn === undefined) return
    const v = tIn.native ? (balIn > ETH_GAS_BUFFER ? balIn - ETH_GAS_BUFFER : 0n) : balIn
    setAmtStr(formatUnits(v, tIn.decimals))
  }

  const rate =
    selOut !== undefined && amount > 0n
      ? Number(formatUnits(selOut, tOut.decimals)) / Number(formatUnits(amount, tIn.decimals))
      : undefined

  const usdIn = kyber.data?.routeSummary.amountInUsd
  const usdOut = kyber.data?.routeSummary.amountOutUsd

  return (
    <div className="swap-box">
      {modeRow}
      <div className="swap-side">
        <div className="top">
          <span className="side-lbl">{t('swap.from')}</span>
          <TokenSelect list={list} value={tIn} exclude={tOut.address} onChange={setTIn} />
          <input
            className="amt"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            placeholder="0.0"
            value={amtStr}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.')
              if (v === '' || /^\d*\.?\d*$/.test(v)) setAmtStr(v)
            }}
          />
        </div>
        <div className="meta">
          <span>
            {t('common.bal')} {balIn !== undefined ? fmtAmount(balIn, tIn.decimals) : '—'}{' '}
            <button className="chip" onClick={setMax}>
              {t('common.max')}
            </button>
            {insufficient && <span className="red"> {t('common.insufficient')}</span>}
          </span>
          <span>{amount > 0n && usdIn ? `≈ ${fmtUsd(usdIn)}` : ''}</span>
        </div>
      </div>

      <div className="swap-mid">
        <button className="chip" onClick={flip} title={t('swap.flipTip')}>
          ⇅
        </button>
      </div>

      <div className="swap-side">
        <div className="top">
          <span className="side-lbl">{t('swap.to')}</span>
          <TokenSelect list={list} value={tOut} exclude={tIn.address} onChange={setTOut} />
          <span className={`out ${selOut !== undefined ? '' : 'dim'}`}>
            {isWrap || isUnwrap
              ? amtStr || '0.0'
              : selOut !== undefined
                ? fmtAmount(selOut, tOut.decimals)
                : kyber.isFetching || native.isFetching
                  ? '…'
                  : '0.0'}
          </span>
        </div>
        <div className="meta">
          <span>
            {t('common.bal')} {balOut !== undefined ? fmtAmount(balOut, tOut.decimals) : '—'}
          </span>
          <span>{amount > 0n && usdOut && !isWrap && !isUnwrap ? `≈ ${fmtUsd(usdOut)}` : ''}</span>
        </div>
      </div>

      {rate !== undefined && !isWrap && !isUnwrap && (
        <div className="rate-line" onClick={() => setInvRate(!invRate)} title={t('swap.rateTip')}>
          {t('swap.rate', {
            a: invRate ? tOut.symbol : tIn.symbol,
            n: fmtNum(invRate ? 1 / rate : rate),
            b: invRate ? tIn.symbol : tOut.symbol,
          })}
        </div>
      )}

      {isWrap || isUnwrap ? (
        <div className="form-row" style={{ marginTop: 12 }}>
          <Btn big busy={busy} disabled={!user || amount === 0n || insufficient} onClick={isWrap ? doWrap : doUnwrap}>
            {insufficient
              ? t('common.insufficientBalance')
              : isWrap
                ? t('swap.wrapBtn', { amt: amtStr || '0' })
                : t('swap.unwrapBtn', { amt: amtStr || '0' })}
          </Btn>
          <span className="dim mono-sm">{t('swap.wrapNote', { addr: shortAddr(ADDR.WETH) })}</span>
        </div>
      ) : (
        <>
          <div className="section-title">{t('swap.quotes')}</div>
          {amount === 0n && <div className="dim">{t('swap.enterAmount')}</div>}
          {amount > 0n && (
            <>
              <div className={`quote-row ${sel === 'kyber' ? 'sel' : ''}`} onClick={() => setOverride('kyber')}>
                <span className="src">
                  {sel === 'kyber' ? '◉' : '○'} {t('swap.kyberAgg')}
                </span>
                {kyber.isFetching && !kyber.data ? (
                  <span className="spin">▮</span>
                ) : kyber.isError ? (
                  <span className="red mono-sm">
                    {t('swap.unavailable', { err: (kyber.error as Error)?.message?.slice(0, 60) })}
                  </span>
                ) : kyberOut !== undefined ? (
                  <>
                    <span className="out green">
                      {fmtAmount(kyberOut, tOut.decimals)} {tOut.symbol}
                    </span>
                    <span className="dim mono-sm">{t('swap.gas', { usd: fmtUsd(kyber.data!.routeSummary.gasUsd) || '—' })}</span>
                    <span className="dim mono-sm">{routeBreakdown(kyber.data!.routeSummary)}</span>
                    {auto === 'kyber' && <Badge tone="green">{t('swap.best')}</Badge>}
                  </>
                ) : (
                  <span className="dim">—</span>
                )}
              </div>
              <div className={`quote-row ${sel === 'native' ? 'sel' : ''}`} onClick={() => setOverride('native')}>
                <span className="src">
                  {sel === 'native' ? '◉' : '○'} {t('swap.up33Native')}
                </span>
                {native.isFetching && !native.data ? (
                  <span className="spin">▮</span>
                ) : nativeBest ? (
                  <>
                    <span className="out">
                      {fmtAmount(nativeBest.amountOut, tOut.decimals)} {tOut.symbol}
                    </span>
                    <span className="dim mono-sm">
                      {nativeBest.kind === 'v2'
                        ? t('swap.viaV2', {
                            kind: nativeBest.pool.stable ? t('swap.stable') : t('swap.volatile'),
                            fee: (nativeBest.pool.feeBps / 100).toFixed(2),
                          })
                        : t('swap.viaCl', {
                            fee: (nativeBest.pool.feePpm / 10_000).toFixed(2),
                            ts: nativeBest.pool.tickSpacing,
                          })}
                    </span>
                    {kyberOut !== undefined && (
                      <span className={bpsDiff(nativeBest.amountOut, kyberOut) < 0 ? 'red mono-sm' : 'green mono-sm'}>
                        {t('swap.bpsVsKyber', {
                          bps:
                            (bpsDiff(nativeBest.amountOut, kyberOut) >= 0 ? '+' : '') +
                            bpsDiff(nativeBest.amountOut, kyberOut).toFixed(1),
                        })}
                      </span>
                    )}
                    {auto === 'native' && <Badge tone="green">{t('swap.best')}</Badge>}
                    {isNative(tIn.address) && <span className="amber mono-sm">{t('swap.needsWeth')}</span>}
                  </>
                ) : (
                  <span className="dim mono-sm">{t('swap.noNativePool')}</span>
                )}
              </div>

              <div className="form-row" style={{ marginTop: 10 }}>
                <span className="lbl">{t('swap.slippage')}</span>
                {[10, 50, 100].map((b) => (
                  <button key={b} className={`chip ${slip === b ? 'on' : ''}`} onClick={() => setSlip(b)}>
                    {b / 100}%
                  </button>
                ))}
                <button
                  className="chip"
                  onClick={() => {
                    void kyber.refetch()
                    void native.refetch()
                  }}
                >
                  {t('swap.refresh')}
                </button>
              </div>
              <div className="form-row">
                <Btn
                  big
                  busy={busy}
                  disabled={
                    !user ||
                    amount === 0n ||
                    !sel ||
                    insufficient ||
                    (sel === 'native' && (isNative(tIn.address) || !nativeBest))
                  }
                  onClick={doSwap}
                >
                  {!user
                    ? t('common.connectWallet')
                    : insufficient
                      ? t('common.insufficientBalance')
                      : sel
                        ? t('swap.execVia', { route: sel === 'kyber' ? 'KYBER' : 'UP33' })
                        : t('swap.noRoute')}
                </Btn>
                {selOut !== undefined && (
                  <span className="dim mono-sm">
                    {t('swap.minReceived', {
                      amt: fmtAmount(applySlippage(selOut, slip), tOut.decimals),
                      sym: tOut.symbol,
                      slip: slip / 100,
                    })}
                  </span>
                )}
                {sel === 'native' && isNative(tOut.address) && (
                  <span className="amber mono-sm">{t('swap.nativeWethNote')}</span>
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

