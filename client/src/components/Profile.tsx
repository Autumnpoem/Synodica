import { useEffect, useState } from 'react'
import { EFFORTS, MODELS, PERMISSION_MODES, PROVIDER_CAPABILITIES, PROVIDER_KINDS, SHAPES, TOOLS } from '../../../shared/catalog'
import type { MessageKey } from '../../../shared/i18n'
import { effortLabel, providerLabel } from '../../../shared/catalog-i18n'
import type { Agent, ApprovalPolicy, AvatarShape, Effort, PermissionMode, ProviderModelCatalog, TaskTier, Team, UsageTotals, WorkflowRole } from '../../../shared/types'

/** Workflow roles; labels and hints are `role.<id>` / `role.<id>Hint` in the UI language. */
const WORKFLOW_ROLES: WorkflowRole[] = ['lead', 'critic', 'implementer', 'reviewer', 'tester', 'writer']
import { createAgent, deleteAgent, duplicateAgent, getMemory, providerModels, putMemory, updateAgent } from '../api'
import { formatCost, formatTokens } from '../format'
import { getLocale, t } from '../i18n'
import { personFor } from '../people'
import { Avatar } from './Avatar'
import { AvatarEditor } from './AvatarEditor'
import { ModelPicker } from './ModelPicker'
import { defaultPersonality, prepareAgentForSave, profileIssueText, profileSaveFailure } from '../agentProfile'
import { modelForProviderSwitch } from '../modelPicker'

interface ProfileProps {
  team: Team
  /** Existing employee id, or null to create a new one. */
  agentId: string | null
  usage?: UsageTotals
  onClose: () => void
  onSaved: (id: string) => void
}

const PALETTE = ['#2f7ef5', '#ff6a1a', '#1e90ff', '#e6396b', '#e63946', '#b5733c', '#8b5cf6', '#c98a4b', '#22c55e', '#7c4dff', '#14b8a6', '#f59e0b', '#ec4899', '#64748b']

function blank(team: Team): Agent {
  const provider = team.providers.claude ? 'claude' : Object.keys(team.providers)[0] ?? 'claude'
  const providerDef = team.providers[provider]
  return {
    id: '',
    name: '',
    role: '',
    color: PALETTE[team.agents.length % PALETTE.length] ?? '#2f7ef5',
    shape: 'blob',
    provider,
    model: providerDef?.kind === 'openai' ? providerDef.models?.[0] ?? '' : '',
    effort: 'medium',
    personality: '',
    tools: [],
    permissionMode: 'dontAsk',
    mcpServers: [],
    inheritClaudeSettings: false,
    autoApproveTools: false,
    muted: false,
    approvals: 'auto',
  }
}

