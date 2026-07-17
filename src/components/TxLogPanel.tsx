import { useEffect, useRef, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import { EXPLORER } from '../config/addresses'
import { txlog, type LogLine } from '../lib/txlog'

function glyph(l: LogLine): string {
  switch (l.kind) {
    case 'ok':
      return '✓'
    case 'err':
      return '✗'
    case 'pending':
      return '⧗'
    default:
      return '>'
  }
}

export function TxLogPanel() {
  const { t } = useTranslation()
  const lines = useSyncExternalStore(txlog.subscribe, txlog.get)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  return (
    <div className="logpanel" ref={ref}>
      {lines.length === 0 && <div className="logline dim">{t('log.ready')}</div>}
      {lines.length > 2 && (
        <div className="logline dim">
          <span className="t">--------</span>
          <span className="txt">{t('log.events', { n: lines.length })}</span>
          <button className="chip logaction" onClick={() => txlog.clear()}>
            {t('log.clear')}
          </button>
        </div>
      )}
      {lines.map((l) => (
        <div key={l.id} className={`logline ${l.kind}`}>
          <span className="t">{new Date(l.ts).toLocaleTimeString('en-GB')}</span>
          <span className="txt">
            {glyph(l)} {l.text}
          </span>
          {l.hash && (
            <a href={`${EXPLORER}/tx/${l.hash}`} target="_blank" rel="noreferrer">
              tx↗
            </a>
          )}
          {l.action && (
            <button className="chip logaction" onClick={l.action.onClick}>
              {l.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  )
}
