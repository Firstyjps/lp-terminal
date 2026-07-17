/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly RPC?: string
  readonly KYBERSWAP_AGGREGATOR_API_BASE_URL?: string
  readonly KYBERSWAP_CHAIN?: string
  readonly KYBERSWAP_ROUTER_ADDRESS?: string
  readonly KYBERSWAP_FEE_BPS?: string
  readonly KYBERSWAP_FEE_RECEIVER?: string
  readonly VITE_WALLETCONNECT_PROJECT_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