export function Profile({ team, agentId, usage, onClose, onSaved }: ProfileProps) {
  const existing = agentId ? team.agents.find((a) => a.id === agentId) : undefined
  const [draft, setDraft] = useState<Agent>(existing ?? blank(team))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [providerCatalog, setProviderCatalog] = useState<ProviderModelCatalog | null>(null)
  const [pendingProvider, setPendingProvider] = useState<string | null>(null)
  const [modelNeedsInitialChoice, setModelNeedsInitialChoice] = useState(!existing)

  useEffect(() => {
    setDraft(existing ?? blank(team))
    setError(null)
    setConfirmDelete(false)
    setProviderCatalog(null)
    setPendingProvider(null)
    setModelNeedsInitialChoice(!existing)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const set = <K extends keyof Agent>(key: K, value: Agent[K]) => setDraft((d) => ({ ...d, [key]: value }))
  const toggleList = (key: 'tools' | 'mcpServers', item: string) =>
    setDraft((d) => ({ ...d, [key]: d[key].includes(item) ? d[key].filter((x) => x !== item) : [...d[key], item] }))

  const provider = (team.providers[draft.provider] ?? team.providers.claude)!
  const kind = provider?.kind ?? 'claude'
  const availableTools = TOOLS.filter((t) => t.kinds.includes(kind))

  const preview = personFor({ ...team, agents: [...team.agents.filter((a) => a.id !== draft.id), { ...draft, id: draft.id || 'new' }] }, draft.id || 'new')
  const dirty = JSON.stringify(draft) !== JSON.stringify(existing ?? blank(team))

  const changeProvider = async (id: string) => {
    const next = team.providers[id]
    if (!next) return
    setPendingProvider(id)
    setModelNeedsInitialChoice(true)
    let catalog: ProviderModelCatalog | null = null
    try { catalog = await providerModels(id) } catch { /* ModelPicker will show the localized retry state. */ }
    setProviderCatalog(catalog)
    setDraft((d) => ({ ...d, provider: id, model: modelForProviderSwitch(next, d.model, catalog), tools: d.tools.filter((t) => TOOLS.find((x) => x.id === t)?.kinds.includes(next.kind)) }))
    setPendingProvider(null)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const prepared = prepareAgentForSave(draft, team.agents, existing?.id ?? null, getLocale(), crypto.randomUUID())
      if (prepared.issue) {
        setError(profileIssueText(prepared.issue, getLocale()))
        return
      }
      const body = prepared.agent
      if (existing) {
        const { id: _id, ...patch } = body
        await updateAgent(existing.id, patch)
        onSaved(existing.id)
      } else {
        await createAgent(body)
        onSaved(body.id)
      }
    } catch {
      setError(profileSaveFailure(getLocale()))
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async () => {
    if (!existing) return
    setSaving(true)
    try {
      const { agent } = await duplicateAgent(existing.id)
      onSaved(agent.id)
    } catch {
      setError(profileSaveFailure(getLocale()))
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!existing) return
    setSaving(true)
    try {
      await deleteAgent(existing.id)
      onClose()
    } catch {
      setError(profileSaveFailure(getLocale()))
      setSaving(false)
    }
  }

  return (
    <aside className="profile">
      <header className="profile-header">
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('common.close')}>
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12.5 4.5L7 10l5.5 5.5" />
          </svg>
        </button>
        <h2>{existing ? t('menu.editProfile') : t('profile.new')}</h2>
        <button type="button" className="btn btn-primary" disabled={!dirty || saving} onClick={() => void save()}>
          {saving ? t('common.saving') : t('common.save')}
        </button>
      </header>
      <div className="profile-body">
        <div className="profile-hero">
          <Avatar person={preview} size={48} />
          <div className="profile-hero-name">
            {draft.name || 'NAME'} | {draft.role || 'ROLE'}
          </div>
          {usage && usage.messages > 0 && (
            <div className="profile-hero-meta">
              {t('profile.usage', { messages: usage.messages, in: formatTokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens), out: formatTokens(usage.outputTokens), cost: formatCost(usage.costUsd) })}
            </div>
          )}
          {/* The account quota / balance this employee's provider draws from (shared deep link). */}
          {agentId && (
            <a className="profile-hero-meta quota-link" href={`#/usage/${agentId}`} onClick={onClose}>
              {t('nav.usage')} →
            </a>
          )}
        </div>

        <p className="profile-reuse-hint">{t('roles.savedHint')}</p>
        {error && <div className="form-error">{error}</div>}

        <details className="form-section profile-group" open={!existing}>
          <summary>{t('profile.identity')}</summary>
          <div className="profile-group-content">
          <label className="field">
            <span>{t('profile.name')} <b aria-hidden="true">*</b></span>
            <input required aria-required="true" autoFocus={!existing} value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="OMAR" />
          </label>
          <label className="field">
            <span>{t('profile.role')} <b aria-hidden="true">*</b></span>
            <input required aria-required="true" value={draft.role} onChange={(e) => set('role', e.target.value)} placeholder="FULL STACK DEV" />
          </label>
          <label className="field">
            <span>{t('profile.scope')}</span>
            <input value={draft.scope ?? ''} onChange={(e) => set('scope', e.target.value || undefined)} placeholder={t('profile.scopePh')} />
            <small>{t('profile.scopeHint')}</small>
          </label>
          <label className="field">
            <span>{t('profile.label')}</span>
            <input value={draft.department ?? ''} onChange={(e) => set('department', e.target.value || undefined)} placeholder={t('profile.labelPh')} />
          </label>
          <label className="field">
            <span>{t('profile.personality')}</span>
            <textarea rows={7} value={draft.personality} onChange={(e) => set('personality', e.target.value)} placeholder={t('profile.personalityPh')} />
            {!draft.personality.trim() && <small>{getLocale() === 'zh-CN' ? '\u672a\u586b\u5199\u81ea\u5b9a\u4e49\u4eba\u8bbe\uff1b\u4fdd\u5b58\u65f6\u4f1a\u4f7f\u7528\u4ee5\u4e0b\u9ed8\u8ba4\u4eba\u8bbe\uff1a' : 'No custom persona entered. This default will be saved:'}<br />{defaultPersonality(draft.name, draft.role, draft.scope, getLocale())}</small>}
          </label>
          <label className="toggle-row">
            <div>
              <div className="toggle-title">{t('nav.mutedHint')}</div>
              <div className="toggle-hint">{t('profile.mutedHint')}</div>
            </div>
            <input type="checkbox" className="toggle" checked={draft.muted} onChange={(e) => set('muted', e.target.checked)} />
          </label>
          </div>
        </details>

        <section className="form-section profile-model">
          <h3>{t('profile.brain')}</h3>
          <details className="notes" style={{ marginBottom: 12 }}><summary>{getLocale() === 'zh-CN' ? '这个角色可以使用哪些能力？' : 'What can this role use?'}</summary>
            <p>{getLocale() === 'zh-CN' ? '当前引擎：' : 'Engine: '}{({ claude: 'Claude Agent SDK', codex: 'Codex CLI', gemini: 'Gemini CLI', openai: 'Chat API' })[kind]}</p>
            <p>{getLocale() === 'zh-CN' ? '文件和文档操作由下方勾选的工具决定。整理文件通常需要读取和写入权限；仅填写角色提示词不会自动开启工具。' : 'File and document work depends on the tools selected below. Organizing files usually needs read and write access; a persona alone does not enable tools.'}</p>
            <p>{getLocale() === 'zh-CN' ? '电脑控制尚未接入；Codex Desktop 的电脑控制插件和应用权限不会自动授予此连接。' : 'Computer control is not connected. Codex Desktop computer-use plugins and app permissions are not automatically available to this connection.'}</p>
          </details>
          <label className="field">
            <span>{t('profile.provider')}</span>
            <select value={pendingProvider ?? draft.provider} disabled={pendingProvider !== null} onChange={(e) => void changeProvider(e.target.value)}>
              {Object.entries(team.providers).map(([id, p]) => (
                <option key={id} value={id}>
                  {providerLabel(getLocale(), p)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{t('profile.model')} <b aria-hidden="true">*</b></span>
            <ModelPicker id="profile-model" providerId={draft.provider} provider={provider} model={draft.model} required initializeEmpty={!existing || modelNeedsInitialChoice} initialCatalog={providerCatalog} onChange={(model) => {
              set('model', model)
              if (model) setModelNeedsInitialChoice(false)
            }} />
          </label>
          <label className="field">
            <span>{t('profile.effort')}</span>
            <div className="segmented">
              {EFFORTS.map((e) => (
                <button key={e.id} type="button" className={draft.effort === e.id ? 'is-active' : ''} onClick={() => set('effort', e.id as Effort)}>
                  {effortLabel(getLocale(), e)}
                </button>
              ))}
            </div>
            <small>{t('profile.effortHint')}</small>
          </label>
          <details className="profile-help">
            <summary>{t('profile.connectionDetails')}</summary>
            <p>{PROVIDER_KINDS.find((k) => k.id === kind)?.hint}</p>
            <p>{MODELS.find((m) => m.id === draft.model)?.hint ?? (kind === 'claude' ? t('profile.modelHintClaude') : kind === 'openai' ? t('profile.modelHintApi') : t('profile.modelHintCli'))}</p>
            <p>{PROVIDER_CAPABILITIES[kind].notes}</p>
          </details>
        </section>

        <details className="form-section profile-group">
          <summary>{t('profile.look')}</summary>
          <div className="profile-group-content">
          <div className="field">
            <span>{t('profile.look')}</span>
            <div className="swatches">
              {PALETTE.map((c) => (
                <button key={c} type="button" className={`swatch${draft.color === c ? ' is-active' : ''}`} style={{ background: c }} onClick={() => set('color', c)} aria-label={c} />
              ))}
            </div>
            <div className="shapes">
              {SHAPES.map((s) => (
                <button key={s} type="button" className={`shape${draft.shape === s ? ' is-active' : ''}`} onClick={() => set('shape', s as AvatarShape)} aria-label={s}>
                  {/* The color-and-shape face (the fallback), even when a portrait is uploaded. */}
                  <Avatar person={{ ...preview, avatar: undefined, agent: { ...draft, shape: s as AvatarShape, avatar: undefined } }} size={30} />
                </button>
              ))}
            </div>
          </div>
          {/* Uploads need the saved employee; a new one gets its avatar after the first save. */}
          {existing ? <AvatarEditor target={existing.id} person={personFor(team, existing.id)} /> : <small className="hint">{t('profile.avatarAfterSave')}</small>}
          </div>
        </details>

        <details className="form-section profile-group">
          <summary>{t('profile.workflow')}</summary><div className="profile-group-content">
          <div className="checks">
            {WORKFLOW_ROLES.map((r) => (
              <label key={r} className="check" title={t(`role.${r}Hint` as MessageKey)}>
                <input
                  type="checkbox"
                  checked={(draft.workflowRoles ?? []).includes(r)}
                  onChange={() => {
                    const cur = draft.workflowRoles ?? []
                    const next = cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]
                    // An empty list (not undefined) so clearing every role is saved.
                    set('workflowRoles', next)
                  }}
                />
                <span>{t(`role.${r}` as MessageKey)}</span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>{t('profile.tier')}</span>
            <select value={draft.tier ?? 'standard'} onChange={(e) => set('tier', e.target.value as TaskTier)}>
              <option value="routine">{t('profile.tierRoutine')}</option>
              <option value="standard">{t('profile.tierStandard')}</option>
              <option value="critical">{t('profile.tierCritical')}</option>
            </select>
            <small>{t('profile.tierHint')}</small>
          </label>
        </div></details>

        <details className="form-section profile-group">
          <summary>{t('profile.tools')}</summary><div className="profile-group-content">
          <div className="checks">
            {availableTools.map((t) => (
              <label key={t.id} className="check" title={t.hint}>
                <input type="checkbox" checked={draft.tools.includes(t.id)} onChange={() => toggleList('tools', t.id)} />
                <span>{t.label}</span>
              </label>
            ))}
          </div>
          {kind === 'openai' && <p className="hint">{t('profile.toolsApi')}</p>}
          {(kind === 'codex' || kind === 'gemini') && <p className="hint">{t('profile.toolsCli')}</p>}
          <label className="field">
            <span>{t('profile.permissions')}</span>
            <select value={draft.permissionMode} onChange={(e) => set('permissionMode', e.target.value as PermissionMode)}>
              {PERMISSION_MODES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <small>{PERMISSION_MODES.find((p) => p.id === draft.permissionMode)?.hint}</small>
          </label>
          <label className="field">
            <span>{t('profile.approvals')}</span>
            <select value={draft.approvals} onChange={(e) => set('approvals', e.target.value as ApprovalPolicy)}>
              <option value="auto">{t('profile.approvalsAuto')}</option>
              <option value="ask-dangerous">{t('profile.approvalsDangerous')}</option>
              <option value="ask-all">{t('profile.approvalsAll')}</option>
            </select>
            <small>{t('profile.approvalsHint')}</small>
          </label>
          <label className="field">
            <span>{t('profile.cwd')}</span>
            <input value={draft.cwd ?? ''} onChange={(e) => set('cwd', e.target.value || undefined)} placeholder={team.workspace} />
          </label>
          <label className="toggle-row">
            <div>
              <div className="toggle-title">{t('profile.autoApprove')}</div>
              <div className="toggle-hint">{t('profile.autoApproveHint')}</div>
            </div>
            <input type="checkbox" className="toggle" checked={draft.autoApproveTools} onChange={(e) => set('autoApproveTools', e.target.checked)} />
          </label>
        </div></details>

        {kind === 'claude' && (
          <details className="form-section profile-group">
            <summary>{t('profile.mcp')}</summary><div className="profile-group-content">
            {Object.keys(team.mcpServers).length === 0 ? (
              <p className="hint">{t('profile.mcpNone')}</p>
            ) : (
              <div className="checks">
                {Object.keys(team.mcpServers).map((name) => (
                  <label key={name} className="check">
                    <input type="checkbox" checked={draft.mcpServers.includes(name)} onChange={() => toggleList('mcpServers', name)} />
                    <span>{name}</span>
                  </label>
                ))}
              </div>
            )}
            <label className="toggle-row">
              <div>
                <div className="toggle-title">{t('profile.inherit')}</div>
                <div className="toggle-hint">{t('profile.inheritHint')}</div>
              </div>
              <input type="checkbox" className="toggle" checked={draft.inheritClaudeSettings} onChange={(e) => set('inheritClaudeSettings', e.target.checked)} />
            </label>
          </div></details>
        )}

        {existing && <MemorySection agentId={existing.id} />}

        {existing && (
          <section className="form-section danger">
            <div className="confirm">
              <button type="button" className="btn" onClick={() => void duplicate()} disabled={saving}>
                {t('profile.duplicate')}
              </button>
              {confirmDelete ? (
                <>
                  <span>{t('profile.removeAsk', { name: existing.name })}</span>
                  <button type="button" className="btn btn-danger" onClick={() => void remove()} disabled={saving}>
                    {t('common.delete')}
                  </button>
                  <button type="button" className="btn" onClick={() => setConfirmDelete(false)}>
                    {t('common.cancel')}
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-danger-ghost" onClick={() => setConfirmDelete(true)}>
                  {t('menu.deleteEmployee')}
                </button>
              )}
            </div>
          </section>
        )}
      </div>
    </aside>
  )
}

function MemorySection({ agentId }: { agentId: string }) {
  const [notes, setNotes] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setNotes(null)
    getMemory(agentId)
      .then((n) => {
        setNotes(n)
        setSaved(n)
      })
      .catch(() => {
        setNotes('')
        setSaved('')
      })
  }, [agentId])
  if (notes === null) return null
  const save = async (value: string) => {
    setBusy(true)
    try {
      await putMemory(agentId, value)
      setSaved(value)
      setNotes(value)
    } finally {
      setBusy(false)
    }
  }
  return (
    <details className="form-section profile-group">
      <summary>{t('profile.memory')}</summary><div className="profile-group-content">
      <p className="hint">{t('profile.memoryHint')}</p>
      <textarea rows={8} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t('profile.memoryEmpty')} />
      <div className="confirm">
        <button type="button" className="btn btn-primary" disabled={busy || notes === saved} onClick={() => void save(notes)}>
          {t('profile.saveNotes')}
        </button>
        <button type="button" className="btn btn-danger-ghost" disabled={busy || !saved} onClick={() => void save('')}>
          {t('profile.clearMemory')}
        </button>
      </div>
    </div></details>
  )
}
