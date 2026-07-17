import { defineChain } from 'viem'
import { PUBLIC_RPC } from './env'

export const robinhood = defineChain({
  id: 4663,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  // chain METADATA always carries the key-free public RPC — this is what a
  // wallet_addEthereumChain suggestion hands to users' wallets. The app's own
  // reads go through the wagmi transport (see wagmi.ts), never this URL.
  rpcUrls: { default: { http: [PUBLIC_RPC] } },
  blockExplorers: {
    default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' },
  },
  contracts: {
    multicall3: { address: '0xcA11bde05977b3631167028862bE2a173976CA11' },
  },
})
