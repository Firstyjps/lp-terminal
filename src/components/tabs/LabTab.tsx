// Visual lab (#lab) — components with SYNTHETIC data. Not linked in header.
import { useEffect, useState } from 'react'
import { ADDR, UNI } from '../../config/addresses'
import { getAmountsForLiquidity, getSqrtRatioAtTick } from '../../lib/clmath'
import type { ClPool, ClPosition, PoolsData, V2Pool, V2Position } from '../../types'
import { ProtoBadge } from '../ProtoBadge'
import { RangeBar } from '../RangeBar'
import { Badge, Btn } from '../ui'
import { AddCl, AddV2 } from './PoolsTab'
import { ClCard, IncreasePanel, V2Card } from './PositionsTab'

const LAB_POOL: ClPool = {
  kind: 'cl',
  protocol: 'up33',
  address: '0x23D641FeCcD207E8794c593e8240444A0674C4Ba',
  token0: ADDR.WETH,
  token1: ADDR.UP,
  gauge: null,
  gaugeAlive: true,
  weight: 0n,
  rewardRate: 511000000000000000n, // ~0.51 UP/s
  periodFinish: BigInt(Math.floor(Date.now() / 1000) + 5 * 86400),
  tickSpacing: 200,
  feePpm: 10_000,
  unstakedFeePpm: 100_000,
  sqrtPriceX96: getSqrtRatioAtTick(102458),
  tick: 102458,
  liquidity: 1_000_000_000_000_000_000_000n,
  stakedLiquidity: 900_000_000_000_000_000_000n,
}
const LAB_DATA: PoolsData = {
  pools: [LAB_POOL],
  tokens: {
    [ADDR.WETH.toLowerCase()]: { address: ADDR.WETH, symbol: 'WETH', decimals: 18 },
    [ADDR.UP.toLowerCase()]: { address: ADDR.UP, symbol: 'UP', decimals: 18 },
  },
  protocol: {
    weekly: 0n,
    epochCount: 1,
    activePeriod: 0,
    totalWeight: 0n,
    capMode: 2,
    blockNumber: 0n,
  },
}

const LAB_USER = '0x0000000000000000000000000000000000000001' as const
const labPos = (lower: number, upper: number, liquidity: bigint): ClPosition => ({
  tokenId: 4242n,
  pool: LAB_POOL,
  tickLower: lower,
  tickUpper: upper,
  liquidity,
  staked: false,
  amount0: 0n,
  amount1: 0n,
  fees0: 0n,
  fees1: 0n,
  earned: 0n,
})
const labRun = async (fn: () => Promise<unknown>) => {
  await fn()
}

function Case(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <div className="card-head">
        <span className="card-title">{props.title}</span>
        <Badge tone="cyan">CL 1.00%</Badge>
        <Badge>ts200</Badge>
        <a className="dim mono-sm">#1234↗</a>
        <Badge tone="green">STAKED</Badge>
        <div className="card-actions">
          <Btn>CLAIM UP</Btn>
          <Btn tone="ghost">UNSTAKE</Btn>
          <Btn tone="danger">WITHDRAW</Btn>
        </div>
      </div>
      {props.children}
      <div className="kv mono-sm">
        <span>
          <span className="k">holds</span>2.4501 WETH + 31,204 UP
        </span>
        <span>
          <span className="k">pending UP</span>
          <span className="green">1,204.5</span>
        </span>
      </div>
    </div>
  )
}

/** self-driving RangeBar: a mean-reverting random walk stepping every 2s —
 *  exercises the glide, phosphor trail, near-edge amber and out-of-range
 *  alarm/excursion states without waiting for a real market to move */
function LiveRangeDemo() {
  const [tick, setTick] = useState(101950)
  useEffect(() => {
    const id = setInterval(
      () => setTick((t) => Math.round(t + (101950 - t) * 0.18 + (Math.random() - 0.5) * 1400)),
      2000,
    )
    return () => clearInterval(id)
  }, [])
  return (
    <RangeBar
      tickLower={100000}
      tickUpper={104000}
      tick={tick}
      sqrtPriceX96={getSqrtRatioAtTick(tick)}
      dec0={18}
      dec1={18}
      sym0="WETH"
      sym1="UP"
    />
  )
}

