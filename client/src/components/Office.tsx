import { useState, type ReactNode } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { Agent, AgentActivity, AgentLedgerDay, ApprovalRequest, Conversation, Project, ProviderCheck, Team } from '../../../shared/types'
import { bucketOf, ledgerTotals, PRESENCE_GLYPH, presenceOf, type Tone } from '../../../shared/presence'
import { duration, presenceDetail, presenceLabel, providerText } from '../activity'
import { providerStatuses } from '../api'
import { useNow } from '../companion'
import { t } from '../i18n'
import { personFor } from '../people'
import { Avatar } from './Avatar'

interface OfficeProps {
  team: Team
  conversations: Conversation[]
  projects: Project[]
  activity: Map<string, AgentActivity>
  ledger: Map<string, AgentLedgerDay>
  providerChecks: Record<string, ProviderCheck>
  approvals: ApprovalRequest[]
  connected: boolean
  clockOffset: number
  /** 'all', 'none' (not on a project) or a project id. */
  filter: string
  onFilter: (f: string) => void
  onOpenChat: (conversationId: string) => void
  /** The companion (pet) settings panel. */
  companion: ReactNode
}

const TONES: Tone[] = ['working', 'attention', 'problem', 'wait', 'done', 'quiet', 'unknown']

/** One desk per employee, driven only by the server's activity reports. */
export function Office({ team, conversations, projects, activity, ledger, providerChecks, approvals, connected, clockOffset, filter, onFilter, onOpenChat, companion }: OfficeProps) {
  const now = useNow(clockOffset)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const open = projects.filter((p) => !p.archived)
  const project = open.find((p) => p.id === filter)
  const members = project ? new Set(conversations.find((c) => c.id === project.conversationId)?.memberIds ?? []) : undefined
  const agents = team.agents.filter((a) => {
    const act = activity.get(a.id)
    if (filter === 'all') return true
    if (filter === 'none') return !act?.projectId
    return act?.projectId === filter || (members?.has(a.id) ?? false)
  })
  const counts = new Map<Tone, number>()
  for (const a of agents) {
    const tone = presenceOf(activity.get(a.id), now, { connected }).tone
    counts.set(tone, (counts.get(tone) ?? 0) + 1)
  }

  const check = async () => {
    setChecking(true)
    setCheckError(null)
    try {
      await providerStatuses(true)
    } catch (err) {
      setCheckError(err instanceof Error ? err.message : String(err))
    } finally {
      setChecking(false)
    }
  }

  return (
    <section className="office" aria-labelledby="office-title">
      <header className="office-header">
        <h1 id="office-title">{t('nav.office')}</h1>
        <label className="office-filter">
          <span>{t('office.show')}</span>
          <select value={project || filter === 'none' ? filter : 'all'} onChange={(e) => onFilter(e.target.value)}>
            <option value="all">{t('office.allTeam')}</option>
            {open.map((p) => (
              <option key={p.id} value={p.id}>
                {t('office.project', { name: p.name })}
              </option>
            ))}
            <option value="none">{t('office.noProject')}</option>
          </select>
        </label>
        <button type="button" className="btn btn-pill" onClick={() => void check()} disabled={checking} title={t('office.checkHint')}>
          {checking ? t('office.checking') : t('office.check')}
        </button>
      </header>
      <div className="office-scroll">
        {!connected && (
          <p className="office-banner" role="alert">
            {t('office.disconnected')}
          </p>
        )}
        {checkError && <p className="office-banner">{t('office.checkFailed', { error: checkError })}</p>}
        <p className="office-summary" aria-live="polite">
          {agents.length === 0
            ? filter === 'none'
              ? t('office.allOnProjects')
              : t('office.nobody')
            : TONES.filter((tone) => counts.get(tone))
                .map((tone) => t(`office.tone.${tone}` as MessageKey, { n: counts.get(tone) ?? 0 }))
                .join(' · ')}
        </p>
        <div className="desk-grid">
          {agents.map((a) => (
            <Desk key={a.id} team={team} agent={a} act={activity.get(a.id)} day={ledger.get(a.id)} check={providerChecks[a.provider]} projects={projects} approval={approvals.find((r) => r.agentId === a.id)} connected={connected} now={now} onOpenChat={onOpenChat} />
          ))}
        </div>
        <section className="office-companion" id="companion" aria-labelledby="companion-title">
          <h2 id="companion-title">{t('office.companion')}</h2>
          {companion}
        </section>
        <p className="office-note">{t('office.note')}</p>
      </div>
    </section>
  )
}

interface DeskProps {
  team: Team
  agent: Agent
  act: AgentActivity | undefined
  day: AgentLedgerDay | undefined
  check: ProviderCheck | undefined
  projects: Project[]
  approval: ApprovalRequest | undefined
  connected: boolean
  now: number
  onOpenChat: (conversationId: string) => void
}

