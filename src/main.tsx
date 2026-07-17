import React from 'react'
import ReactDOM from 'react-dom/client'
import { ccipRequest } from 'viem/utils'
import '@rainbow-me/rainbowkit/styles.css'
import './styles.css'
import { t } from './i18n' // init before anything renders or pushes txlog lines
import App from './App'
import { txlog } from './lib/txlog'

// viem lazy-imports its ccip module inside EVERY eth_call error path (the
// import happens before the OffchainLookup selector check), which made it the
// one chunk this app fetches mid-error. After a redeploy, a tab opened before
// the deploy 404s the old hash and the module error MASKS the real revert
// (seen live 2026-07-16: a Kyber swap revert surfaced as "Failed to fetch
// dynamically imported module ccip-*.js"). Referencing the module here folds
// it into the eager bundle so it can never go stale.
;(globalThis as Record<string, unknown>).__viemCcipEagerPin = ccipRequest

// Other lazy chunks (wallet SDKs, RainbowKit locales) can still 404 in a tab
// that outlives a deploy. Vite surfaces those failures as vite:preloadError —
// reload once to pick up the new build instead of failing the user's action.
// The timestamp guard stops reload loops on a genuinely broken build.
const RELOAD_KEY = 'up33.staleChunkReload'
window.addEventListener('vite:preloadError', (e) => {
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (Date.now() - last < 60_000) return // just reloaded — let the error surface
  sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  e.preventDefault()
  location.reload()
})
{
  const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
  if (last && Date.now() - last < 15_000) {
    txlog.push('info', t('app.reloaded'))
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
