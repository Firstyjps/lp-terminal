// i18n runtime: en/zh, persisted per browser, ?lang= view-only override
// (screenshots/sharing — mirrors ?theme=). The i18next singleton `t` is safe
// to import from non-React modules (tx step labels, zap planner); components
// use useTranslation() so language switches re-render live.
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import { en } from './en'
import { zh } from './zh'

export type Lang = 'en' | 'zh'
const KEY = 'up33.lang.v1'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'translation'
    resources: { translation: typeof en }
  }
}

function detectLang(): Lang {
  try {
    const q = new URLSearchParams(location.search).get('lang')
    if (q === 'en' || q === 'zh') return q // view-only — not persisted
    const s = localStorage.getItem(KEY)
    if (s === 'en' || s === 'zh') return s
  } catch {
    /* storage blocked */
  }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: detectLang(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false }, // React escapes; keep symbols like → intact
  returnEmptyString: false,
})
document.documentElement.lang = i18n.language === 'zh' ? 'zh-CN' : 'en'

export function setLang(l: Lang): void {
  void i18n.changeLanguage(l)
  try {
    localStorage.setItem(KEY, l)
  } catch {
    /* storage blocked — applies for this tab */
  }
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
}

export function currentLang(): Lang {
  return i18n.language?.startsWith('zh') ? 'zh' : 'en'
}

/** singleton translate for non-React modules (txlog/step labels, planners) */
export const t = i18n.t.bind(i18n)
export default i18n
