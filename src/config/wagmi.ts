import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { fallback, http } from 'wagmi'
import { customRpc } from '../lib/rpcPref'
import { robinhood } from './chain'
import { ENV, PUBLIC_RPC } from './env'

// Read-transport resolution (one build works in every deployment):
//  - user-set custom RPC (footer control, localStorage) -> always wins
//  - RPC set in .env (personal/local build)  -> use it directly (secret stays local)
//  - production build without RPC (server)   -> same-origin /rpc proxy (nginx keeps
//    the key server-side), falling back to the public RPC when no proxy exists
//    (plain static hosting)
//  - dev without RPC                          -> public RPC
const userRpc = customRpc()
const transport = userRpc
  ? http(userRpc, { batch: true })
  : ENV.rpcUrl
    ? http(ENV.rpcUrl, { batch: true })
    : import.meta.env.PROD
      ? fallback([http('/rpc', { batch: true }), http(PUBLIC_RPC, { batch: true })])
      : http(PUBLIC_RPC, { batch: true })

export const wagmiConfig = getDefaultConfig({
  appName: 'Alphast',
  projectId: ENV.wcProjectId,
  chains: [robinhood],
  transports: { [robinhood.id]: transport },
  ssr: false,
})
