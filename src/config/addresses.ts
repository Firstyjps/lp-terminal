import type { Address } from 'viem'

// All addresses verified against Blockscout's verified source (compiler 0.8.19).
export const ADDR = {
  UP: '0x57C0E45cB534413D1C20A4240955d6bB250BB4F1',
  VE_UP: '0x5d321dE36F0bf98D92b291280514F3878582B7B6',
  VOTER: '0x7F749fDD351C1Ceed82d76d7699CB631Eb8332a7',
  MINTER: '0x912EC7A90e8C9829eE0e0f6a4Db5270776Fc3Da5',
  V2_FACTORY: '0xFA5429AEBa338BEa2BFcc1b9a889862Ee395bc28',
  V2_ROUTER: '0xf5198743240fAC98db71868F34c70139b1eb0474',
  CL_FACTORY: '0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3',
  CL_PM: '0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf',
  CL_SWAP_ROUTER: '0xC062b870E813fcA720f1e002c234369Ab3aB9415',
  CL_QUOTER: '0x03983AB2C057a2eac211ff01738a1e49ff325B49',
  WETH: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  USDG: '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168',
} as const satisfies Record<string, Address>

// Official Uniswap v2 + v3 on Robinhood Chain (developers.uniswap.org
// deployments; chain-verified 2026-07-16: NPM.factory() == V3_FACTORY,
// NPM.WETH9() == ADDR.WETH, Router02.factory() == V2_FACTORY, Router02.WETH()
// == ADDR.WETH — beware, Blockscout also lists several unofficial same-name
// forks). v3 write entrypoints are signature-identical to the Slipstream
// CL_PM, so clPmAbi fragments are reused with these addresses.
// v4 is also live (PoolManager 0x8366a39CC670B4001A1121B8F6A443A643e40951,
// PositionManager 0x58dAeC3116AaE6D93017bAaEA7749052e8a04FA7) — not integrated.
export const UNI = {
  V3_FACTORY: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  V3_NPM: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  V2_FACTORY: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
  V2_ROUTER: '0x89e5DB8B5aA49aA85AC63f691524311AEB649eba',
} as const satisfies Record<string, Address>

export const EXPLORER = 'https://robinhoodchain.blockscout.com'
export const WEEK = 604800
export const CHAIN_ID = 4663
