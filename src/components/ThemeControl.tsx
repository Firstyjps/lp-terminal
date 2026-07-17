import { useTranslation } from 'react-i18next'
import { THEMES, applyTheme, useTheme, type ThemeId } from '../lib/theme'

/** footer theme switcher — instant, persisted, also restyles the wallet modal */
export function ThemeControl() {
  const { t } = useTranslation()
  const cur = useTheme()
  return (
    <span className="theme-ctl">
      <span className="dim">{t('theme.label')}</span>
      {(Object.keys(THEMES) as ThemeId[]).map((id) => (
        <button
          key={id}
          className={`chip ${cur === id ? 'on' : ''}`}
          onClick={() => applyTheme(id)}
          title={t('theme.switchTip', { name: id })}
        >
          {THEMES[id].label}
        </button>
      ))}
    </span>
  )
}
