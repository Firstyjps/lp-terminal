// Theme registry. The <html data-theme> attribute selects a variable block in
// styles.css; this module carries the few values JS needs (RainbowKit accent)
// and the persistence/sync plumbing. index.html applies the saved theme before
// first paint (plus a ?theme= view-only override for screenshots/sharing).
import { useEffect, useState } from 'react'

export const THEMES = {
  mono: { label: 'MONO', acc: '#ffffff', accFg: '#000000' },
  phosphor: { label: 'PHOSPHOR', acc: '#52ff2e', accFg: '#061006' },
  amber: { label: 'AMBER', acc: '#ffb000', accFg: '#140d02' },
  ice: { label: 'ICE', acc: '#4dc9ff', accFg: '#041019' },
  violet: { label: 'VIOLET', acc: '#b18cff', accFg: '#120a20' },
} as const
export type ThemeId = keyof typeof THEMES

const KEY = 'up33.theme.v1'
const DEFAULT: ThemeId = 'mono' // user's pick: black ground, white type, green LP ranges

export function currentTheme(): ThemeId {
  const t = document.documentElement.dataset.theme as ThemeId | undefined
  if (t && t in THEMES) return t
  try {
    const s = localStorage.getItem(KEY) as ThemeId | null
    if (s && s in THEMES) return s
  } catch {
    /* storage blocked */
  }
  return DEFAULT
}

export function applyTheme(t: ThemeId): void {
  document.documentElement.dataset.theme = t
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* storage blocked — theme still applies for this tab */
  }
  window.dispatchEvent(new CustomEvent('up33:theme', { detail: t }))
}

/** live theme id — re-renders subscribers when the footer control switches */
export function useTheme(): ThemeId {
  const [t, setT] = useState<ThemeId>(currentTheme)
  useEffect(() => {
    const h = (e: Event) => setT((e as CustomEvent).detail as ThemeId)
    window.addEventListener('up33:theme', h)
    return () => window.removeEventListener('up33:theme', h)
  }, [])
  return t
}
