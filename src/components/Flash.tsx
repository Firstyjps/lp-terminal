import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Flashes its children green (value went up) or red (down) whenever the
 * tracked number changes — direction is visible at a glance. Pass `arrow`
 * to also show a transient ▲/▼ next to the value.
 */
export function Flash(props: { v: number | null | undefined; arrow?: boolean; children: ReactNode }) {
  const { v } = props
  const prev = useRef<number | null | undefined>(v)
  const [dir, setDir] = useState<1 | -1 | 0>(0)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const a = prev.current
    prev.current = v
    if (typeof v !== 'number' || typeof a !== 'number' || !Number.isFinite(v) || !Number.isFinite(a)) return
    const eps = Math.abs(a) * 1e-9 + 1e-15 // ignore float jitter
    if (Math.abs(v - a) <= eps) return
    setDir(v > a ? 1 : -1)
    setNonce((n) => n + 1)
  }, [v])

  useEffect(() => {
    if (dir === 0) return
    const t = setTimeout(() => setDir(0), 1200)
    return () => clearTimeout(t)
  }, [dir, nonce])

  return (
    <span key={nonce} className={`flash ${dir === 1 ? 'flash-up' : dir === -1 ? 'flash-down' : ''}`}>
      {props.children}
      {props.arrow && dir !== 0 && (
        <span className={`flash-arrow ${dir === 1 ? 'green' : 'red'}`}>{dir === 1 ? '▲' : '▼'}</span>
      )}
    </span>
  )
}
