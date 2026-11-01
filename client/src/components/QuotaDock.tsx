import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import type { UsageReport, UsageRow, UsageWindow } from '../../../shared/usage'
import type { MessageKey } from '../../../shared/i18n'
import { formatPercent } from '../../../shared/usage'
import { useNow } from '../companion'
import { t as translate, useLocale } from '../i18n'
import { clampDockPosition } from '../quotaPosition'
import { API_PRESETS } from '../../../shared/catalog'
import { apiPresetLabel, providerLabel } from '../../../shared/catalog-i18n'

interface DockProps {
  report: UsageReport | null
  clockOffset: number
  onOpenUsage?: () => void
  onOpenNative?: () => void
}

const labels = {
  en: { title: 'Quota cockpit', overview: 'REMAINING CAPACITY', accounts: 'accounts', open: 'Open quota dock', close: 'Close quota dock', collapse: 'Collapse', expand: 'Expand', native: 'Float on desktop', details: 'Details', loading: 'Loading account report…', empty: 'No accounts', missing: 'Not reported', stale: 'Cached · may be stale', reset: 'resets in', available: 'Available', balance: 'Balance', more: 'Reset times and more', credits: 'Credits', unsupported: 'Unsupported', names: { 'five-hour': '5 hours', 'seven-day': 'Weekly', 'monthly-total': 'Monthly', 'monthly-coding': 'Monthly coding', other: 'Other' } },
  'zh-CN': { title: '额度驾驶舱', overview: '账户余量', accounts: '个账户', open: '\u6253\u5f00\u989d\u5ea6\u6d6e\u7a97', close: '\u5173\u95ed\u989d\u5ea6\u6d6e\u7a97', collapse: '\u6536\u8d77', expand: '\u5c55\u5f00', native: '\u684c\u9762\u60ac\u6d6e\u7a97', details: '\u8be6\u60c5', loading: '\u6b63\u5728\u8bfb\u53d6\u8d26\u6237\u62a5\u544a…', empty: '\u6682\u65e0\u8d26\u6237', missing: '\u672a\u62a5\u544a', stale: '\u7f13\u5b58\u6570\u636e · \u53ef\u80fd\u8fc7\u671f', reset: '\u540e\u91cd\u7f6e', available: '\u5269\u4f59\u53ef\u7528', balance: '\u4f59\u989d', more: '\u91cd\u7f6e\u65f6\u95f4\u4e0e\u66f4\u591a', credits: '\u79ef\u5206', unsupported: '\u4e0d\u652f\u6301', names: { 'five-hour': '5 \u5c0f\u65f6', 'seven-day': '\u6bcf\u5468', 'monthly-total': '\u6bcf\u6708', 'monthly-coding': '\u6bcf\u6708\u7f16\u7a0b', other: '\u5176\u4ed6' } },
} as const

function remaining(at: number, now: number): string {
  if (at <= now) return '0m'
  const mins = Math.ceil((at - now) / 60_000)
  if (mins >= 1440) return `${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`
  if (mins >= 60) return `${Math.floor(mins / 60)}h ${mins % 60}m`
  return `${mins}m`
}

/** A small instrument mark shared by the browser dock and the desktop panel. */
export function QuotaBrand({ title }: { title: string }) {
  return <div className="qd-brand"><span className="qd-brand-mark" aria-hidden="true"><svg width="23" height="23" viewBox="0 0 24 24" fill="none"><path d="M12 2.5 20.2 7.2v9.5L12 21.5l-8.2-4.8V7.2Z" stroke="currentColor" strokeWidth="1.2" /><path d="m7.5 9 4.5-2.6 4.5 2.6v5.3L12 17l-4.5-2.7Z" stroke="currentColor" strokeWidth="1.1" opacity=".6"/><circle cx="12" cy="12" r="2" fill="currentColor" /></svg></span><span><small>SYNODICA</small><strong>{title}</strong></span></div>
}

