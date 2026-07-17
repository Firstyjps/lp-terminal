import { getAddress, type Address } from 'viem'

/** chain-official public RPC — wallet-safe, key-free. Used for chain metadata
 *  (what gets suggested to wallets) and as the last-resort read transport. */
export const PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com'

// Values come from the repo-root .env via vite envDir/envPrefix (see vite.config.ts).
export const ENV = {
  // Private RPC override (e.g. an Alchemy URL). SECRET when set — it is baked
  // into the bundle, so only use it for personal/local builds. Public server
  // builds must leave it unset: the app then reads through same-origin /rpc
  // (nginx proxy keeps the key server-side) with PUBLIC_RPC as fallback.
  rpcUrl: (import.meta.env.RPC ?? '').trim(),
  // absolute URL (browser calls kyber direct) or a path like /kyber (same-origin
  // reverse proxy — see README "Chain reads"): both work, fetch resolves relative URLs.
  kyberBase: ((import.meta.env.KYBERSWAP_AGGREGATOR_API_BASE_URL ?? '').trim() ||
    'https://aggregator-api.kyberswap.com').replace(/\/+$/, ''),
  // same-origin proxy mode: when the kyber base is a path, ALL third-party data
  // APIs (kyber settings, dexscreener, goldsky) route through the site's nginx
  // proxies too — users behind restrictive networks keep every feature, and the
  // browser only ever talks to our origin + the chain RPC + wallet relays.
  get proxied() {
    return this.kyberBase.startsWith('/')
  },
  kyberChain: (import.meta.env.KYBERSWAP_CHAIN ?? 'robinhood').trim(),
  // Whitelisted swap target: the only address kyber calldata is ever sent to.
  kyberRouter: getAddress(
    (import.meta.env.KYBERSWAP_ROUTER_ADDRESS ?? '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5').trim(),
  ) as Address,
  // Optional. Injected wallets (MetaMask/Rabby/OKX…) work without it; only
  // WalletConnect QR pairing needs a real project id.
  wcProjectId: (import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? '').trim() || 'up33-terminal-local',
  // Optional platform fee on kyber swaps (verified working on this chain):
  // both must be set to activate; fee is charged on the output token and sent
  // to the receiver by the kyber router itself.
  kyberFeeBps: Number((import.meta.env.KYBERSWAP_FEE_BPS ?? '').trim()) || 0,
  kyberFeeReceiver: (import.meta.env.KYBERSWAP_FEE_RECEIVER ?? '').trim(),
}
