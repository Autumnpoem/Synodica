import { useEffect, useState, type FormEvent } from 'react'
import type { OfficeConnection } from '../../shared/desktop'
import type { UsageReport } from '../../shared/usage'
import { fetchUsage, refreshUsage } from './api'
import { desktopBridge } from './companion'
import { connectEventStream } from './eventStream'
import { useLocale } from './i18n'
import { QuotaBrand, QuotaSummary } from './components/QuotaDock'

const words = {
  en: { title: 'Quota cockpit', refresh: 'Refresh', refreshing: 'Refreshing…', collapse: 'Collapse', expand: 'Expand', pin: 'Always on top', unpin: 'Unpin', close: 'Close', error: 'Could not load quota report', connection: 'Office', local: 'Local office', remote: 'Remote office', address: 'Office URL', token: 'Access token', connect: 'Connect', disconnect: 'Switch to local', connecting: 'Connecting…', hint: 'Use the current office access token. It is used for this sign-in only.' },
  'zh-CN': { title: '额度驾驶舱', refresh: '\u5237\u65b0', refreshing: '\u5237\u65b0\u4e2d…', collapse: '\u6536\u8d77', expand: '\u5c55\u5f00', pin: '\u7f6e\u9876', unpin: '\u53d6\u6d88\u7f6e\u9876', close: '\u5173\u95ed', error: '\u65e0\u6cd5\u8bfb\u53d6\u989d\u5ea6\u62a5\u544a', connection: '\u529e\u516c\u5ba4', local: '\u672c\u5730\u529e\u516c\u5ba4', remote: '\u8fdc\u7a0b\u529e\u516c\u5ba4', address: '\u529e\u516c\u5ba4\u7f51\u5740', token: '\u8bbf\u95ee\u4ee4\u724c', connect: '\u8fde\u63a5', disconnect: '\u5207\u56de\u672c\u5730', connecting: '\u8fde\u63a5\u4e2d…', hint: '\u586b\u5199\u5f53\u524d\u529e\u516c\u5ba4\u8bbf\u95ee\u4ee4\u724c\uff0c\u4ec5\u7528\u4e8e\u672c\u6b21\u767b\u5f55\u3002' },
} as const

/** Only rendered at #/quota in the desktop shell. Fetches the same sanitized report as Usage. */
export function QuotaApp() {
  const bridge = desktopBridge()
  const locale = useLocale()
  const t = words[locale]
  const [report, setReport] = useState<UsageReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [windowState, setWindowState] = useState({ pinned: true, collapsed: false })
  useEffect(() => { void bridge?.getQuotaState().then(setWindowState) }, [bridge])
  useEffect(() => {
    let alive = true
    const load = () => void fetchUsage().then((r) => { if (alive) { setReport(r); setError('') } }).catch(() => { if (alive) setError(t.error) })
    load()
    const closeStream = connectEventStream('/api/events', (events) => {
      events.onerror = () => { if (alive) setError(t.error) }
      // A sync frame marks every reconnect. Usage is separate from the office snapshot, so read
      // its authoritative report after the frame before applying later usage:account events.
      events.addEventListener('sync', load)
      events.onmessage = (e) => {
        try {
          const message = JSON.parse(e.data) as { type?: string; report?: UsageReport }
          if (alive && message.type === 'usage:account' && message.report) setReport(message.report)
        } catch { /* an unrelated event is ignored */ }
      }
    })
    return () => { alive = false; closeStream() }
  }, [t.error])
  const refresh = () => {
    if (busy) return
    setBusy(true)
    void refreshUsage().then((r) => { setReport(r); setError('') }).catch(() => setError(t.error)).finally(() => setBusy(false))
  }
  const action = (name: 'close' | 'pin' | 'collapse') => void bridge?.quotaAction(name).then(setWindowState)
  return <main className="quota-native">
    <header className="quota-native-head">
      <QuotaBrand title={t.title} />
      <div className="quota-native-actions">
        <button type="button" onClick={() => action('pin')} title={windowState.pinned ? t.unpin : t.pin} aria-label={windowState.pinned ? t.unpin : t.pin}><svg width="15" height="15" viewBox="0 0 20 20" fill={windowState.pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="m7 2 6 0-1 5 3 4H5l3-4-1-5Z"/><path d="M10 11v7"/></svg></button>
        <button type="button" onClick={() => action('collapse')} title={windowState.collapsed ? t.expand : t.collapse} aria-label={windowState.collapsed ? t.expand : t.collapse}>{windowState.collapsed ? '▢' : '−'}</button>
        <button type="button" onClick={() => action('close')} title={t.close} aria-label={t.close}>×</button>
      </div>
    </header>
    {!windowState.collapsed && <div className="quota-native-body">
      <div className="quota-native-toolbar"><button type="button" onClick={refresh} disabled={busy || report?.refreshing}>{busy || report?.refreshing ? t.refreshing : t.refresh}</button></div>
      {error && <p role="alert">{error}</p>}
      <QuotaSummary report={report} clockOffset={report ? report.serverNow - Date.now() : 0} />
    </div>}
  </main>
}

/** Mount in a desktop-only settings/office surface; remote URLs stay editable and local data stays local. */
export function OfficeConnectionPanel() {
  const bridge = desktopBridge()
  const locale = useLocale()
  const t = words[locale]
  const [connection, setConnection] = useState<OfficeConnection | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { void bridge?.getConnection().then((value) => { setConnection(value); setUrl(value.remoteUrl ?? '') }).catch(() => {}) }, [bridge])
  if (!bridge) return null
  const connect = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    void bridge.connectRemote(url, token).then(setConnection).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => { setToken(''); setBusy(false) })
  }
  const disconnect = () => {
    setBusy(true)
    setError('')
    void bridge.disconnectRemote().then(setConnection).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err))).finally(() => setBusy(false))
  }
  return <section className="office-connection">
    <h3>{t.connection}</h3>
    <p>{connection?.mode === 'remote' ? `${t.remote}: ${connection.remoteUrl}` : t.local}</p>
    <form onSubmit={connect}>
      <label>{t.address}<input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://office.example.com/" required /></label>
      <label>{t.token}<input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required /></label>
      <small>{t.hint}</small>
      <div><button type="submit" disabled={busy}>{busy ? t.connecting : t.connect}</button>{connection?.mode === 'remote' && <button type="button" onClick={disconnect} disabled={busy}>{t.disconnect}</button>}</div>
    </form>
    {error && <p role="alert">{error}</p>}
  </section>
}
