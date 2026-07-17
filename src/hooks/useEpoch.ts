import { useEffect, useState } from 'react'
import { WEEK } from '../config/addresses'

/** epoch flips every Thursday 00:00 UTC (unix weeks) */
export function useEpoch() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])
  const epochStart = Math.floor(now / WEEK) * WEEK
  const nextFlip = epochStart + WEEK
  const secsLeft = nextFlip - now
  return { now, epochStart, nextFlip, secsLeft }
}
