import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Address } from 'viem'
import { NATIVE } from '../lib/kyber'
import { shortAddr } from '../lib/format'
import type { TokenInfo } from '../types'

export function TokenSelect(props: {
  list: TokenInfo[]
  value: TokenInfo
  exclude?: Address
  onChange: (t: TokenInfo) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const ex = props.exclude?.toLowerCase()
    let l = props.list.filter((t) => t.address.toLowerCase() !== ex)
    if (q) {
      const s = q.toLowerCase()
      l = l.filter((t) => t.symbol.toLowerCase().includes(s) || t.address.toLowerCase() === s)
    }
    return l.slice(0, 80)
  }, [props.list, props.exclude, q])

  return (
    <div className="tsel">
      <button className="tsel-btn" onClick={() => setOpen(!open)}>
        {props.value.symbol} ▾
      </button>
      {open && (
        <>
          <div className="tsel-backdrop" onClick={() => setOpen(false)} />
          <div className="tsel-pop">
            <div className="filter">
              <input
                className="input"
                autoFocus
                placeholder={t('common.tokenSearch')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
              />
            </div>
            {filtered.map((tok) => (
              <div
                key={tok.address}
                className="tsel-item"
                onClick={() => {
                  props.onChange(tok)
                  setOpen(false)
                  setQ('')
                }}
              >
                <span>
                  {tok.symbol} {tok.native && <span className="dim">{t('common.gasToken')}</span>}
                </span>
                <span className="dim mono-sm">{tok.native ? NATIVE.slice(0, 8) : shortAddr(tok.address)}</span>
              </div>
            ))}
            {filtered.length === 0 && <div className="tsel-item dim">{t('common.noMatch')}</div>}
          </div>
        </>
      )}
    </div>
  )
}