function quotaLine(w: UsageWindow, locale: 'en' | 'zh-CN') {
  const t = labels[locale]
  const available = w.usedPercent === undefined ? undefined : 100 - w.usedPercent
  const name = `${w.kind === 'other' ? (w.name || t.names.other) : t.names[w.kind]}${w.scope ? ` · ${w.scope}` : ''}`
  return <div className={`qd-window${available !== undefined && available <= 10 ? ' is-low' : ''}`} key={w.id}>
    <div className="qd-window-label">{name}</div>
    <div className="qd-reading"><strong>{available === undefined ? '—' : `${formatPercent(available)}%`}</strong><small>{available === undefined ? t.missing : t.available}</small></div>
    {available !== undefined ? <meter min={0} max={100} value={available} aria-label={`${name} · ${t.available}`} /> : <div className="qd-meter-empty" aria-hidden="true" />}
  </div>
}

export function QuotaAccount({ row, now, locale }: { row: UsageRow; now: number; locale: 'en' | 'zh-CN' }) {
  const t = labels[locale]
  const snap = row.snapshot
  const primary = snap?.windows.filter((w) => w.kind !== 'other' && !w.scope) ?? []
  const visible = primary.length ? primary : snap?.windows ?? []
  const extra = snap?.windows.filter((w) => !visible.includes(w)) ?? []
  const resets = snap?.windows.filter((w) => w.resetsAt !== undefined) ?? []
  const family = row.type.startsWith('codex') || row.type.startsWith('openai') ? 'openai' : row.type.startsWith('claude') || row.type.startsWith('anthropic') ? 'claude' : row.type.startsWith('kimi') || row.type.startsWith('moonshot') ? 'kimi' : row.type.startsWith('gemini') ? 'gemini' : row.type.startsWith('deepseek') ? 'deepseek' : 'api'
  const mark = { openai: 'O', claude: '✳', kimi: 'K', gemini: '✦', deepseek: 'D', api: '◇' }[family]
  const names = row.providers.map((provider) => {
    const preset = API_PRESETS.find((p) => p.id === provider.id && p.label === provider.label)
    return preset ? apiPresetLabel(locale, preset) : providerLabel(locale, provider)
  })
  return <section className="qd-account" data-state={row.state} data-provider={family}>
    <header><span className="qd-provider-mark" aria-hidden="true">{mark}</span><b>{names.join(' · ') || row.type}</b><span className="qd-account-state"><i aria-hidden="true" />{row.state !== 'ok' && translate(`quota.state.${row.state}` as MessageKey)}</span></header>
    {row.stale && snap && <small className="qd-stale">{t.stale}</small>}
    <div className="qd-metrics">{visible.map((w) => quotaLine(w, locale))}</div>
    {snap?.balances.map((b) => <div className="qd-line qd-balance" key={b.currency}><span>{t.balance}</span><strong>{b.total ?? t.missing}<small>{b.currency}</small></strong></div>)}
    {snap?.credits && <div className="qd-line"><span>{t.credits}</span><strong>{snap.credits.unlimited ? '∞' : snap.credits.balance ?? t.missing}</strong></div>}
    {(!snap || (!snap.windows.length && !snap.balances.length && !snap.credits)) && <div className="qd-line"><span>{t.missing}</span></div>}
    {(extra.length > 0 || resets.length > 0) && <details className="qd-details"><summary>{t.more}</summary>
      {extra.map((w) => quotaLine(w, locale))}
      {resets.map((w) => <div className="qd-reset" key={w.id}><span>{w.kind === 'other' ? (w.name || t.names.other) : t.names[w.kind]}{w.scope ? ` · ${w.scope}` : ''}</span><small>{remaining(w.resetsAt!, now)} {t.reset}</small></div>)}
    </details>}
  </section>
}

