import { useEffect, useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import { countdownParts, formatPercent, isUsageReason, rowMatches, MAX_INTERVAL_SEC, MIN_INTERVAL_SEC, type UsageBalance, type UsageReport, type UsageRow, type UsageSettings, type UsageWindow } from '../../../shared/usage'
import { cancelUsage, putUsageSettings, refreshUsage } from '../api'
import { useNow } from '../companion'
import { formatCost, formatTokens } from '../format'
import { t } from '../i18n'

interface UsageProps {
  report: UsageReport | null
  /** Deep-link focus: an account key, provider id or employee id (#/usage/<id>). */
  focus?: string
  clockOffset: number
  onReport: (report: UsageReport) => void
  onEditAgent: (id: string) => void
  onProviders: () => void
  onError: (err: unknown) => void
}

const INTERVALS = [60, 120, 300, 600, 900, 1800, 3600].filter((s) => s >= MIN_INTERVAL_SEC && s <= MAX_INTERVAL_SEC)

function countdownText(ms: number): string {
  const c = countdownParts(ms)
  return t(c.key, c.vars)
}

function when(ms: number): string {
  return new Date(ms).toLocaleString()
}

function windowLabel(w: UsageWindow): string {
  if (w.kind !== 'other') return t(`usage.kind.${w.kind}` as MessageKey)
  // The provider's own name, shown literally; else the reported duration.
  return w.name ?? (w.durationMinutes ? t('usage.kind.minutes', { n: w.durationMinutes }) : t('usage.kind.other'))
}

/**
 * Account quotas and balances, one card per account (shared accounts list every provider and
 * employee on them). Every value is what the provider reported: an absent field is shown as "not
 * reported", never as zero or unlimited, and the local token estimate has its own labelled section.
 */
export function Usage({ report, focus, clockOffset, onReport, onEditAgent, onProviders, onError }: UsageProps) {
  const now = useNow(clockOffset)
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!focus || !report) return
    const row = report.rows.find((r) => rowMatches(r, focus))
    if (row) document.getElementById(`quota-${row.key}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [focus, report !== null])

  if (!report) {
    return (
      <div className="office usage-page" data-state="loading">
        <header className="office-header">
          <h1>{t('quota.title')}</h1>
        </header>
        <div className="usage-body">
          <p className="muted">{t('quota.refreshing')}</p>
        </div>
      </div>
    )
  }

  const refresh = (keys?: string[]) => {
    const ids = new Set(keys ?? report.rows.map((r) => r.key))
    setBusyKeys((b) => new Set([...b, ...ids]))
    void refreshUsage(keys)
      .then(onReport)
      .catch(onError)
      .finally(() => setBusyKeys((b) => new Set([...b].filter((k) => !ids.has(k)))))
  }
  const saveSettings = (patch: Partial<UsageSettings>) => {
    void putUsageSettings(patch)
      .then(({ settings }) => onReport({ ...report, settings }))
      .catch(onError)
  }
  const focused = focus ? report.rows.find((r) => rowMatches(r, focus)) : undefined

  return (
    <div className="office usage-page" data-state={report.refreshing ? 'refreshing' : 'idle'}>
      <header className="office-header">
        <h1>{t('quota.title')}</h1>
        {report.refreshing && (
          <button type="button" className="btn btn-pill" onClick={() => void cancelUsage().catch(onError)}>
            {t('common.cancel')}
          </button>
        )}
        <button type="button" className="btn btn-primary btn-pill" disabled={report.refreshing} onClick={() => refresh()}>
          {report.refreshing ? t('quota.refreshing') : t('quota.refreshAll')}
        </button>
      </header>
      <div className="usage-body">
        <p className="muted usage-lead">{t('quota.lead')}</p>
        {focus && !focused && <p className="muted">{t('quota.focusMissing', { id: focus })}</p>}
        {report.rows.length === 0 && <p className="muted">{t('quota.empty')}</p>}
        <div className="quota-grid">
          {report.rows.map((row) => (
            <AccountCard key={row.key} row={row} now={now} focused={row === focused} busy={busyKeys.has(row.key) || row.inFlight} onRefresh={() => refresh([row.key])} onEditAgent={onEditAgent} onProviders={onProviders} />
          ))}
        </div>
        <UsageSettingsPanel settings={report.settings} onSave={saveSettings} />
      </div>
    </div>
  )
}

function canRefresh(row: UsageRow): boolean {
  return row.capability !== 'unsupported' && row.state !== 'consent-required' && !(row.state === 'auth-missing' && row.binding.kind !== 'cli-login' && row.binding.kind !== 'claude-login-file')
}

function AccountCard({ row, now, focused, busy, onRefresh, onEditAgent, onProviders }: { row: UsageRow; now: number; focused: boolean; busy: boolean; onRefresh: () => void; onEditAgent: (id: string) => void; onProviders: () => void }) {
  const snap = row.snapshot
  const shared = row.providers.length + row.agents.length > 2 || row.providers.length > 1
  const source = snap ? (row.stale && row.state === 'stale' ? 'cached' : snap.source) : row.source
  return (
    <section id={`quota-${row.key}`} className={`quota-card${focused ? ' is-focused' : ''}`} data-state={row.state} data-capability={row.capability} data-stale={row.stale ? 'true' : 'false'}>
      <header className="quota-head">
        <div className="quota-title">
          <h2>
            {t(`quota.type.${row.type}` as MessageKey)}
            {row.region && <span className="quota-region"> · {t(`quota.region.${row.region}` as MessageKey)}</span>}
          </h2>
          <div className="quota-providers">{row.providers.map((p) => p.label).join(' · ')}</div>
        </div>
        <span className="quota-state" data-state={row.state}>
          {t(`quota.state.${row.state}` as MessageKey)}
        </span>
        {canRefresh(row) && (
          <button type="button" className="btn btn-pill" disabled={busy} onClick={onRefresh}>
            {busy ? t('quota.refreshing') : t('quota.refresh')}
          </button>
        )}
      </header>

      {/* The server sends a fixed reason id (never provider text); unknown ids show nothing beyond the state. */}
      {row.reason && isUsageReason(row.reason) && <p className="quota-detail muted">{t(`quota.reason.${row.reason}` as MessageKey, row.reasonVars ?? {})}</p>}
      {row.state === 'consent-required' && <p className="quota-detail">{t('quota.consentNeeded')}</p>}
      {row.stale && snap && <p className="quota-stale">{t('quota.stale')}</p>}

      <dl className="quota-meta">
        {source && (
          <>
            <dt>{t('quota.source')}</dt>
            <dd data-source={source}>{t(`quota.source.${source}` as MessageKey)}</dd>
          </>
        )}
        {row.endpoint && (
          <>
            <dt>{t('quota.endpoint')}</dt>
            <dd>
              <code>{row.endpoint}</code>
            </dd>
          </>
        )}
        <dt>{t('quota.binding')}</dt>
        <dd>{t(`quota.binding.${row.binding.kind}` as MessageKey, { provider: row.binding.providerId ?? '' })}</dd>
        {snap?.plan && (
          <>
            <dt>{t('quota.plan')}</dt>
            <dd>{snap.plan}</dd>
          </>
        )}
        {snap?.accountLabel && (
          <>
            <dt>{t('quota.account')}</dt>
            <dd>{snap.accountLabel}</dd>
          </>
        )}
      </dl>
      {snap && <p className="quota-detail muted">{t('quota.queried', { when: when(snap.fetchedAt) })}</p>}
      {row.lastAttemptAt !== undefined && (!snap || row.lastAttemptAt !== snap.fetchedAt) && <p className="quota-detail muted">{t('quota.lastAttempt', { when: when(row.lastAttemptAt) })}</p>}
      {row.nextAllowedAt !== undefined && row.nextAllowedAt > now && <p className="quota-detail muted">{t('quota.nextAllowed', { left: countdownText(row.nextAllowedAt - now) })}</p>}
      {snap?.available !== undefined && <p className="quota-detail">{snap.available ? t('quota.available') : t('quota.unavailable')}</p>}

      {snap && (snap.windows.length > 0 || snap.balances.length === 0) && (
        <div className="quota-windows">
          <h3>{t('quota.windows')}</h3>
          {snap.windows.length === 0 && !snap.credits && <p className="muted">{t('quota.noWindows')}</p>}
          {snap.windows.map((w) => (
            <WindowRow key={w.id} w={w} now={now} />
          ))}
        </div>
      )}
      {snap && snap.balances.length > 0 && <Balances balances={snap.balances} />}
      {snap?.credits && (
        <p className="quota-credits">
          {t('quota.credits')}: {snap.credits.unlimited ? t('quota.credits.unlimited') : !snap.credits.hasCredits ? t('quota.credits.none') : snap.credits.balance !== undefined ? t('quota.credits.balance', { n: snap.credits.balance }) : t('quota.balance.notReported')}
        </p>
      )}

      <div className="quota-who">
        {shared && <p className="quota-shared">{t('quota.shared')}</p>}
        <div className="quota-who-line">
          <span className="muted">{t('quota.providers')}:</span>
          {row.providers.map((p) => (
            <button key={p.id} type="button" className="quota-chip" onClick={onProviders} title={p.id}>
              {p.label} <code>{p.id}</code>
            </button>
          ))}
        </div>
        <div className="quota-who-line">
          <span className="muted">{t('quota.employees')}:</span>
          {row.agents.length === 0 && <span className="muted">{t('quota.noEmployees')}</span>}
          {row.agents.map((a) => (
            <button key={a.id} type="button" className="quota-chip" onClick={() => onEditAgent(a.id)}>
              {a.name} · <code>{a.model || t('common.default')}</code>
            </button>
          ))}
        </div>
      </div>

      {row.local && (
        <div className="quota-local" data-source="local-estimate">
          <h3>{t('quota.local')}</h3>
          <p className="muted">{t('quota.localLine', { messages: row.local.messages, in: formatTokens(row.local.inputTokens), out: formatTokens(row.local.outputTokens), cost: formatCost(row.local.costUsd) })}</p>
        </div>
      )}
    </section>
  )
}

function WindowRow({ w, now }: { w: UsageWindow; now: number }) {
  const pct = w.usedPercent
  return (
    <div className="quota-window" data-kind={w.kind}>
      <div className="quota-window-head">
        <span className="quota-window-name">{windowLabel(w)}</span>
        {w.scope && <span className="quota-window-scope">{t('quota.scope', { scope: w.scope })}</span>}
        <span className="quota-window-pct">{pct !== undefined ? t('quota.used', { pct: formatPercent(pct) }) : t('quota.usedUnknown')}</span>
      </div>
      {pct !== undefined && (
        <div className="quota-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-label={windowLabel(w)}>
          <span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} data-level={pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low'} />
        </div>
      )}
      <div className="quota-window-foot muted">
        {w.used !== undefined && w.limit !== undefined && <span>{t('quota.counts', { used: w.used, limit: w.limit })}</span>}
        {w.remaining !== undefined && <span>{t('quota.remaining', { n: w.remaining })}</span>}
        <span>{w.resetsAt !== undefined ? t('quota.resetsIn', { left: countdownText(w.resetsAt - now), when: when(w.resetsAt) }) : t('quota.resetUnknown')}</span>
        {(w.notes ?? []).map((n) => (
          <span key={n} className="quota-note">
            {t(`quota.note.${n}` as MessageKey)}
          </span>
        ))}
      </div>
    </div>
  )
}

function Balances({ balances }: { balances: UsageBalance[] }) {
  // One line per currency, as reported: amounts in different currencies are never added up.
  const cell = (v: string | undefined) => (v !== undefined ? v : <span className="muted">{t('quota.balance.notReported')}</span>)
  return (
    <div className="quota-balances">
      <h3>{t('quota.balances')}</h3>
      <table className="usage-table">
        <thead>
          <tr>
            <th />
            <th>{t('quota.balance.total')}</th>
            <th>{t('quota.balance.paid')}</th>
            <th>{t('quota.balance.granted')}</th>
          </tr>
        </thead>
        <tbody>
          {balances.map((b) => (
            <tr key={b.currency}>
              <th scope="row">
                {b.currency}
                {b.currencySource === 'region-documented' && (
                  <span className="quota-note" title={t('quota.currencyDocumented', { currency: b.currency })}>
                    {' '}
                    *
                  </span>
                )}
              </th>
              <td>{cell(b.total)}</td>
              <td>{cell(b.paid)}</td>
              <td>{cell(b.granted)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {balances.some((b) => b.currencySource === 'region-documented') && <p className="muted quota-detail">* {t('quota.currencyDocumented', { currency: balances.find((b) => b.currencySource === 'region-documented')?.currency ?? '' })}</p>}
    </div>
  )
}

function UsageSettingsPanel({ settings, onSave }: { settings: UsageSettings; onSave: (patch: Partial<UsageSettings>) => void }) {
  const [low, setLow] = useState(String(settings.lowUsedPercent))
  useEffect(() => setLow(String(settings.lowUsedPercent)), [settings.lowUsedPercent])
  return (
    <section className="form-section quota-settings">
      <h3>{t('quota.settings')}</h3>
      <label className="check">
        <input type="checkbox" checked={settings.autoRefresh} onChange={(e) => onSave({ autoRefresh: e.target.checked })} />
        <span>{t('quota.autoRefresh')}</span>
      </label>
      <label className="field">
        <span>{t('quota.interval')}</span>
        <select value={settings.intervalSec} disabled={!settings.autoRefresh} onChange={(e) => onSave({ intervalSec: Number(e.target.value) })}>
          {(INTERVALS.includes(settings.intervalSec) ? INTERVALS : [...INTERVALS, settings.intervalSec].sort((a, b) => a - b)).map((s) => (
            <option key={s} value={s}>
              {t('quota.minutes', { n: Math.round((s / 60) * 10) / 10 })}
            </option>
          ))}
        </select>
        <small className="muted">{t('quota.intervalHint')}</small>
      </label>
      <label className="field">
        <span>{t('quota.lowLine')}</span>
        <input type="number" min={1} max={100} value={low} onChange={(e) => setLow(e.target.value)} onBlur={() => Number.isFinite(Number(low)) && onSave({ lowUsedPercent: Number(low) })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.petSummary} onChange={(e) => onSave({ petSummary: e.target.checked })} />
        <span>{t('quota.petSummary')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.petNotices} onChange={(e) => onSave({ petNotices: e.target.checked })} />
        <span>{t('quota.petNotices')}</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.claudeLoginFile} onChange={(e) => onSave({ claudeLoginFile: e.target.checked })} />
        <span>{t('quota.claudeConsent')}</span>
      </label>
      <p className="muted quota-detail">{t('quota.claudeConsentHint')}</p>
    </section>
  )
}
