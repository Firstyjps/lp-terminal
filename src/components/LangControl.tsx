import { useTranslation } from 'react-i18next'
import { currentLang, setLang, type Lang } from '../i18n'

const LABELS: Record<Lang, string> = { en: 'EN', zh: '中文' }

/** footer language switcher — instant, persisted, wallet modal follows */
export function LangControl() {
  const { t, i18n } = useTranslation()
  void i18n.language // subscribe: re-render on language change
  const cur = currentLang()
  return (
    <span className="theme-ctl">
      <span className="dim">{t('lang.label')}</span>
      {(Object.keys(LABELS) as Lang[]).map((l) => (
        <button key={l} className={`chip ${cur === l ? 'on' : ''}`} onClick={() => setLang(l)}>
          {LABELS[l]}
        </button>
      ))}
    </span>
  )
}