export function QuotaSummary({ report, clockOffset }: Pick<DockProps, 'report' | 'clockOffset'>) {
  const locale = useLocale()
  const now = useNow(clockOffset, 30_000)
  const t = labels[locale]
  return <div className="qd-summary">
    <div className="qd-summary-caption"><span>{t.overview}</span>{report && <span>{report.rows.length} {t.accounts}</span>}</div>
    {!report ? <p>{t.loading}</p> : report.rows.length === 0 ? <p>{t.empty}</p> : report.rows.map((row) => <QuotaAccount key={row.key} row={row} now={now} locale={locale} />)}
  </div>
}

const STORAGE = 'ogb.quota.dock.v1'
export function QuotaDock({ report, clockOffset, onOpenUsage, onOpenNative }: DockProps) {
  const locale = useLocale()
  const t = labels[locale]
  const [visible, setVisible] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })
  const dock = useRef<HTMLElement | null>(null)
  const drag = useRef<{ x: number; y: number; startX: number; startY: number } | null>(null)
  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE) || '{}') as { visible?: unknown; collapsed?: unknown; x?: unknown; y?: unknown }
      if (typeof stored.visible === 'boolean') setVisible(stored.visible)
      if (typeof stored.collapsed === 'boolean') setCollapsed(stored.collapsed)
      if (typeof stored.x === 'number' && typeof stored.y === 'number' && Number.isFinite(stored.x) && Number.isFinite(stored.y)) setPosition({ x: stored.x, y: stored.y })
    } catch { /* preferences remain in memory */ }
  }, [])
  useEffect(() => {
    try { localStorage.setItem(STORAGE, JSON.stringify({ visible, collapsed, ...position })) } catch { /* preferences remain in memory */ }
  }, [visible, collapsed, position])
  useLayoutEffect(() => {
    const fit = () => {
      if (!dock.current) return
      const rect = dock.current.getBoundingClientRect()
      setPosition((current) => {
        const next = clampDockPosition(current, current, rect, { width: window.innerWidth, height: window.innerHeight })
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    fit()
    const observer = new ResizeObserver(fit)
    if (dock.current) observer.observe(dock.current)
    window.addEventListener('resize', fit)
    return () => { observer.disconnect(); window.removeEventListener('resize', fit) }
  }, [visible, collapsed])
  function startDrag(e: PointerEvent<HTMLElement>) {
    if ((e.target as HTMLElement).closest('button')) return
    drag.current = { x: e.clientX, y: e.clientY, startX: position.x, startY: position.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function moveDrag(e: PointerEvent<HTMLElement>) {
    if (!drag.current || !dock.current) return
    const next = { x: drag.current.startX + e.clientX - drag.current.x, y: drag.current.startY + e.clientY - drag.current.y }
    setPosition(clampDockPosition(next, position, dock.current.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
  }
  return visible ? <aside ref={dock} className={`quota-dock${collapsed ? ' is-collapsed' : ''}`} style={{ transform: `translate(${position.x}px, ${position.y}px)` }} aria-label={t.title}>
    <header className="qd-head" onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
      <QuotaBrand title={t.title} />
      <div className="qd-actions">
        <button type="button" title={collapsed ? t.expand : t.collapse} aria-label={collapsed ? t.expand : t.collapse} onClick={() => setCollapsed((v) => !v)}>{collapsed ? '▢' : '−'}</button>
        <button type="button" title={t.close} aria-label={t.close} onClick={() => setVisible(false)}>×</button>
      </div>
    </header>
    {!collapsed && <><QuotaSummary report={report} clockOffset={clockOffset} /><footer>
      {onOpenUsage && <button type="button" onClick={onOpenUsage}>{t.details}</button>}
      {onOpenNative && <button type="button" onClick={onOpenNative}>{t.native}</button>}
    </footer></>}
  </aside> : <button type="button" className="quota-dock-launcher" onClick={() => setVisible(true)} aria-label={t.open}><span className="qd-launcher-light" aria-hidden="true" />{t.title}<span aria-hidden="true">↗</span></button>
}
