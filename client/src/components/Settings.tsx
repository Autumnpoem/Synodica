import { useState } from 'react'
import { RATE_LIMIT_LABELS } from '../../../shared/catalog'
import type { AccountStatus, AutoReviewRule, Conversation, HelperModel, McpServerDef, ProviderModelCatalog, Routine, Team, TeamSettings, UsageSummary, UsageTotals } from '../../../shared/types'
import { deleteMcpServer, providerModels, putMcpServer, putSettings, refreshAccount } from '../api'
import { formatCost, formatRelative, formatTokens, modelLabel } from '../format'
import { MARKETPLACE, type MarketplaceItem } from '../marketplace'
import { conversationTitle, personFor } from '../people'
import { CHINESE_REPLY_LANGUAGE, type MessageKey } from '../../../shared/i18n'
import { catalogText, effortLabel, providerLabel, rateLimitLabel } from '../../../shared/catalog-i18n'
import { getLocale, t, useLocale } from '../i18n'
import { Avatar } from './Avatar'
import { AvatarEditor } from './AvatarEditor'
import { OfficeConnectionPanel } from '../QuotaApp'
import { LocaleSwitch } from './LocaleSwitch'
import { Providers } from './Providers'
import { Routines } from './Routines'
import { Skills } from './Skills'
import { ModelPicker } from './ModelPicker'
import { modelForProviderSwitch } from '../modelPicker'
import { exportAgentUrl, importAgent } from '../api'
import { AppearancePicker } from './AppearancePicker'

export type SettingsSection = 'general' | 'team' | 'providers' | 'marketplace' | 'routines' | 'skills' | 'usage' | 'account'

interface SettingsProps {
  team: Team
  routines: Routine[]
  conversations: Conversation[]
  usage: UsageSummary
  account: AccountStatus
  section: SettingsSection
  onSection: (s: SettingsSection) => void
  onClose: () => void
  onEditAgent: (id: string | null) => void
  onAddTeam: () => void
}

const NAV: { id: SettingsSection; icon: string }[] = [
  { id: 'general', icon: '⚙️' },
  { id: 'team', icon: '👥' },
  { id: 'providers', icon: '🔌' },
  { id: 'marketplace', icon: '🧩' },
  { id: 'routines', icon: '⏰' },
  { id: 'skills', icon: '🎯' },
  { id: 'usage', icon: '📊' },
  { id: 'account', icon: '🔑' },
]

