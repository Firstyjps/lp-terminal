import { formatUnits } from 'viem'

/** significant-digit number formatting with thousands separators */
export function fmtNum(x: number, sig = 5): string {
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '0'
  sig = Math.max(1, Math.min(sig, 21)) // toPrecision throws outside [1,100]
  const neg = x < 0
  const a = Math.abs(x)
  let s: string
  if (a >= 1) {
    const intDigits = Math.floor(Math.log10(a)) + 1
    const frac = Math.max(0, Math.min(sig - intDigits, 8))
    s = a.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: frac })
  } else {
    s = a.toPrecision(sig)
    if (s.includes('e')) {
      const exp = Math.ceil(-Math.log10(a))
      s = a.toFixed(Math.min(exp + sig, 18))
    }
    s = s.replace(/\.?0+$/, '')
  }
  return (neg ? '-' : '') + s
}

export function fmtAmount(v: bigint, decimals: number, sig = 5): string {
  return fmtNum(Number(formatUnits(v, decimals)), sig)
}

/** compact amount for dense table cells: 24.9M, 338.4K, 12.4, 0.0421 */
export function fmtCompact(x: number): string {
  if (!Number.isFinite(x)) return '—'
  if (x !== 0 && Math.abs(x) < 1) return fmtNum(x, 3)
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x)
}

export function fmtCompactAmount(v: bigint, decimals: number): string {
  return fmtCompact(Number(formatUnits(v, decimals)))
}

export function fmtUsd(x: number | string | undefined): string {
  const n = typeof x === 'string' ? Number(x) : x
  if (n === undefined || !Number.isFinite(n)) return ''
  // bounded width: sub-cent USD precision is noise everywhere in this app,
  // and long fractions (dust TVLs) were stretching table columns
  if (n > 0 && n < 0.01) return '<$0.01'
  return '$' + n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 2 })
}

export function fmtPct(x: number, dp = 2): string {
  if (!Number.isFinite(x)) return '—'
  return x.toFixed(dp) + '%'
}

export function shortAddr(a: string): string {
  return a.slice(0, 6) + '…' + a.slice(-4)
}

export function fmtDur(seconds: number): string {
  if (seconds <= 0) return '0s'
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${s}s`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/** signed bps difference of a vs b (positive = a better) */
export function bpsDiff(a: bigint, b: bigint): number {
  if (b === 0n) return 0
  return Number(((a - b) * 1_000_000n) / b) / 100
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}
