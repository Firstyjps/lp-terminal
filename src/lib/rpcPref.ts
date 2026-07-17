// user-selectable RPC endpoint, persisted per-browser (localStorage).
// Read once at startup by config/wagmi.ts (highest-priority transport);
// changes apply via page reload.

const KEY = 'up33.rpcUrl.v1'

export function customRpc(): string {
  try {
    return (localStorage.getItem(KEY) ?? '').trim()
  } catch {
    return ''
  }
}

export function setCustomRpc(url: string) {
  try {
    const v = url.trim()
    if (v) localStorage.setItem(KEY, v)
    else localStorage.removeItem(KEY)
  } catch {
    /* storage unavailable — ignore */
  }
}

export function isValidRpcUrl(u: string): boolean {
  try {
    const p = new URL(u)
    return p.protocol === 'https:' || p.protocol === 'http:'
  } catch {
    return false
  }
}

/** cheap sanity check before saving: endpoint answers eth_chainId with the right chain */
export async function probeRpc(
  url: string,
  expectChainId: number,
  timeoutMs = 6_000,
): Promise<{ ok: true } | { ok: false; err: string }> {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: ctl.signal,
    })
    clearTimeout(t)
    const j = await r.json().catch(() => null)
    const id = typeof j?.result === 'string' ? parseInt(j.result, 16) : NaN
    if (!r.ok || !Number.isFinite(id)) return { ok: false, err: `no eth_chainId answer (http ${r.status})` }
    if (id !== expectChainId) return { ok: false, err: `wrong chain: got ${id}, need ${expectChainId}` }
    return { ok: true }
  } catch {
    return { ok: false, err: 'unreachable (network/CORS)' }
  }
}