export function Settings(props: SettingsProps) {
  const { section, onSection, onClose } = props
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal settings" role="dialog" aria-label={t('nav.settings')}>
        <nav className="settings-nav">
          {NAV.map((n) => (
            <button key={n.id} type="button" className={section === n.id ? 'is-active' : ''} onClick={() => onSection(n.id)}>
              <span className="settings-nav-icon">{n.icon}</span>
              {t(`settings.nav.${n.id}` as MessageKey)}
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <button type="button" className="icon-button modal-close" onClick={onClose} aria-label={t('common.close')}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
          {section === 'general' && <General {...props} />}
          {section === 'team' && <TeamSection {...props} />}
          {section === 'providers' && <Providers team={props.team} />}
          {section === 'marketplace' && <Marketplace {...props} />}
          {section === 'routines' && <Routines team={props.team} conversations={props.conversations} routines={props.routines} />}
          {section === 'skills' && <Skills team={props.team} />}
          {section === 'usage' && <Usage {...props} />}
          {section === 'account' && <AccountSection {...props} />}
        </div>
      </div>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>
}

function Row({ title, hint, children }: { title: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="row">
      <div className="row-text">
        <div className="row-title">{title}</div>
        {hint && <div className="row-hint">{hint}</div>}
      </div>
      <div className="row-control">{children}</div>
    </div>
  )
}

function relativeLabel(ts: number): string {
  if (getLocale() !== 'zh-CN') return formatRelative(ts)
  const diff = ts - Date.now()
  const abs = Math.abs(diff)
  const unit = abs < 3_600_000 ? ['minutes', 60_000] as const : abs < 86_400_000 ? ['hours', 3_600_000] as const : ['days', 86_400_000] as const
  const duration = t(`time.${unit[0]}` as 'time.minutes', { n: Math.round(abs / unit[1]) })
  return t(diff > 0 ? 'time.in' : 'time.ago', { duration })
}

function localizedMarketItem(id: string, field: 'title' | 'description' | 'argHint', fallback: string): string {
  return catalogText(getLocale(), `settings.market.item.${id}.${field}`, fallback)
}

function localizedMarketSecret(key: string, fallback: string): string {
  const id = ({ GITHUB_PERSONAL_ACCESS_TOKEN: 'github', SUPABASE_ACCESS_TOKEN: 'supabase', SLACK_BOT_TOKEN: 'slackToken', SLACK_TEAM_ID: 'slackTeam', NOTION_TOKEN: 'notion', BRAVE_API_KEY: 'brave' } as Record<string, string>)[key] ?? key
  return catalogText(getLocale(), `settings.market.secret.${id}`, fallback)
}

/* ---------- General ---------- */

function General({ team }: SettingsProps) {
  const locale = useLocale()
  const [company, setCompany] = useState(team.company)
  const [ownerName, setOwnerName] = useState(team.owner.name)
  const [ownerTitle, setOwnerTitle] = useState(team.owner.title)
  const [workspace, setWorkspace] = useState(team.workspace)
  const [settings, setSettings] = useState(team.settings)
  const [status, setStatus] = useState<string | null>(null)

  const save = async () => {
    setStatus(t('common.saving'))
    try {
      await putSettings({ company, ownerName, ownerTitle, workspace, settings })
      setStatus(t('settings.saved'))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <h1>{t('settings.nav.general')}</h1>
      <OfficeConnectionPanel />
      <h4>{t('settings.company')}</h4>
      <Card>
        <Row title={t('settings.companyName')}>
          <input value={company} onChange={(e) => setCompany(e.target.value)} />
        </Row>
        <Row title={t('settings.yourName')} hint={t('settings.yourNameHint')}>
          <input value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
        </Row>
        <Row title={t('settings.yourTitle')}>
          <input value={ownerTitle} onChange={(e) => setOwnerTitle(e.target.value)} />
        </Row>
        <AvatarEditor target="user" person={personFor(team, 'user')} />
        <Row title={t('settings.language')} hint={t('settings.languageHint')}>
          <LocaleSwitch />
        </Row>
        <Row title={locale === 'zh-CN' ? '外观' : 'Appearance'} hint={locale === 'zh-CN' ? '仅影响此设备上的界面。' : 'Changes the interface on this device only.'}>
          <AppearancePicker />
        </Row>
        <Row title={t('settings.replyChinese')} hint={t('settings.replyHint')}>
          <input
            type="checkbox"
            className="toggle"
            checked={settings.language === CHINESE_REPLY_LANGUAGE}
            onChange={(e) => setSettings({ ...settings, language: e.target.checked ? CHINESE_REPLY_LANGUAGE : 'auto' })}
          />
        </Row>
        <Row title={t('settings.workspace')} hint={t('settings.workspaceHint')}>
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} className="wide" />
        </Row>
      </Card>
      <h4>{t('settings.rules')}</h4>
      <Card>
        <Row title={t('settings.groupMode')} hint={t('settings.groupModeHint')}>
          <select value={settings.groupMode} onChange={(e) => setSettings({ ...settings, groupMode: e.target.value as TeamSettings['groupMode'] })}>
            <option value="smart">{t('settings.groupSmart')}</option>
            <option value="everyone">{t('settings.groupEveryone')}</option>
            <option value="mentions-only">{t('settings.groupMentions')}</option>
          </select>
        </Row>
        <Row title={t('settings.planDiscussion')} hint={t('settings.planDiscussionHint')}>
          <select value={settings.planDiscussion ?? 'auto'} onChange={(e) => setSettings({ ...settings, planDiscussion: e.target.value as TeamSettings['planDiscussion'] })}>
            <option value="auto">{t('settings.planDiscussionAuto')}</option>
            <option value="on">{t('settings.planDiscussionOn')}</option>
            <option value="off">{t('settings.planDiscussionOff')}</option>
          </select>
        </Row>
        <Row title={t('settings.maxDiscussionParticipants')} hint={t('settings.maxDiscussionParticipantsHint')}>
          <input type="number" min={1} max={12} value={settings.maxDiscussionParticipants ?? 6} onChange={(e) => setSettings({ ...settings, maxDiscussionParticipants: Math.min(12, Math.max(1, Number(e.target.value) || 1)) })} />
        </Row>
        <Row title={t('settings.replyIn')} hint={t('settings.replyInHint')}>
          <select
            value={['auto', 'ar', 'en'].includes(settings.language) ? settings.language : 'other'}
            onChange={(e) => setSettings({ ...settings, language: e.target.value === 'other' ? '' : e.target.value })}
          >
            <option value="auto">{t('settings.replyAuto')}</option>
            <option value="ar">{t('settings.replyAr')}</option>
            <option value="en">{t('settings.replyEn')}</option>
            <option value="other">{t('settings.replyOther')}</option>
          </select>
          {!['auto', 'ar', 'en'].includes(settings.language) && <input value={settings.language} onChange={(e) => setSettings({ ...settings, language: e.target.value })} placeholder={t('settings.replyOtherPh')} />}
        </Row>
        <Row title={t('settings.notifications')} hint={t('settings.notificationsHint')}>
          <input type="checkbox" className="toggle" checked={settings.notifications} onChange={(e) => setSettings({ ...settings, notifications: e.target.checked })} />
        </Row>
        <Row title={t('settings.maxMessages')} hint={t('settings.maxMessagesHint')}>
          <input type="number" min={1} max={30} value={settings.maxMessagesPerRound} onChange={(e) => setSettings({ ...settings, maxMessagesPerRound: Number(e.target.value) })} />
        </Row>
        <Row title={t('settings.maxTurns')} hint={t('settings.maxTurnsHint')}>
          <input type="number" min={1} max={10} value={settings.maxTurnsPerAgentPerRound} onChange={(e) => setSettings({ ...settings, maxTurnsPerAgentPerRound: Number(e.target.value) })} />
        </Row>
        <Row title={t('settings.maxSteps')} hint={t('settings.maxStepsHint')}>
          <input type="number" min={1} max={200} value={settings.maxTurnsPerReply} onChange={(e) => setSettings({ ...settings, maxTurnsPerReply: Number(e.target.value) })} />
        </Row>
      </Card>
      <h4>{t('settings.helpers')}</h4>
      <p className="lead">{t('settings.helpersLead')}</p>
      <Card>
        <Row title={t('settings.dispatcher')} hint={t('settings.dispatcherHint')}>
          <HelperPicker team={team} value={settings.router ?? { mode: 'deterministic' }} offMode="deterministic" offLabel={t('settings.deterministic')} onChange={(router) => setSettings({ ...settings, router })} />
        </Row>
        <Row title={t('settings.memoryHelper')} hint={t('settings.memoryHelperHint')}>
          <HelperPicker team={team} value={settings.memory ?? { mode: 'off' }} offMode="off" offLabel={t('settings.off')} onChange={(memory) => setSettings({ ...settings, memory })} />
        </Row>
      </Card>
      <h4>{t('profile.workflow')}</h4>
      <Card>
        <Row title={t('settings.attempts')} hint={t('settings.attemptsHint')}>
          <input type="number" min={1} max={10} value={settings.maxTaskAttempts ?? 3} onChange={(e) => setSettings({ ...settings, maxTaskAttempts: Number(e.target.value) })} />
        </Row>
        <Row title={t('settings.critiqueRounds')} hint={t('settings.critiqueRoundsHint')}>
          <input type="number" min={0} max={3} value={settings.maxCritiqueRounds ?? 1} onChange={(e) => setSettings({ ...settings, maxCritiqueRounds: Number(e.target.value) })} />
        </Row>
        <Row title={t('settings.autoStart')} hint={t('settings.autoStartHint')}>
          <input type="checkbox" className="toggle" checked={settings.autoStartExecution === true} onChange={(e) => setSettings({ ...settings, autoStartExecution: e.target.checked })} />
        </Row>
      </Card>
      <h4>{t('settings.autoReview')}</h4>
      <p className="lead">{t('settings.autoReviewLead')}</p>
      <Card>
        {settings.autoReview.length === 0 && <Row title={t('settings.noRules')} hint={t('settings.noRulesHint')} />}
        {settings.autoReview.map((r) => (
          <Row key={r.id} title={r.action === 'allow' ? t('settings.ruleAllow', { tool: r.tool }) : t('settings.ruleRequire', { tool: r.tool })} hint={r.match ? t('settings.ruleWhen', { match: r.match }) : t('settings.ruleEvery')}>
            <button type="button" className="btn btn-danger-ghost" onClick={() => setSettings({ ...settings, autoReview: settings.autoReview.filter((x) => x.id !== r.id) })}>
              {t('composer.remove')}
            </button>
          </Row>
        ))}
        <RuleAdder onAdd={(rule) => setSettings({ ...settings, autoReview: [...settings.autoReview, rule] })} />
      </Card>
      <div className="actions">
        <span className="status">{status}</span>
        <button type="button" className="btn btn-primary" onClick={() => void save()}>
          {t('common.save')}
        </button>
      </div>
    </>
  )
}

function HelperPicker({ team, value, offMode, offLabel, onChange }: { team: Team; value: HelperModel; offMode: 'deterministic' | 'off'; offLabel: string; onChange: (v: HelperModel) => void }) {
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const model = value.mode === 'model' ? value : null
  const def = model ? team.providers[model.provider] : undefined
  const switchProvider = async (id: string) => {
    if (id === '__off') {
      onChange(offMode === 'off' ? { mode: 'off' } : { mode: 'deterministic' })
      return
    }
    const next = team.providers[id]
    if (!next) return
    setSwitching(id)
    let nextCatalog: ProviderModelCatalog | null = null
    try { nextCatalog = await providerModels(id) } catch { /* The model picker provides a localized retry path. */ }
    setCatalog(nextCatalog)
    onChange({ mode: 'model', provider: id, model: modelForProviderSwitch(next, model?.model ?? '', nextCatalog) })
    setSwitching(null)
  }
  return (
    <>
      <select
        value={switching ?? (model ? model.provider : '__off')}
        disabled={switching !== null}
        onChange={(e) => void switchProvider(e.target.value)}
      >
        <option value="__off">{offLabel}</option>
        {Object.entries(team.providers).map(([id, d]) => (
          <option key={id} value={id}>
            {providerLabel(getLocale(), d)}
          </option>
        ))}
      </select>
      {model && def && <ModelPicker id={`${offMode}-model`} providerId={model.provider} provider={def} model={model.model} initializeEmpty={!model.model} initialCatalog={catalog?.provider === model.provider ? catalog : null} onChange={(nextModel) => onChange({ mode: 'model', provider: model.provider, model: nextModel })} />}
    </>
  )
}

/* ---------- Team ---------- */

function TeamSection({ team, usage, onEditAgent, onAddTeam }: SettingsProps) {
  return (
    <>
      <h1>{t('settings.nav.team')}</h1>
      <p className="lead">{t('team.lead')}</p>
      <Card>
        {team.agents.map((a) => {
          const p = personFor(team, a.id)
          const u = usage.byAgent[a.id]
          const provider = team.providers[a.provider]
          return (
            <div key={a.id} className="row row-button" onClick={() => onEditAgent(a.id)} role="button" tabIndex={0}>
              <Avatar person={p} size={36} />
              <div className="row-text">
                <div className="row-title">
                  {p.label}
                  {a.department && <span className="badge">{a.department}</span>}
                </div>
                <div className="row-hint">
                  {provider ? providerLabel(getLocale(), provider) : a.provider} · {modelLabel(a.model)} · {t('team.effort', { effort: effortLabel(getLocale(), { id: a.effort, label: a.effort }) })} · {a.tools.length ? a.tools.join(', ') : t('team.chatOnly')}
                  {a.muted ? ` · ${t('nav.muted')}` : ''}
                  {a.mcpServers.length > 0 && ` · MCP: ${a.mcpServers.join(', ')}`}
                </div>
              </div>
              <div className="row-control muted">
                {u ? t('team.tokens', { tokens: formatTokens(u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheCreationTokens), cost: formatCost(u.costUsd) }) : t('team.noUsage')}
                <a className="btn" href={exportAgentUrl(a.id)} download onClick={(e) => e.stopPropagation()} title={t('team.exportHint')}>
                  {t('team.export')}
                </a>
              </div>
            </div>
          )
        })}
      </Card>
      <div className="actions">
        <ImportButton />
        <button type="button" className="btn" onClick={onAddTeam} title={t('team.devTeamHint')}>
          {t('team.devTeam')}
        </button>
        <button type="button" className="btn btn-primary" onClick={() => onEditAgent(null)}>
          {t('team.newEmployee')}
        </button>
      </div>
    </>
  )
}

/* ---------- Marketplace ---------- */

function Marketplace({ team }: SettingsProps) {
  const [q, setQ] = useState('')
  const [category, setCategory] = useState<string>('All')
  const [adding, setAdding] = useState<MarketplaceItem | null>(null)
  const [custom, setCustom] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const installed = Object.keys(team.mcpServers)
  const categories = ['All', ...new Set(MARKETPLACE.map((m) => m.category))]
  const items = MARKETPLACE.filter((m) => (category === 'All' || m.category === category) && `${m.name} ${localizedMarketItem(m.id, 'description', m.description)}`.toLowerCase().includes(q.toLowerCase()))

  const remove = async (name: string) => {
    setError(null)
    try {
      await deleteMcpServer(name)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="marketplace-head">
        <h1>{t('settings.market.title')}</h1>
        <button type="button" className="btn" onClick={() => setCustom(true)}>
          {t('settings.market.custom')}
        </button>
      </div>
      <p className="lead">{t('settings.market.lead')}</p>
      {installed.length > 0 && (
        <>
          <h4>{t('settings.market.installed', { count: installed.length })}</h4>
          <Card>
            {installed.map((name) => {
              const def = team.mcpServers[name]
              const users = team.agents.filter((a) => a.mcpServers.includes(name)).map((a) => a.name)
              return (
                <Row key={name} title={name} hint={`${def?.type === 'stdio' ? `${def.command} ${(def.args ?? []).join(' ')}` : def?.url ?? ''}${users.length ? ` · ${t('settings.market.usedBy', { names: users.join(', ') })}` : ` · ${t('settings.market.notEnabled')}`}`}>
                  <button type="button" className="btn btn-danger-ghost" onClick={() => void remove(name)}>
                    {t('common.delete')}
                  </button>
                </Row>
              )
            })}
          </Card>
        </>
      )}
      {error && <div className="form-error">{error}</div>}
      <label className="search search-wide">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('settings.market.search')} />
      </label>
      <div className="chips">
        {categories.map((c) => (
          <button key={c} type="button" className={`chip${category === c ? ' is-active' : ''}`} onClick={() => setCategory(c)}>
            {c === 'All' ? t('settings.market.all') : t(`settings.market.category.${c.toLowerCase()}` as MessageKey)}
          </button>
        ))}
      </div>
      <div className="market-grid">
        {items.map((m) => (
          <div key={m.id} className="market-item">
            <span className="market-icon">{m.icon}</span>
            <div className="market-text">
              <div className="row-title">{localizedMarketItem(m.id, 'title', m.name)}</div>
              <div className="row-hint">{localizedMarketItem(m.id, 'description', m.description)}</div>
            </div>
            {installed.includes(m.id) ? (
              <span className="muted">{t('settings.market.added')}</span>
            ) : (
              <button type="button" className="btn btn-pill" onClick={() => setAdding(m)}>
                {t('settings.market.add')}
              </button>
            )}
          </div>
        ))}
      </div>
      {adding && <AddServer item={adding} onDone={() => setAdding(null)} />}
      {custom && <AddServer item={null} onDone={() => setCustom(false)} />}
    </>
  )
}

function AddServer({ item, onDone }: { item: MarketplaceItem | null; onDone: () => void }) {
  const [name, setName] = useState(item?.id ?? '')
  const [type, setType] = useState<McpServerDef['type']>(item?.def.type ?? 'stdio')
  const [command, setCommand] = useState(item?.def.type === 'stdio' ? item.def.command : 'npx')
  const [args, setArgs] = useState(item?.def.type === 'stdio' ? (item.def.args ?? []).join(' ') : '')
  const [url, setUrl] = useState(item && item.def.type !== 'stdio' ? item.def.url : '')
  const [secrets, setSecrets] = useState<Record<string, string>>({})
  const [envText, setEnvText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const env: Record<string, string> = { ...secrets }
      for (const line of envText.split('\n')) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
        if (m && m[1] && m[2] !== undefined) env[m[1]] = m[2]
      }
      for (const s of item?.secrets ?? []) if (!env[s.key]) throw new Error(t('settings.market.required', { field: localizedMarketSecret(s.key, s.label) }))
      const def: McpServerDef =
        type === 'stdio'
          ? { type: 'stdio', command: command.trim(), ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}), ...(Object.keys(env).length ? { env } : {}) }
          : { type, url: url.trim(), ...(Object.keys(env).length ? { headers: env } : {}) }
      await putMcpServer(name.trim(), def)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop nested" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet" role="dialog">
        <h2>{item ? t('settings.market.addNamed', { name: localizedMarketItem(item.id, 'title', item.name) }) : t('settings.market.custom')}</h2>
        {error && <div className="form-error">{error}</div>}
        <label className="field">
          <span>{t('settings.market.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" disabled={item !== null} />
        </label>
        {!item && (
          <label className="field">
            <span>{t('settings.market.transport')}</span>
            <select value={type} onChange={(e) => setType(e.target.value as McpServerDef['type'])}>
              <option value="stdio">{t('settings.market.transportStdio')}</option>
              <option value="http">{t('settings.market.transportHttp')}</option>
              <option value="sse">{t('settings.market.transportSse')}</option>
            </select>
          </label>
        )}
        {type === 'stdio' ? (
          <>
            <label className="field">
              <span>{t('settings.market.command')}</span>
              <input value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="field">
              <span>{t('settings.market.arguments')}</span>
              <input value={args} onChange={(e) => setArgs(e.target.value)} />
              {item?.argHint && <small>{localizedMarketItem(item.id, 'argHint', item.argHint)}</small>}
            </label>
          </>
        ) : (
          <label className="field">
            <span>{t('settings.market.url')}</span>
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
          </label>
        )}
        {(item?.secrets ?? []).map((s) => (
          <label key={s.key} className="field">
            <span>{localizedMarketSecret(s.key, s.label)}</span>
            <input type="password" value={secrets[s.key] ?? ''} onChange={(e) => setSecrets({ ...secrets, [s.key]: e.target.value })} placeholder={s.key} />
          </label>
        ))}
        <label className="field">
          <span>{type === 'stdio' ? t('settings.market.extraEnv') : t('settings.market.extraHeaders')} ({t('common.optional')})</span>
          <textarea rows={2} value={envText} onChange={(e) => setEnvText(e.target.value)} placeholder={'KEY=value\nOTHER=value'} />
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim()} onClick={() => void save()}>
            {busy ? t('settings.market.adding') : t('settings.market.addServer')}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- Usage ---------- */

function totalsRow(t: UsageTotals) {
  return (
    <>
      <td>{t.messages}</td>
      <td>{formatTokens(t.inputTokens)}</td>
      <td>{formatTokens(t.cacheReadTokens)}</td>
      <td>{formatTokens(t.cacheCreationTokens)}</td>
      <td>{formatTokens(t.outputTokens)}</td>
      <td className="num-strong">{formatCost(t.costUsd)}</td>
    </>
  )
}

function Usage({ team, conversations, usage }: SettingsProps) {
  const total = usage.total
  const allIn = total.inputTokens + total.cacheReadTokens + total.cacheCreationTokens
  const agents = [...team.agents].sort((a, b) => (usage.byAgent[b.id]?.costUsd ?? 0) - (usage.byAgent[a.id]?.costUsd ?? 0))
  const convs = [...conversations].filter((c) => usage.byConversation[c.id]).sort((a, b) => (usage.byConversation[b.id]?.costUsd ?? 0) - (usage.byConversation[a.id]?.costUsd ?? 0))
  return (
    <>
      <h1>{t('settings.nav.usage')}</h1>
      <p className="lead">{t('usageLocal.lead')}</p>
      <div className="stats">
        <div className="stat">
          <div className="stat-value">{formatTokens(allIn)}</div>
          <div className="stat-label">{t('usageLocal.inputTokens')}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatTokens(total.outputTokens)}</div>
          <div className="stat-label">{t('usageLocal.outputTokens')}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{total.messages}</div>
          <div className="stat-label">{t('usageLocal.employeeReplies')}</div>
        </div>
        <div className="stat">
          <div className="stat-value">{formatCost(total.costUsd)}</div>
          <div className="stat-label">{t('usageLocal.apiEquivalent')}</div>
        </div>
      </div>
      <h4>{t('usageLocal.byEmployee')}</h4>
      <Card>
        <table className="table">
          <thead>
            <tr>
              <th>{t('usageLocal.employee')}</th>
              <th>{t('usageLocal.replies')}</th>
              <th>{t('usageLocal.input')}</th>
              <th>{t('usageLocal.cacheRead')}</th>
              <th>{t('usageLocal.cacheWrite')}</th>
              <th>{t('usageLocal.output')}</th>
              <th>{t('usageLocal.cost')}</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const u = usage.byAgent[a.id]
              const p = personFor(team, a.id)
              return (
                <tr key={a.id}>
                  <td>
                    <span className="cell-person">
                      <Avatar person={p} size={22} />
                      {p.label}
                      <span className="muted"> · {modelLabel(a.model)}</span>
                    </span>
                  </td>
                  {u ? totalsRow(u) : <td colSpan={6} className="muted">{t('usageLocal.noUsage')}</td>}
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
      {convs.length > 0 && (
        <>
          <h4>{t('usageLocal.byConversation')}</h4>
          <Card>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('usageLocal.conversation')}</th>
                  <th>{t('usageLocal.replies')}</th>
                  <th>{t('usageLocal.input')}</th>
                  <th>{t('usageLocal.cacheRead')}</th>
                  <th>{t('usageLocal.cacheWrite')}</th>
                  <th>{t('usageLocal.output')}</th>
                  <th>{t('usageLocal.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {convs.map((c) => {
                  const u = usage.byConversation[c.id]
                  return (
                    <tr key={c.id}>
                      <td className="cell-clip">{c.kind === 'group' ? `${t('usageLocal.group')} · ${conversationTitle(team, c)}` : `${t('usageLocal.directMessage')} · ${conversationTitle(team, c)}`}</td>
                      {u && totalsRow(u)}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        </>
      )}
      {Object.keys(usage.byModel).length > 0 && (
        <>
          <h4>{t('usageLocal.byModel')}</h4>
          <Card>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('usageLocal.model')}</th>
                  <th>{t('usageLocal.replies')}</th>
                  <th>{t('usageLocal.input')}</th>
                  <th>{t('usageLocal.cacheRead')}</th>
                  <th>{t('usageLocal.cacheWrite')}</th>
                  <th>{t('usageLocal.output')}</th>
                  <th>{t('usageLocal.cost')}</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(usage.byModel).map(([m, u]) => (
                  <tr key={m}>
                    <td>{m.split('+').map(modelLabel).join(' + ')}</td>
                    {totalsRow(u)}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  )
}

/* ---------- Account ---------- */

function AccountSection({ account }: SettingsProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const windows = Object.values(account.windows).sort((a, b) => a.type.localeCompare(b.type))
  const refresh = async () => {
    setBusy(true)
    setError(null)
    try {
      await refreshAccount()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const auth = account.authSource === undefined ? t('account.authUnknown') : account.authSource === 'none' ? t('account.authSubscription') : t('account.authKey', { source: account.authSource })
  return (
    <>
      <h1>{t('settings.nav.account')}</h1>
      <h4>{t('account.connection')}</h4>
      <Card>
        <Row title={t('account.signedIn')} hint={`Claude Code ${account.claudeCodeVersion ?? ''}`.trim()}>
          <span>{auth}</span>
        </Row>
        <Row title={t('account.refresh')} hint={t('account.refreshHint')}>
          <button type="button" className="btn" disabled={busy} onClick={() => void refresh()}>
            {busy ? t('account.checking') : t('account.check')}
          </button>
        </Row>
      </Card>
      {error && <div className="form-error">{error}</div>}
      <h4>{t('account.limits')}</h4>
      <Card>
        {windows.length === 0 ? (
          <Row title={t('account.noData')} hint={t('account.noDataHint')} />
        ) : (
          windows.map((w) => {
            const pct = typeof w.utilization === 'number' ? Math.min(100, Math.round(w.utilization * 100)) : null
            const tone = w.status === 'rejected' ? 'is-danger' : w.status === 'allowed_warning' || (pct ?? 0) >= 80 ? 'is-warn' : ''
            return (
              <div key={w.type} className="limit">
                <div className="limit-head">
                  <span className="row-title">{rateLimitLabel(getLocale(), w.type, RATE_LIMIT_LABELS[w.type])}</span>
                  <span className="muted">
                    {pct === null ? t(`account.status.${w.status}` as MessageKey) : t('account.used', { pct })}
                    {w.resetsAt ? t('account.resets', { when: relativeLabel(w.resetsAt * (w.resetsAt < 1e12 ? 1000 : 1)) }) : ''}
                  </span>
                </div>
                <div className={`bar ${tone}`}>
                  <div className="bar-fill" style={{ width: `${pct ?? (w.status === 'rejected' ? 100 : 0)}%` }} />
                </div>
              </div>
            )
          })
        )}
        {account.updatedAt && <div className="muted small">{t('account.updated', { when: relativeLabel(account.updatedAt) })}</div>}
      </Card>
    </>
  )
}

function RuleAdder({ onAdd }: { onAdd: (rule: AutoReviewRule) => void }) {
  const [action, setAction] = useState<'allow' | 'require'>('require')
  const [tool, setTool] = useState('Bash')
  const [match, setMatch] = useState('')
  return (
    <div className="row rule-adder">
      <select value={action} onChange={(e) => setAction(e.target.value as 'allow' | 'require')}>
        <option value="require">{t('settings.ruleRequireOpt')}</option>
        <option value="allow">{t('settings.ruleAllowOpt')}</option>
      </select>
      <input value={tool} onChange={(e) => setTool(e.target.value)} placeholder={t('settings.ruleToolPh')} />
      <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder={t('settings.ruleMatchPh')} />
      <button
        type="button"
        className="btn"
        disabled={!tool.trim()}
        onClick={() => {
          onAdd({ id: Math.random().toString(36).slice(2, 10), action, tool: tool.trim(), ...(match.trim() ? { match: match.trim() } : {}) })
          setMatch('')
        }}
      >
        {t('settings.addRule')}
      </button>
    </div>
  )
}

function ImportButton() {
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      {error && <span className="status" style={{ color: 'var(--danger)' }}>{error}</span>}
      <label className="btn">
        {t('team.import')}
        <input
          type="file"
          accept="application/json,.json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            setError(null)
            try {
              const parsed = JSON.parse(await f.text()) as { agent?: unknown }
              await importAgent(parsed.agent ?? parsed)
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}
        />
      </label>
    </>
  )
}
