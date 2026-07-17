import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

// envDir points at the repo root so `.env` (RPC / KYBERSWAP_*) is picked up.
// envPrefix exposes exactly those keys to the client bundle.
//
// SECRET RULE: `RPC` (private key-bearing URL) is for personal/local builds only —
// a build meant for public serving must NOT have it set (see README "Chain reads").
// A public build reads the chain through same-origin `/rpc` instead; the dev and
// preview servers below emulate that reverse proxy so the mode is testable locally.
export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('.', import.meta.url))
  const env = loadEnv(mode, envDir, ['RPC'])
  // local emulation of the production reverse proxies, so the server deployment
  // mode is fully testable via `RPC="" npm run build && npm run preview`:
  //  - /rpc   -> the .env RPC (or RPC_PROXY_TARGET override); key stays in node
  //  - /kyber -> the public kyber aggregator
  const upstream = (process.env.RPC_PROXY_TARGET ?? env.RPC ?? '').trim()
  const passthru = (prefix: string, target: string) => ({
    target,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(new RegExp(`^${prefix}`), ''),
  })
  const proxy: Record<string, object> = {
    '/kyber-setting': passthru('/kyber-setting', 'https://ks-setting.kyberswap.com'),
    '/kyber': passthru('/kyber', 'https://aggregator-api.kyberswap.com'),
    '/dexscreener': passthru('/dexscreener', 'https://api.dexscreener.com'),
    '/goldsky': passthru('/goldsky', 'https://api.goldsky.com'),
    // local pool indexer (`npm run indexer`) — same-origin /api like the
    // production nginx route; the frontend falls back to client-side
    // dexscreener discovery when it isn't running
    '/api': { target: `http://localhost:${process.env.INDEXER_PORT || 8787}`, changeOrigin: true },
  }
  if (/^https?:\/\//.test(upstream)) proxy['/rpc'] = passthru('/rpc', upstream)

  return {
    plugins: [react()],
    envDir,
    envPrefix: ['VITE_', 'RPC', 'KYBERSWAP_'],
    server: { port: 5173, proxy },
    preview: { port: 4173, proxy },
    build: {
      rollupOptions: {
        output: {
          // pin ONLY react into a stable vendor chunk: it is 100% eager and its
          // hash survives app deploys (cache win, zero size cost). Everything
          // else — incl. viem/wagmi/rainbowkit — stays on rollup's automatic
          // split: forcing them together was measured to hoist lazy-only wallet
          // SDK modules into the eager bundle (957kB -> 1.7MB). Don't.
          manualChunks(id: string) {
            if (/\/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react'
            return undefined
          },
        },
      },
    },
  }
})
