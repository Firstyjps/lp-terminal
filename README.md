# LP TERMINAL

Terminal-style frontend for LPs on Robinhood Chain (chainId 4663): UP33
(ve(3,3) DEX) plus the official **Uniswap v2 + v3** deployments. POSITIONS shows
and manages UP33 + univ3, POOLS browses/adds liquidity across all three,
distinguished by protocol badges (brand mark + colored label). Discovery runs on
a self-hosted **pool indexer** (see below) with a client-side fallback.
Terminal *style* — full-bleed layout, not a boxed console.
Every contract address the app touches lives in `src/config/addresses.ts`, each
one verified against Blockscout's verified source — check them yourself before
you trust this with funds.

**Status**: v1, built for personal use and opened up as-is. See
[Known v1 limits](#known-v1-limits). MIT licensed — see [Disclaimer](#disclaimer)
before you point it at real money.

## Run

```bash
npm install
cp .env.example .env   # every key is optional; defaults hit public endpoints
npm run smoke          # optional: live-chain read-layer validation (TickMath, ABIs, quotes)
npm run indexer        # pool indexer on :8787 (first boot backfills ~10 min; optional but
                       # recommended — without it POOLS falls back to dexscreener discovery)
npm run dev            # http://localhost:5173 (proxies /api -> :8787)
```

Environment comes from the **repo-root `.env`** (via vite `envDir`) — see
`.env.example` for the annotated template:

| key | use |
|---|---|
| `RPC` | private Robinhood Chain RPC (**secret** — personal/local builds only; leave unset for public builds, see [Chain reads](#chain-reads)) |
| `KYBERSWAP_AGGREGATOR_API_BASE_URL` | kyber aggregator base |
| `KYBERSWAP_CHAIN` | chain slug (`robinhood`) |
| `KYBERSWAP_ROUTER_ADDRESS` | **whitelist** — swap calldata is only ever sent to this address |
| `KYBERSWAP_FEE_BPS` | optional platform fee in bps on kyber swaps (e.g. `10` = 0.1%); off when unset |
| `KYBERSWAP_FEE_RECEIVER` | optional; address that receives the fee (both must be set to activate) |
| `VITE_WALLETCONNECT_PROJECT_ID` | optional; only needed for WalletConnect QR pairing (injected wallets work without it) |

KyberSwap platform fees are **verified working on this chain**: the fee rides the
routes request (`feeAmount`/`chargeFeeBy=currency_out`/`isInBps`/`feeReceiver`),
is echoed in `routeSummary.extraFee`, deducted from the quoted output, and encoded
into the swap calldata by `route/build` — the router pays the receiver on-chain.
Price displays (UP price in the add-LP sims) always quote fee-free.

Signing is browser-wallet only (RainbowKit / injected EIP-6963). No private keys anywhere.

**i18n (en/zh)**: react-i18next with typed keys — catalogs in `src/i18n/en.ts` (source of
truth) + `zh.ts` (`typeof en` enforces identical key structure at compile time). Language:
footer `lang:` switcher, persisted (`up33.lang.v1`), `?lang=` view-only override
(screenshots), `<html lang>` + RainbowKit modal locale follow. Non-React modules
(tx step labels, zap planner) import the singleton `t` from `src/i18n`; revert hints
resolve lazily so they follow the active language at error time. Number/date formats
stay en-US in both locales (terminal convention; zh uses the same digit grouping).
The `#lab` dev page stays English.

## Tabs

Keyboard: `1–3` switch tabs, `4` opens LIMIT, `/` focuses the pool filter. Tabs
are hash-routed (`#pools`, `#swap`, …) so reloads and deep links keep your
place. `#lab` renders the component lab (synthetic data) for visual tweaking.

- **[1] POOLS** — one table, three protocols, sorted by TVL by default. UP33 v2 + CL pools come from live factory enumeration; **Uniswap v2 + v3 pools** come from the pool indexer (`/api` — the FULL catalog built from factory events — six figures and growing ~20k pools/day, launchpads mint univ3 pools continuously — chain-derived TVL, GeckoTerminal 24h stats). Columns: fee rate, reserves/price (auto-oriented quote/base), **TVL / VOL 24H / FEES 24H** (UP33: DexScreener + Goldsky v2 subgraph; uniswap: indexer), **FEE APR / EMIT APR**, UP/wk emissions, vote share; all numeric headers sortable; `● MY POOLS` filter marks pools you're in. The `UNISWAP ⌕` row searches the whole catalog — token address / pool address / symbol / `sym0/sym1` pair, empty = everything by TVL — with a `HIDE <$1K` dust chip (on by default: 95% of the catalog is dust meme pools); if the indexer is down it falls back to DexScreener discovery with on-chain `factory.getPool` verification (v3 top 30, amber notice). Inline add-liquidity everywhere: v2 auto-ratio (UP33 Solidly router or vanilla Router02, per pool); CL/univ3 with the full range picker — symmetric presets (±0.5/1/2/5/10/20/30%, FULL), custom ±%, **one-sided ↑ABOVE / ↓BELOW** (single-token deposits that start earning when price enters — sell-the-rise / buy-the-dip), **price-bounds input** (snapped to tick spacing), raw ticks — with a live range-bar preview; amounts rebalance automatically when the range changes. univ3 mints go through the official NPM (fee-keyed mint struct, no levy, no gauge — fee APR only).

  **⚡ ZAP — one-token add (all four pool kinds + increase)**: every add panel has a `FUND: PAIR | ⚡ ZAP` switch. ZAP funds the position with ONE token (either side, or native ETH when a side is WETH — wrapped as step 1): it solves how much to swap so the two piles match the deposit ratio the target needs (CL band math / v2 reserves; seeded at spot, refined over ≤2 kyber quotes since the execution rate moves the answer), previews the plan (`SPLIT / SWAP` with min-out + impact + route, `DEPOSIT` with est. dust, `PROJECTED` APRs), lists the exact tx sequence (numbered, live states), then runs it step by step: wrap? → approve → gated kyber swap → approve both sides → mint / increase / addLiquidity. The deposit uses the amounts that **actually arrived** (receipt Transfer logs), never the quote; any failure **halts** — every intermediate asset is a normal wallet balance, nothing strands. `REWARDS` column shows its full emissions sub-line only under the `UP33` filter (elsewhere it's a slim `—`/APR column).

  APR semantics (ve(3,3): a position earns one or the other, never both):
  - `FEE APR` — **unstaked** LP net fee yield: `vol24h × feeRate × 365 / TVL`, CL further × (1 − unstaked levy). Staked LPs earn **zero** fees (theirs go to the pool's voters). CL number is the pool average — a concentrated in-range position earns proportionally more.
  - `EMIT APR` — **staked** LP UP yield: `rewardRate × 31.536M × UP price / staked TVL`, where staked TVL is v2 `gauge.totalSupply/pool.totalSupply × TVL`, CL `stakedLiquidity/liquidity × TVL` (active-liquidity proxy; out-of-range staked earns nothing). `rewardRate` is the live post-cap stream, so gauge-cap burns are already reflected; it is only committed until the Thursday flip (`periodFinish`), and later cap releases within an epoch can raise it (values refresh live). `∞` = emissions streaming to ~zero staked TVL (first staker takes it all).
  - Simple APR, no compounding; both dilute as TVL/staked TVL grows.
  - **Add-LP simulation**: both add panels show a `PROJECTED` line for *your* prospective position — deposit USD (priced via USDG/WETH/UP anchors), your share of active liquidity, and your fee/emit APR. For CL this is position-specific: `share = L_yours / (activeLiquidity + L_yours)` (fees) and `/ (stakedLiquidity + L_yours)` (emissions), so range concentration and self-dilution are captured exactly — e.g. a ±2% range earns several× the pool-average APR while in range. Out-of-range ranges warn that they earn nothing.
- **[2] POSITIONS** — summary strip (**LP VALUE** in USD across everything incl. uncollected fees, **PENDING UP** with USD value + live `+UP/day` accrual + **CLAIM ALL**, range status, open range-order count with filled alert), then every held LP sorted staked-first / biggest-first. Every card answers the two questions an LP manages by — **worth** (`value ≈ $…`, tokens priced off the pool's own price against USDG/WETH/UP anchors; fees/pending shown in USD too) and **earning right now** (`earning` line: staked → `UP/day + $/day + APR + share of staked liq`; unstaked/univ3 in range → `fee APR + $/day + share of active liq` from 24h stats — indexer stats fetched per held uniswap pool; out of range → red zero; emissions dry → amber). **Multi-protocol**: UP33 CL/v2 positions plus wallet positions from the official Uniswap v3 NPM (`0x7399…E0D3`, pairing chain-verified — Blockscout also lists several unofficial forks). Each card carries a protocol badge (UP arrow / Uniswap unicorn, brand-colored). Uniswap pools are discovered per position via `factory.getPool`, unknown pair tokens get erc20 metadata fetched live, fees use the same `collect`-simulation, and increase/decrease/collect/withdraw all work (write entrypoints are signature-identical; only the NPM address differs). No staking on univ3 (no gauges), and SWAP→LIMIT tags never attach to univ3 ids (tokenIds are only unique per NPM):
  - CL: **range bar** (ends = your price bounds, marker = current price, % drift to each bound, re-entry distance when out of range, in/near/out coloring), holdings, uncollected fees (exact, via `collect` simulation) or pending UP when staked. Actions: stake/unstake, claim UP, collect fees, increase, decrease (decrease+collect), withdraw (double-click confirm). The increase panel shows wallet balances + MAX, auto-links the two amounts at the live pool price, and previews the exact pull/new size — the range itself is immutable (`increaseLiquidity` has no tick params; it stacks liquidity on the band fixed at mint). Range orders placed via SWAP→LIMIT carry a `LIMIT sell→buy` badge, an order-mode range bar (waiting/filling x%/filled instead of the red out-of-range alarm, priced in the sell token), and a state-aware one-click action: `CANCEL — GET <sell> BACK` (unfilled) / `CLOSE NOW` (partial) / `WITHDRAW → LOCK IN <buy>` (filled); the tag clears on 100% withdraw.
  - after any claim (or CL unstake, which auto-claims) confirms, the log shows the exact UP received with a **SWAP → ETH** button — it jumps to SWAP prefilled with the claimed amount.
  - v2: wallet vs staked LP, underlying amounts, claimable pool fees, pending UP. Actions: stake all / unstake all / claim UP / claim fees / remove %.
- **[3] SWAP** — two modes:
  - **MARKET** — KyberSwap aggregator quote vs **UP33-native best** (v2 `getAmountsOut` + CL quoter across all matching pools), side-by-side with bps diff; executes whichever you select. ETH⇄WETH wrap/unwrap built in.
  - **LIMIT · SELL VIA LP** (`#limit`, key `4`) — sell a token with a **one-sided CL range order**. The point is **maker-not-taker economics**: a market swap through the pool pays its fee (1% on WETH/UP); a range order pays none and *earns* fees while filling (the panel shows the comparison and an est. $/day while in-band). Pick sell/buy tokens (auto-picks the deepest CL pool; chips if several fee tiers), 25/50/75/MAX amount chips with USD estimate, choose a band: **TIGHT · 1 TICK** (default — one tick-spacing hugging market, fills on the first uptick) or +1→3% … +10→25% / custom, snapped to tick spacing; a `?` chip opens a structured band explainer (start/end/avg/grid rows). The panel renders as a structured **order ticket** (aligned key-value sections, no prose walls) phrased in the sell token's price: `ORDER` (fill-start / fully-sold / avg-fill premiums with exact prices — avg is the band's geometric mean, exact closed form — band ticks with a `≡ TIGHT` marker when a small custom band snaps onto the tight one, order-mode range bar), `PROJECTED · FULL FILL` (avg price vs market, exact proceeds + USD, est. fee income $/day while in band), `FEES · MAKER VS TAKER` (0% vs pool fee ≈ $ on your size), `MECHANICS` (fills / un-fills / after-fill withdraw / don't stake). Placing mints an out-of-range one-sided position (sell-side min ≈ 100% guards against the price having entered the band). Fills as the token appreciates through the band and earns pool fees while filling; **un-fills if price retreats** and nothing auto-executes — withdraw after fill to lock in.

## Safety rails

- Kyber calldata is opaque → four gates before sending: the API's `routerAddress` must equal the `.env` whitelist (and the tx `to` is always the whitelist address, never the API's), `transactionValue` must match expectation exactly (0 for ERC-20 in, amountIn for native ETH), the built `amountIn` must equal the request, and the built `amountOut` must be ≥ the fresh quote minus the user's slippage (catches degraded/tampered builds). The gates live in ONE place (`lib/kyberExec.ts`) shared by SWAP and ZAP so they can never diverge.
- ZAP adds two more on its swap leg: the fresh route's `tokenOut` must be the pool's counter-token, and the fresh output must still be within slippage (+0.5% grace) of the previewed plan — otherwise it halts before the wallet ever sees the tx. Deposits then use the received-amount ground truth from the receipt, and approvals stay exact-amount per step.
- Exact-amount approvals only (no infinite approvals).
- All writes pinned to chainId 4663; wrong-network banner blocks confusion.
- Everything reads live on-chain state each ~15s (protocol parameters are Safe-controlled and can change at any time). Pools hosting your range orders get a dedicated **4s slot0 feed** (single multicall) so fill %, holdings and the range bar track near-live; numeric updates flash **green ▲ / red ▼** by direction, and the range-bar marker glides so drift direction is visible.

## Pool indexer (`indexer/`)

The heavier backend behind uniswap discovery. Zero npm dependencies beyond the
app's own (`viem`, `tsx`; storage is node's built-in `node:sqlite`, requires
node ≥ 22.13). One process, four loops, a read-only HTTP API:

- **Catalog** — the authoritative pool list, built ONLY from the official
  factories: univ3 `PoolCreated` logs (backfill via Blockscout's uncapped
  etherscan-style `getLogs`, ~22 pages for full history, with automatic
  fallback to windowed RPC `getLogs` if Blockscout flakes; then a 10s RPC
  tail), univ2 `allPairsLength`/`allPairs` enumeration (backfill == tail).
  Third-party APIs never admit a pool — they only enrich — so spoofed/fork
  pools are structurally excluded (stronger than the old per-query
  `factory.getPool` round-trip, which remains as the client-side fallback).
- **State sweeps** (multicall, 400 calls/aggregate) — univ3: `slot0` +
  `liquidity` + both erc20 balances; univ2: `getReserves` + `totalSupply`.
  Hot pools (TVL ≥ $10k, GT-listed, or < 1h old) refresh every 60s; the whole
  catalog hourly (~280 aggregates); new pools immediately.
- **Pricing waterfall → TVL** — GeckoTerminal token prices seed (ground truth
  while < 30 min old), then prices propagate through the deepest priced-side
  pool (≥ $300 depth so dust can't set prices), USDG ≈ $1 bootstraps before
  the first GT cycle. TVL = sum of priced sides (one side priced → 2×, flagged
  approximate). All REAL numbers are display/ranking only — never tx inputs.
- **Stats** — GeckoTerminal top lists (network + uniswap-v2 + uniswap-v3, top
  200 each, paced ≤ 30 calls/min free tier) every 5 min: 24h volume/txns +
  GT's own reserve figure. GT has no UP33 entry — UP33 stats stay on the
  frontend's dexscreener/goldsky path.
- **API** — `GET /api/pools?q=&proto=univ2,univ3&min_tvl=&sort=tvl|vol|created&limit=&offset=`
  (response shape mirrors the frontend's `PoolsData`/`PoolStat`; bigints as
  strings; `ready:false` while the first backfill runs → frontend keeps its
  fallback), `GET /api/tokens?q=` (symbol/address autocomplete),
  `GET /api/health` (counts, cursors, rss).

Data lives in `indexer/data/index.db` (WAL SQLite); delete it to re-backfill
from scratch — the kv cursors make every loop resumable.

The tuning above follows from the chain's scale, measured July 2026: ~100k+
univ3 pools **growing ~20k/day** (launchpad factories mint a pool per token),
11,640 univ2 pairs, ≥95% dust, 100ms blocks (~862k/day), and ~2.6M Swap
events/day chain-wide — which is why volume comes from GeckoTerminal instead
of self-indexed swaps (revisit with Envio HyperIndex, which supports chain 4663
natively, if self-computed fee/APR analytics are ever wanted). At this scale a
full state sweep is ~1k multicall aggregates (~7 min hourly); the hot tier stays
tiny because real TVL, not pool count, bounds it. If you re-measure the pool
count, use the RPC-window scan — Blockscout's paged `getLogs` silently
undercounts.

## Chain reads

The app is a **fully static SPA — it has no backend of its own**. The browser talks
directly to: the chain RPC (reads only; writes are signed and sent by the user's
wallet), the KyberSwap aggregator, DexScreener, and the Goldsky subgraph. There is
no database and no server-side state; limit-order tags live in each user's browser
localStorage (device-local by design).

The **only secret** is a private RPC URL (`RPC` in `.env`) — Vite bakes env values
into the JS bundle, so a public build must never have it set. One build serves
every mode; the read transport resolves at runtime:

| mode | build | chain reads |
|---|---|---|
| personal / local | `.env` has `RPC` | that URL, baked (keep the build private) |
| server + reverse proxy | `RPC` unset | same-origin `/rpc` → your proxy holds the key server-side |
| plain static hosting | `RPC` unset | `/rpc` probe fails → falls back to the public RPC (keyless, slower) |

Wallet-facing chain metadata (`wallet_addEthereumChain`) always advertises the
**public** RPC — a private key-bearing URL never reaches users' wallets.

On top of all modes, **each user can bring their own RPC**: the footer `rpc:`
control accepts any http(s) JSON-RPC url, sanity-checks it with an `eth_chainId`
probe (must be 4663), stores it in that browser's localStorage and applies on
reload. A user-set endpoint takes priority over everything above; RESET returns
to the deployment default.

## Deploy

`npm run build` produces a static `dist/` — hash routing needs no rewrite rules,
so any static host works (CF Pages / Netlify / S3):

```bash
RPC="" npm run build   # RPC MUST be empty for any build you serve publicly
```

To keep a private RPC key server-side, serve `dist/` behind a reverse proxy that
terminates these same-origin paths. Nothing here is app-specific — any nginx /
caddy / Cloudflare Worker will do:

| path | proxies to | why |
|---|---|---|
| `/rpc` | your JSON-RPC upstream | key stays server-side; app auto-detects and uses it |
| `/kyber` | `https://aggregator-api.kyberswap.com` | build with `KYBERSWAP_AGGREGATOR_API_BASE_URL=/kyber` |
| `/kyber-setting` | `https://ks-setting.kyberswap.com` | token list |
| `/dexscreener` | `https://api.dexscreener.com` | UP33 TVL/volume stats |
| `/goldsky` | `https://api.goldsky.com` | UP33 v2 subgraph |
| `/api` | your `indexer` process on :8787 | uniswap pool discovery (optional) |

Routing the data APIs through your own origin means the browser only ever talks
to your origin + the chain RPC + wallet relays, so users on restrictive networks
keep every feature. Recommended if you expose these publicly: rate-limit `/rpc`
per-IP plus a global ceiling, and 403 requests carrying a foreign browser
`Origin` so other sites can't burn your upstream quota through users' browsers.

`vite.config.ts` emulates every one of these proxies in dev and preview, so the
server mode is testable locally without deploying anything:

```bash
RPC="" npm run build && npm run preview   # /rpc upstream stays in the node process
```

Two constraints worth knowing before you touch the build config:
- Relative API bases need `new URL(x, location.origin)` — a bare
  `new URL('/kyber/…')` throws and silently kills all quotes.
- viem's `ccip` module is the bundle's only lazy chunk on an error path, and it
  is imported inside **every** eth_call error before the selector check. It is
  deliberately pinned into the eager bundle (`src/main.tsx`) so a redeploy can't
  404 it under an open tab and mask the real revert reason. Other stale lazy
  chunks (wallet SDKs, RainbowKit locales) are handled by a `vite:preloadError`
  guarded auto-reload. Serve old + new asset generations side by side across a
  deploy if you want open tabs to survive it.

## Security

Threat model researched against real dApp incidents (BadgerDAO injected-script
approval drain, Curve/CoW DNS hijacks, Ledger Connect Kit npm supply chain) and
the OWASP Web3 attack-vector list. Architecture principle: **static SPA + thin
stateless reverse proxy = minimal attack surface** — no accounts, no database,
no server-side keys; a heavier backend would add attack surface, not safety.

**Wallet-interaction safety (the money paths)**
- browser-wallet signing only; no key material anywhere in app, server, or storage
- exact-amount approvals; four gates on opaque kyber calldata (see Safety rails);
  writes chainId-pinned with deadlines; native-route mins from fresh on-chain price
- token picker rows always show the contract address (anti symbol-spoofing);
  contract directory lists full addresses linked to the explorer

**XSS / injected-drainer defenses**
- ships with CSP `script-src 'self'` in mind: no inline scripts, no eval, no
  third-party or CDN scripts — everything self-hosted and content-hashed. React
  escaping only (no `dangerouslySetInnerHTML`), `noreferrer` on external links
- recommended headers when self-hosting: `X-Frame-Options DENY` +
  `frame-ancestors 'none'` (clickjacking), `nosniff`, `Referrer-Policy`,
  `Permissions-Policy` (all sensors off), `Cross-Origin-Opener-Policy:
  same-origin-allow-popups` (wallet popups still work), `frame-src` limited to
  WalletConnect verify, HSTS at the edge
- `connect-src` stays `https:/wss:` by design: the footer bring-your-own-RPC
  feature and wallet relays need it; the script-src wall is the real defense

**Supply chain**
- dependencies exact-pinned (`.npmrc save-exact`) + lockfile — a compromised
  patch release can't slip in via re-install (Ledger-style attack)
- `npm audit` on every dependency change. Known open advisory: `ws` DoS via
  wagmi's WalletConnect chain — server-side-only issue, browsers use native
  WebSocket; the fix is a wagmi v2→v3 major migration, deferred deliberately
- zero analytics/trackers/third-party runtime scripts

**If you self-host publicly**, the frontend-integrity risk worth planning for is
DNS/CDN hijack: fetch your own live site the way users do and byte-compare
against your local build. A CSP with no inline scripts blocks injection at the
browser level even if HTML were tampered in transit.

## Known v1 limits

- Native-path swaps are single-hop (direct pools); kyber path covers multi-hop routing.
- UP33-native route with ETH input requires wrapping to WETH first (one click).
- veUP locking / voting / bribes are read-only concerns for later versions.
- Uniswap v2/v3 long-tail pools outside GeckoTerminal's top-200 lists show
  chain-derived TVL but no 24h volume (blank VOL/FEES/APR columns) — computing
  volume ourselves would mean indexing ~2.6M Swap events/day (measured);
  deliberately skipped.
- Uniswap v2 POSITIONS management (LP-token balances, remove-liquidity) is not
  wired yet — POOLS browse + add-liquidity only. v2 LPs are plain ERC-20s, so
  wallet-level tracking works meanwhile.
- Creating a NEW univ3 pool (`createAndInitializePoolIfNecessary`) is not
  wired up — mint into existing pools only.
- Uniswap v4 is live on the chain but not integrated (addresses noted in
  `src/config/addresses.ts`; the indexer's catalog model extends to v4's
  `Initialize` events if/when wanted).

## Disclaimer

This software is provided as-is under the MIT license, with **no warranty of any
kind**. It is an unaudited interface to third-party smart contracts that this
project does not control, on a chain whose protocol parameters are Safe-controlled
and can change at any time. Interacting with DeFi protocols can result in total
loss of funds. You are solely responsible for reviewing the code, verifying every
contract address, and for any transaction your wallet signs. Nothing here is
financial advice.
