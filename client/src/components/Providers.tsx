import { claudeEndpointOrigin } from '../../../shared/provider-origin'
import { useEffect, useState } from 'react'
import { API_PRESETS, providerEndpointKey, PROVIDER_KINDS } from '../../../shared/catalog'
import { apiPresetLabel, capabilityLine, providerKindHint, providerLabel } from '../../../shared/catalog-i18n'
import type { ProviderDef, ProviderStatus, Team } from '../../../shared/types'
import { deleteProvider, providerStatuses, putProvider } from '../api'
import { t, useLocale } from '../i18n'
import { connectionText } from '../providerConnection'

interface ProvidersProps {
  team: Team
}

const BUILT_IN = ['claude', 'codex', 'gemini']

export function Providers({ team }: ProvidersProps) {
  const locale = useLocale()
  const words = connectionText(locale)
  const [statuses, setStatuses] = useState<ProviderStatus[]>([])
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)

  const refresh = async (force = false) => {
    setChecking(true)
    try {
      setStatuses(await providerStatuses(force))
    } catch (err) {
      setError(t('providers.requestFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    void refresh()
  }, [team.providers])

  const remove = async (id: string) => {
    setError(null)
    try {
      await deleteProvider(id)
    } catch (err) {
      setError(t('providers.requestFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const usersOf = (id: string) => team.agents.filter((a) => a.provider === id).map((a) => a.name)
  const statusOf = (id: string) => statuses.find((s) => s.id === id)

  return (
    <>
      <div className="marketplace-head">
        <h1>{t('providers.title')}</h1>
        <div className="row-control">
          <button type="button" className="btn" onClick={() => void refresh(true)} disabled={checking}>
            {checking ? t('providers.checking') : t('providers.recheck')}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
            {words.add}
          </button>
        </div>
      </div>
      <p className="lead">{t('providers.lead')}</p>
      {error && <div className="form-error">{error}</div>}

      <details className="card provider-guide">
        <summary style={{ padding: '16px 20px', fontWeight: 700 }}>{words.title}</summary>
        <div style={{ padding: '0 20px 20px' }}>
          <h3>{words.codexTitle}</h3><p>{words.codex}</p>
          <h3>{words.claudeTitle}</h3><p>{words.claude}</p>
          <h3>{words.googleTitle}</h3><p>{words.google}</p>
          <h3>{words.kimiTitle}</h3><p>{words.kimi}</p>
          <a href="https://www.kimi.com/code/console" target="_blank" rel="noreferrer">{words.codeConsole}</a>
        </div>
      </details>
      <h4>{t('providers.subscriptions')}</h4>
      <div className="card">
        {BUILT_IN.map((id) => {
          const p = team.providers[id]
          if (!p) return null
          const st = statusOf(id)
          const kind = PROVIDER_KINDS.find((k) => k.id === p.kind)
          const users = usersOf(id)
          return (
            <div key={id} className="row">
              <span className={`status-dot${st ? (st.ok ? ' ok' : ' bad') : ''}`} />
              <div className="row-text">
                <div className="row-title">
                  {providerLabel(locale, p)}
                  {p.apiKey && <span className="badge">{t('providers.apiKey')}</span>}
                </div>
                <div className="row-hint">{st ? (st.ok ? (st.kind === 'claude' || st.kind === 'gemini' ? words.engineReady : t('providers.statusOk')) : words.unavailable) : kind ? providerKindHint(locale, kind) : ''}</div>
                {st && !st.ok && <details className="row-hint"><summary>{words.technical}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{st.detail}</pre></details>}
                <div className="row-hint">{capabilityLine(locale, p.kind)}</div>
                <div className="row-hint">{users.length ? t('providers.usedBy', { names: users.join(', ') }) : t('providers.unused')}</div>
              </div>
              <div className="row-control">
                <button type="button" className="btn" onClick={() => setEditing(id)}>
                  {words.configure}
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <h4>{t('providers.api')}</h4>
      <div className="card">
        {Object.entries(team.providers).filter(([id]) => !BUILT_IN.includes(id)).length === 0 && (
          <div className="row">
            <div className="row-text">
              <div className="row-title">{t('providers.none')}</div>
              <div className="row-hint">{t('providers.noneHint')}</div>
            </div>
          </div>
        )}
        {Object.entries(team.providers)
          .filter(([id]) => !BUILT_IN.includes(id))
          .map(([id, p]) => {
            const st = statusOf(id)
            const users = usersOf(id)
            return (
              <div key={id} className="row">
                <span className={`status-dot${st ? (st.ok ? ' ok' : ' bad') : ''}`} />
                <div className="row-text">
                  <div className="row-title">
                    {providerLabel(locale, p)} <span className="muted small">{id}</span>
                  </div>
                  <div className="row-hint">
                    {p.baseUrl} · {st ? (st.ok ? (st.kind === 'claude' || st.kind === 'gemini' ? words.engineReady : t('providers.statusOk')) : words.unavailable) : t('providers.checkingInline')}
                    {!p.apiKey && t('providers.noKey')}
                  </div>
                  {st && !st.ok && <details className="row-hint"><summary>{words.technical}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{st.detail}</pre></details>}
                <div className="row-hint">{capabilityLine(locale, p.kind)}</div>
                  <div className="row-hint">{users.length ? t('providers.usedBy', { names: users.join(', ') }) : t('providers.unused')}</div>
                </div>
                <div className="row-control">
                  <button type="button" className="btn" onClick={() => setEditing(id)}>
                    {!p.apiKey ? t('providers.configure') : t('common.edit')}
                  </button>
                  <button type="button" className="btn btn-danger-ghost" onClick={() => void remove(id)} disabled={users.length > 0} title={users.length > 0 ? t('providers.removeBlocked') : ''}>
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )
          })}
      </div>

      {adding && <ProviderSheet team={team} id={null} onDone={() => setAdding(false)} />}
      {editing && <ProviderSheet team={team} id={editing} onDone={() => setEditing(null)} />}
    </>
  )
}

function ProviderSheet({ team, id, onDone }: { team: Team; id: string | null; onDone: () => void }) {
  const locale = useLocale()
  const words = connectionText(locale)
  const existing = id ? team.providers[id] : undefined
  const builtIn = id !== null && BUILT_IN.includes(id)
  const [preset, setPreset] = useState<string>('')
  const [kind, setKind] = useState(existing?.kind ?? 'openai')
  const [authMode, setAuthMode] = useState<'api-key' | 'auth-token'>(existing?.authMode ?? 'api-key')
  const [pid, setPid] = useState(id ?? '')
  const [label, setLabel] = useState(existing?.label ?? '')
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(existing?.apiKey ?? '')
  const [models, setModels] = useState((existing?.models ?? []).join(', '))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const applyPreset = (presetId: string) => {
    setPreset(presetId)
    if (presetId === 'claude-gateway') {
      setKind('claude'); setPid('claude-gateway'); setLabel(words.gateway); setBaseUrl(''); setModels(''); setAuthMode('auth-token'); setError(null)
      return
    }
    if (presetId === 'google-ai-studio') {
      setKind('openai'); setPid('google-ai-studio'); setLabel(words.googleApi); setBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai'); setModels(''); setError(null)
      return
    }
    setKind('openai')
    const p = API_PRESETS.find((x) => x.id === presetId)
    if (!p) return
    const endpoint = providerEndpointKey(p.baseUrl)
    const duplicate = Object.entries(team.providers).find(([providerId, provider]) => providerId === p.id || providerEndpointKey(provider.baseUrl) === endpoint)
    if (duplicate) {
      setError(t('providers.alreadyConfigured', { label: duplicate[1].label }))
      return
    }
    setError(null)
    setPid(p.id)
    setLabel(apiPresetLabel(locale, p))
    setBaseUrl(p.baseUrl)
    setModels(p.models.join(', '))
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const def: Partial<ProviderDef> = builtIn
        ? { apiKey: apiKey.trim() || undefined, label: label.trim() || existing?.label, ...(kind === 'claude' ? { baseUrl: baseUrl.trim(), authMode } : {}) }
        : { kind, ...(kind === 'claude' ? { authMode } : {}), label: label.trim() || pid, baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, models: models.split(',').map((m) => m.trim()).filter(Boolean) }
      if (!builtIn && !/^[a-z0-9_-]+$/.test(pid)) throw new Error(t('providers.idInvalid'))
      if (!builtIn && !existing) {
        const endpoint = providerEndpointKey(baseUrl)
        const duplicate = Object.entries(team.providers).find(([providerId, provider]) => providerId === pid || providerEndpointKey(provider.baseUrl) === endpoint)
        if (duplicate) throw new Error(t('providers.alreadyConfigured', { label: duplicate[1].label }))
      }
      if (kind === 'claude' && existing && claudeEndpointOrigin(baseUrl) !== claudeEndpointOrigin(existing.baseUrl) && (!apiKey.trim() || apiKey === '••••')) throw new Error(words.newCredential)
      await putProvider(pid, def)
      onDone()
    } catch (err) {
      setError(t('providers.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
      setBusy(false)
    }
  }

  const clearKey = async () => {
    setBusy(true)
    try {
      await putProvider(pid, { apiKey: '' })
      onDone()
    } catch (err) {
      setError(t('providers.saveFailed', { error: err instanceof Error ? err.message : String(err) }))
      setBusy(false)
    }
  }

  const configuredPreset = API_PRESETS.find((p) => p.id === preset) ?? API_PRESETS.find((p) => p.baseUrl === existing?.baseUrl)
  const keyHint = configuredPreset?.keyHint

  return (
    <div className="modal-backdrop nested" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet" role="dialog">
        <h2>{builtIn ? t('providers.keyTitle', { label: existing?.label ?? '' }) : existing ? t('providers.editTitle', { label: providerLabel(locale, existing) }) : t('providers.addTitle')}</h2>
        {error && <div className="form-error">{error}</div>}
        {builtIn ? (
          <>
            <p className="hint">
              {id === 'claude' && t('providers.keyHint.claude')}
              {id === 'codex' && t('providers.keyHint.codex')}
              {id === 'gemini' && t('providers.keyHint.gemini')}
            </p>
            <label className="field">
              <span>{t('providers.label')}</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('providers.apiKey')}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={t('providers.keyPh')} />
              {apiKey === '••••' && <small>{t('providers.keyStored')}</small>}
            </label>
          </>
        ) : (
          <>
            {!existing && (
              <label className="field">
                <span>{t('providers.preset')}</span>
                <select value={preset} onChange={(e) => applyPreset(e.target.value)}>
                  <option value="">{t('providers.custom')}</option>
                  <option value="claude-gateway">{words.gateway}</option>
                  <option value="google-ai-studio">{words.googleApi}</option>
                  {API_PRESETS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {apiPresetLabel(locale, p)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!existing && <label className="field"><span>{words.protocol}</span><select value={kind} onChange={(e) => setKind(e.target.value as 'claude' | 'openai')}><option value="openai">{words.openai}</option><option value="claude">{words.anthropic}</option></select></label>}
            {kind === 'claude' && <p className="hint">{words.gatewayHint}</p>}
            {configuredPreset?.id.startsWith('kimi-code-') && <p className="hint">{t('providers.regionHint')}</p>}
            <label className="field">
              <span>{t('providers.id')}</span>
              <input value={pid} onChange={(e) => setPid(e.target.value)} placeholder="kimi" disabled={existing !== undefined} />
            </label>
            <label className="field">
              <span>{t('providers.label')}</span>
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('providers.labelPh')} />
            </label>
            <label className="field">
              <span>{kind === 'claude' ? words.rootUrl : t('providers.baseUrl')}</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.moonshot.ai/v1" />
              <small>{kind === 'claude' ? words.rootHint : t('providers.baseUrlHint')}</small>
            </label>
            <label className="field">
              <span>{t('providers.apiKey')}</span>
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={keyHint ?? 'sk-…'} />
              {keyHint && <small>{t('providers.getKey', { where: keyHint })}</small>}
            </label>
            <label className="field">
              <span>{t('providers.models')}</span>
              <input value={models} onChange={(e) => setModels(e.target.value)} placeholder={t('providers.modelsPh')} />
            </label>
          </>
        )}
        {kind === 'claude' && <>
          {builtIn && <label className="field"><span>{words.rootUrl}</span><input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://api.anthropic.com" /><small>{words.rootHint}</small></label>}
          <label className="field"><span>{words.auth}</span><select value={authMode} onChange={(e) => setAuthMode(e.target.value as 'api-key' | 'auth-token')}><option value="api-key">{words.apiKey}</option><option value="auth-token">{words.bearer}</option></select></label>
        </>}
        <div className="actions">
          {builtIn && existing?.apiKey && (
            <button type="button" className="btn btn-danger-ghost" onClick={() => void clearKey()} disabled={busy}>
              {t('providers.removeKey')}
            </button>
          )}
          <button type="button" className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || (!builtIn && (!pid.trim() || !baseUrl.trim())) || (kind === 'claude' && Boolean(baseUrl.trim()) && !apiKey.trim())} onClick={() => void save()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