function Desk({ team, agent, act, day, check, projects, approval, connected, now, onOpenChat }: DeskProps) {
  const person = personFor(team, agent.id)
  const view = presenceOf(act, now, { connected })
  const label = presenceLabel(view, act, connected)
  const detail = presenceDetail(view, act, now, connected)
  const provider = team.providers[agent.provider]
  const status = providerText(check, now)
  const project = act?.projectId ? projects.find((p) => p.id === act.projectId) : undefined
  const task = act?.taskRef ? project?.tasks.find((x) => x.id === act.taskRef) : undefined
  const totals = ledgerTotals(day, now)
  const last = view.live && view.quietFor !== undefined ? t('desk.lastOutput', { d: duration(view.quietFor) }) : act?.lastActiveAt ? t('desk.lastTurn', { d: duration(now - act.lastActiveAt) }) : t('desk.noTurn')
  const conversationId = act?.conversationId ?? project?.conversationId
  return (
    <article className={`desk pres-${view.presence} tone-${view.tone}`} aria-label={`${agent.name}: ${label}`}>
      <div className="desk-top">
        <span className="desk-avatar">
          <Avatar person={person} size={44} />
        </span>
        <div className="desk-id">
          <div className="desk-name" style={{ color: agent.color }}>
            {agent.name}
          </div>
          <div className="desk-role">{agent.role}</div>
          <div className="desk-model" title={provider ? `${provider.label} (${provider.kind})` : agent.provider}>
            {provider?.label ?? agent.provider} · {agent.model || t('common.default')}
          </div>
          <a className="desk-quota quota-link" href={`#/usage/${agent.id}`}>
            {t('nav.usage')}
          </a>
        </div>
      </div>
      <div className="desk-state">
        <span className="desk-glyph" aria-hidden="true">
          {PRESENCE_GLYPH[view.presence]}
        </span>
        <span className="desk-label">{label}</span>
        {act && connected && view.presence !== 'unknown' && <span className="desk-elapsed">{t('desk.for', { d: duration(now - act.since) })}</span>}
      </div>
      {project && conversationId && (
        <button type="button" className="desk-task" onClick={() => onOpenChat(conversationId)} title={t('desk.openProject')}>
          {act?.taskRef ? `${act.taskRef}${task ? ` · ${task.title}` : ''}` : t('desk.projectChat')} <span className="muted">{t('desk.in', { name: project.name })}</span>
        </button>
      )}
      {!project && conversationId && view.live && (
        <button type="button" className="desk-task" onClick={() => onOpenChat(conversationId)}>
          {t('desk.openConversation')}
        </button>
      )}
      {detail && (
        <div className="desk-detail" title={detail}>
          {detail}
        </div>
      )}
      {approval && (
        <button type="button" className="btn btn-pill desk-approval" onClick={() => onOpenChat(approval.conversationId)}>
          {t('desk.openApproval', { tool: approval.tool })}
        </button>
      )}
      <div className="desk-meta">{last}</div>
      <div className={`desk-provider is-${status.state}`}>{t('desk.provider', { text: status.text })}</div>
      <Timeline day={day} now={now} />
      <div className="desk-today">
        {totals.observed > 0 ? (
          <>
            {t('desk.today', { observed: duration(totals.observed), working: duration(totals.working), waiting: duration(totals.waiting), idle: duration(totals.idle) })}
            {totals.problem > 0 ? t('desk.problems', { d: duration(totals.problem) }) : ''}
          </>
        ) : (
          t('desk.nothingToday')
        )}
      </div>
    </article>
  )
}

/** Today's state changes as a bar. Earlier changes beyond the kept window and restarts are shown as such. */
function Timeline({ day, now }: { day: AgentLedgerDay | undefined; now: number }) {
  if (!day || day.timeline.length === 0) return null
  const from = day.observedFrom
  const span = Math.max(1, now - from)
  const segments: { start: number; end: number; cls: string; title: string }[] = []
  const first = day.timeline[0]
  if (first && first.at > from + 1000) segments.push({ start: from, end: first.at, cls: 'seg-earlier', title: t('timeline.earlier') })
  day.timeline.forEach((e, i) => {
    const end = day.timeline[i + 1]?.at ?? now
    const act: AgentActivity = { agentId: day.agentId, state: e.state === 'unknown' ? 'idle' : e.state, since: e.at, lastEventAt: end }
    const label = e.state === 'unknown' ? t('timeline.gap') : presenceLabel(presenceOf(act, end), act, true)
    segments.push({ start: e.at, end, cls: e.state === 'unknown' ? 'seg-gap' : `seg-${bucketOf(e.state)}`, title: `${clock(e.at)}–${clock(end)} ${label}` })
  })
  return (
    <div className="timeline" role="img" aria-label={t('timeline.label', { n: day.timeline.length, time: clock(from) })}>
      {segments.map((s, i) => (
        <span key={i} className={`timeline-seg ${s.cls}`} style={{ left: `${((s.start - from) / span) * 100}%`, width: `${Math.max(0.5, ((s.end - s.start) / span) * 100)}%` }} title={s.title} />
      ))}
    </div>
  )
}

function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
