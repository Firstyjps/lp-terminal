// Tiny external store for the terminal activity log (no deps).

export type LogKind = 'info' | 'pending' | 'ok' | 'err'
export type LogAction = { label: string; onClick: () => void }
export type LogLine = {
  id: number
  ts: number
  kind: LogKind
  text: string
  hash?: string
  action?: LogAction
}

let lines: LogLine[] = []
let nextId = 1
const subs = new Set<() => void>()

function emit() {
  subs.forEach((f) => f())
}

export const txlog = {
  push(kind: LogKind, text: string, hash?: string, action?: LogAction): number {
    const id = nextId++
    lines = [...lines, { id, ts: Date.now(), kind, text, hash, action }].slice(-200)
    emit()
    return id
  },
  update(id: number, patch: Partial<Omit<LogLine, 'id'>>) {
    lines = lines.map((l) => (l.id === id ? { ...l, ...patch, ts: Date.now() } : l))
    emit()
  },
  get(): LogLine[] {
    return lines
  },
  clear() {
    lines = []
    emit()
  },
  subscribe(f: () => void): () => void {
    subs.add(f)
    return () => subs.delete(f)
  },
}