export function LabTab() {
  const mk = (tick: number) => getSqrtRatioAtTick(tick)
  return (
    <div style={{ maxWidth: 900 }}>
      <div className="section-title">COMPONENT LAB — SYNTHETIC DATA (not your positions)</div>
      <Case title="LIVE DEMO · random walk — glide, trail, edge/out transitions">
        <LiveRangeDemo />
      </Case>
      <Case title="WETH/UP · in range, centered">
        <RangeBar tickLower={100000} tickUpper={104000} tick={101950} sqrtPriceX96={mk(101950)} dec0={18} dec1={18} sym0="WETH" sym1="UP" />
      </Case>
      <Case title="WETH/UP · near upper edge">
        <RangeBar tickLower={100000} tickUpper={104000} tick={103790} sqrtPriceX96={mk(103790)} dec0={18} dec1={18} sym0="WETH" sym1="UP" />
      </Case>
      <Case title="WETH/UP · OUT below">
        <RangeBar tickLower={100000} tickUpper={104000} tick={98800} sqrtPriceX96={mk(98800)} dec0={18} dec1={18} sym0="WETH" sym1="UP" />
      </Case>
      <Case title="WETH/USDG · 18/6 decimals, in range">
        <RangeBar tickLower={-201800} tickUpper={-199800} tick={-200795} sqrtPriceX96={mk(-200795)} dec0={18} dec1={6} sym0="WETH" sym1="USDG" />
      </Case>
      <Case title="narrow band · OUT above">
        <RangeBar tickLower={-201000} tickUpper={-200600} tick={-200380} sqrtPriceX96={mk(-200380)} dec0={18} dec1={6} sym0="WETH" sym1="USDG" />
      </Case>

      <div className="section-title">RANGE-ORDER BARS (order mode — POSITIONS view of LIMIT orders)</div>
      <Case title="LIMIT sell UP → WETH · waiting (price below band)">
        <RangeBar tickLower={101800} tickUpper={102200} tick={102437} sqrtPriceX96={mk(102437)} dec0={18} dec1={18} sym0="WETH" sym1="UP" order={{ fillFrac: 0, sellSym: 'UP', buySym: 'WETH' }} />
      </Case>
      <Case title="LIMIT sell UP → WETH · filling ~50%">
        <RangeBar tickLower={101800} tickUpper={102200} tick={102000} sqrtPriceX96={mk(102000)} dec0={18} dec1={18} sym0="WETH" sym1="UP" order={{ fillFrac: 0.5025, sellSym: 'UP', buySym: 'WETH' }} />
      </Case>
      <Case title="LIMIT sell UP → WETH · fully filled">
        <RangeBar tickLower={101800} tickUpper={102200} tick={101700} sqrtPriceX96={mk(101700)} dec0={18} dec1={18} sym0="WETH" sym1="UP" order={{ fillFrac: 1, sellSym: 'UP', buySym: 'WETH' }} />
      </Case>

      <div className="section-title">PROTOCOL BADGES (multi-DEX positions)</div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">WETH/UP</span>
          <ProtoBadge proto="up33" />
          <Badge tone="cyan">CL 1.00%</Badge>
          <Badge>ts200</Badge>
          <Badge tone="green">STAKED</Badge>
        </div>
        <div className="card-head">
          <span className="card-title">WETH/USDG</span>
          <ProtoBadge proto="univ3" />
          <Badge tone="cyan">CL 0.05%</Badge>
          <Badge>ts10</Badge>
          <Badge tone="amber">WALLET</Badge>
        </div>
      </div>

      <div className="section-title">POSITION CARDS — REDESIGN (value + earning-now lines)</div>
      {(() => {
        const gaugePool: ClPool = {
          ...LAB_POOL,
          gauge: '0x00000000000000000000000000000000000000aa',
          rewardRate: 5_000_000_000_000_000n, // 0.005 UP/s to the whole gauge
        }
        const stat = { vol24hUsd: 155_000, liqUsd: 184_000, source: 'dexscreener' as const }
        const stakedIn: ClPosition = {
          ...labPos(100000, 104000, 500_000_000_000_000_000_000n),
          pool: gaugePool,
          staked: true,
          earned: 1_204_500_000_000_000_000_000n,
          ...getAmountsForLiquidity(gaugePool.sqrtPriceX96, mk(100000), mk(104000), 500_000_000_000_000_000_000n),
        }
        const stakedOut: ClPosition = {
          ...labPos(103000, 104000, 300_000_000_000_000_000_000n),
          tokenId: 4243n,
          pool: gaugePool,
          staked: true,
          earned: 88_000_000_000_000_000_000n,
          ...getAmountsForLiquidity(gaugePool.sqrtPriceX96, mk(103000), mk(104000), 300_000_000_000_000_000_000n),
        }
        const uniWallet: ClPosition = {
          ...labPos(100000, 104000, 400_000_000_000_000_000_000n),
          tokenId: 91_337n,
          pool: { ...LAB_POOL, protocol: 'univ3', gauge: null, unstakedFeePpm: 0, feePpm: 3000, tickSpacing: 60 },
          fees0: 12_400_000_000_000_000n,
          fees1: 310_000_000_000_000_000_000n,
          ...getAmountsForLiquidity(LAB_POOL.sqrtPriceX96, mk(100000), mk(104000), 400_000_000_000_000_000_000n),
        }
        const v2Pos: V2Position = {
          pool: {
            ...LAB_V2_PAIR,
            protocol: 'up33',
            gauge: '0x00000000000000000000000000000000000000bb',
            gaugeAlive: true,
            gaugeTotalSupply: 1_200_000_000_000_000_000_000n,
            rewardRate: 2_000_000_000_000_000n,
            periodFinish: BigInt(Math.floor(Date.now() / 1000) + 5 * 86400),
          },
          walletLp: 300_000_000_000_000_000_000n,
          stakedLp: 500_000_000_000_000_000_000n,
          earned: 812_000_000_000_000_000_000n,
          claimable0: 21_000_000_000_000_000n,
          claimable1: 590_000_000_000_000_000_000n,
          amount0: 4_800_000_000_000_000_000n,
          amount1: 135_360_000_000_000_000_000_000n,
        }
        const labUsd = { upUsd: 0.0688, wethUsd: 1928 }
        return (
          <>
            <ClCard pos={stakedIn} data={LAB_DATA} xtokens={{}} user={LAB_USER} stat={stat} {...labUsd} />
            <ClCard pos={stakedOut} data={LAB_DATA} xtokens={{}} user={LAB_USER} stat={stat} {...labUsd} />
            <ClCard pos={uniWallet} data={LAB_DATA} xtokens={{}} user={LAB_USER} stat={{ ...stat, vol24hUsd: 351_000 }} {...labUsd} />
            <V2Card pos={v2Pos} data={LAB_DATA} user={LAB_USER} stat={{ vol24hUsd: 82_000, liqUsd: 46_000, source: 'geckoterminal' }} {...labUsd} />
          </>
        )
      })()}

      <div className="section-title">INCREASE PANEL LAB (synthetic positions)</div>
      {(() => {
        const inRange = labPos(100000, 104000, 500_000_000_000_000_000_000n)
        const heldIn = getAmountsForLiquidity(LAB_POOL.sqrtPriceX96, mk(100000), mk(104000), inRange.liquidity)
        const orderPos = labPos(103000, 103400, 800_000_000_000_000_000_000n) // above current tick -> token0-only
        const heldOrder = getAmountsForLiquidity(LAB_POOL.sqrtPriceX96, mk(103000), mk(103400), orderPos.liquidity)
        const uniPos: typeof inRange = {
          ...labPos(100000, 104000, 500_000_000_000_000_000_000n),
          pool: { ...LAB_POOL, protocol: 'univ3', gauge: null },
        }
        return (
          <>
            <div className="card">
              <div className="card-head">
                <span className="card-title">WETH/UP · increase, in range</span>
                <ProtoBadge proto="up33" />
              </div>
              <IncreasePanel
                pos={inRange}
                npm={ADDR.CL_PM}
                t0sym="WETH"
                t1sym="UP"
                dec0={18}
                dec1={18}
                user={LAB_USER}
                busy={false}
                run={labRun}
                sqrtP={LAB_POOL.sqrtPriceX96}
                tick={LAB_POOL.tick}
                held={heldIn}
                isOrder={false}
              />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">WETH/UP · increase a uniswap position</span>
                <ProtoBadge proto="univ3" />
              </div>
              <IncreasePanel
                pos={uniPos}
                npm={UNI.V3_NPM}
                t0sym="WETH"
                t1sym="UP"
                dec0={18}
                dec1={18}
                user={LAB_USER}
                busy={false}
                run={labRun}
                sqrtP={LAB_POOL.sqrtPriceX96}
                tick={LAB_POOL.tick}
                held={heldIn}
                isOrder={false}
              />
            </div>
            <div className="card">
              <div className="card-head">
                <span className="card-title">WETH/UP · increase a range order (price below band — token0 only)</span>
                <ProtoBadge proto="up33" />
              </div>
              <IncreasePanel
                pos={orderPos}
                npm={ADDR.CL_PM}
                t0sym="WETH"
                t1sym="UP"
                dec0={18}
                dec1={18}
                user={LAB_USER}
                busy={false}
                run={labRun}
                sqrtP={LAB_POOL.sqrtPriceX96}
                tick={LAB_POOL.tick}
                held={heldOrder}
                isOrder
              />
            </div>
          </>
        )
      })()}

      <div className="section-title">ADD-LP PANEL LAB (synthetic WETH/UP pool)</div>
      <div className="card">
        <AddCl
          pool={LAB_POOL}
          data={LAB_DATA}
          stat={{ vol24hUsd: 155_000, liqUsd: 184_000, source: 'dexscreener' }}
          upUsd={0.0688}
          wethUsd={1928}
        />
      </div>
      <div className="section-title">ADD-LP PANEL LAB — UNISWAP V3 (synthetic 0.3% pool, no gauge)</div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">WETH/UP</span>
          <ProtoBadge proto="univ3" />
        </div>
        <AddCl
          pool={{ ...LAB_POOL, protocol: 'univ3', gauge: null, unstakedFeePpm: 0, feePpm: 3000, tickSpacing: 60 }}
          data={LAB_DATA}
          stat={{ vol24hUsd: 351_000, liqUsd: 363_000, source: 'dexscreener' }}
          upUsd={0.0688}
          wethUsd={1928}
        />
      </div>
      <div className="section-title">ADD-LP PANEL LAB — UNISWAP V2 (synthetic pair, reserves at pool price)</div>
      <div className="card">
        <div className="card-head">
          <span className="card-title">WETH/UP</span>
          <ProtoBadge proto="univ2" />
        </div>
        <AddV2 pool={LAB_V2_PAIR} data={LAB_DATA} stat={{ vol24hUsd: 82_000, liqUsd: 46_000, source: 'geckoterminal' }} upUsd={0.0688} />
      </div>
    </div>
  )
}

// vanilla univ2 pair: ~$46k TVL, reserves consistent with the CL lab price
// (tick 102458 ≈ 28.2k UP per WETH)
const LAB_V2_PAIR: V2Pool = {
  kind: 'v2',
  protocol: 'univ2',
  address: '0x000000000000000000000000000000000000d0d0',
  token0: ADDR.WETH,
  token1: ADDR.UP,
  stable: false,
  reserve0: 12_000_000_000_000_000_000n, // 12 WETH
  reserve1: 338_400_000_000_000_000_000_000n, // 338.4k UP
  totalSupply: 2_000_000_000_000_000_000_000n,
  gaugeTotalSupply: 0n,
  feeBps: 30,
  gauge: null,
  gaugeAlive: false,
  weight: 0n,
  rewardRate: 0n,
  periodFinish: 0n,
}
