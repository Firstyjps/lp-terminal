// footer control: view / override the chain-read RPC endpoint per browser.
// The choice is stored in localStorage and applied on reload (the wagmi
// transport is resolved once at startup).
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CHAIN_ID } from '../config/addresses'
import { ENV } from '../config/env'
import { customRpc, isValidRpcUrl, probeRpc, setCustomRpc } from '../lib/rpcPref'

export function RpcControl() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [val, setVal] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const cur = customRpc()
  const label = cur ? 'CUSTOM' : ENV.rpcUrl ? 'ENV' : 'DEFAULT'

  if (!open)
    return (
      <button
        className="rpc-toggle"
        title={t('rpc.toggleTip')}
        onClick={() => {
          setVal(cur)
          setErr('')
          setOpen(true)
        }}
      >
        rpc:<span className={cur ? 'green' : ''}>{label}</span>
      </button>
    )

  const v = val.trim()
  const valid = v === '' || isValidRpcUrl(v)

  const apply = async () => {
    if (!valid || busy) return
    if (v === '') {
      setCustomRpc('')
      location.reload()
      return
    }
    setBusy(true)
    setErr('')
    const res = await probeRpc(v, CHAIN_ID)
    setBusy(false)
    if (!res.ok) {
      setErr(res.err)
      return
    }
    setCustomRpc(v)
    location.reload()
  }

  return (
    <span className="rpc-edit">
      <span className="dim">rpc:</span>
      <input
        className="input"
        style={{ width: 300 }}
        value={val}
        autoFocus
        spellCheck={false}
        placeholder={t('rpc.placeholder')}
        onChange={(e) => {
          setVal(e.target.value)
          setErr('')
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void apply()
          if (e.key === 'Escape') setOpen(false)
        }}
      />
      <button className="chip" disabled={!valid || busy} onClick={() => void apply()}>
        {busy ? t('rpc.checking') : t('rpc.apply')}
      </button>
      {cur && (
        <button
          className="chip"
          onClick={() => {
            setCustomRpc('')
            location.reload()
          }}
        >
          {t('rpc.reset')}
        </button>
      )}
      <button className="chip" onClick={() => setOpen(false)}>
        ✕
      </button>
      {err ? <span className="red">{err}</span> : !valid ? <span className="red">{t('rpc.notHttp')}</span> : null}
    </span>
  )
}
