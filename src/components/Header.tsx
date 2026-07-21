import { ConnectButton } from '@rainbow-me/rainbowkit'
import { useTranslation } from 'react-i18next'
import { fmtDur } from '../lib/format'
import { useEpoch } from '../hooks/useEpoch'
import { usePools } from '../hooks/usePools'

export type TabId = 'pools' | 'positions' | 'analyze' | 'swap'
const TABS = [
  { id: 'pools', labelKey: 'hdr.pools', key: '1' },
  { id: 'positions', labelKey: 'hdr.positions', key: '2' },
  { id: 'analyze', labelKey: 'hdr.analyze', key: '3' },
  { id: 'swap', labelKey: 'hdr.swap', key: '4' },
] as const

export function Header(props: { tab: TabId; onTab: (t: TabId) => void }) {
  const { t } = useTranslation()
  const epoch = useEpoch()
  const pools = usePools()
  const p = pools.data?.protocol

  return (
    <div className="hdr">
      <span className="brand">
        ALPHAST<span className="cursor">▮</span>
      </span>
      <div className="tabs">
        {TABS.map((tb) => (
          <button
            key={tb.id}
            className={`tab ${props.tab === tb.id ? 'active' : ''}`}
            onClick={() => props.onTab(tb.id)}
          >
            <span className="key">[{tb.key}]</span>
            {t(tb.labelKey)}
          </button>
        ))}
      </div>
      <span className="hdr-meta">
        {t('hdr.epoch')} <b>{p ? p.epochCount : '…'}</b> · {t('hdr.flip')} <b>{fmtDur(epoch.secsLeft)}</b>
        {p ? (
          <>
            {' '}
            · {t('hdr.blk')} <b>{p.blockNumber.toString()}</b>
          </>
        ) : null}
      </span>
      <ConnectButton.Custom>
        {({ account, chain, openAccountModal, openChainModal, openConnectModal, mounted }) => {
          if (!mounted) return <button className="btn ghost">…</button>
          if (!account)
            return (
              <button className="btn" onClick={openConnectModal}>
                {t('hdr.connect')}
              </button>
            )
          if (chain?.unsupported)
            return (
              <button className="btn danger" onClick={openChainModal}>
                {t('hdr.wrongChain')}
              </button>
            )
          return (
            <button className="btn ghost" onClick={openAccountModal}>
              [{account.displayName}
              {account.displayBalance ? ` · ${account.displayBalance}` : ''}]
            </button>
          )
        }}
      </ConnectButton.Custom>
    </div>
  )
}
