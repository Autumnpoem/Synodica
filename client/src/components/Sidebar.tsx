import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import { localizedText } from '../../../shared/notes'
import { presenceOf } from '../../../shared/presence'
import type { AgentActivity, ApprovalRequest, Conversation, Project, Team } from '../../../shared/types'
import { conversationAvatars, conversationTitle, formatTime, personFor } from '../people'
import { getLocale, t } from '../i18n'
import { desktopBridge } from '../companion'
import { lastRead } from '../unread'
import { Avatar, AvatarCluster } from './Avatar'
import { LocaleSwitch } from './LocaleSwitch'

interface SidebarProps {
  team: Team
  conversations: Conversation[]
  activeId: string
  busy: Set<string>
  approvals: ApprovalRequest[]
  /** Bumped by the parent whenever read markers change, so badges refresh. */
  readTick: number
  onSelect: (id: string) => void
  onMenu: (conversationId: string, x: number, y: number) => void
  onSettings: () => void
  onNewChat: () => void
  onNewProject: () => void
  onSearch: () => void
  projects: Project[]
  officeActive: boolean
  onOffice: () => void
  usageActive: boolean
  onUsage: () => void
  /** One short line under "Usage and quotas" (e.g. accounts that need attention), or empty. */
  usageLine: string
  activity: Map<string, AgentActivity>
  connected: boolean
}

const PHASE_BADGE: Record<Project['phase'], string> = {
  new: 'new',
  planning: 'planning',
  'plan-ready': 'plan ready',
  executing: 'building',
  'final-review': 'final review',
  done: 'done',
  'needs-attention': 'needs you',
}

export function Sidebar({ team, conversations, activeId, busy, approvals, readTick, onSelect, onMenu, onSettings, onNewChat, onNewProject, onSearch, projects, officeActive, onOffice, usageActive, onUsage, usageLine, activity, connected }: SidebarProps) {
  const [q, setQ] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const owner = personFor(team, 'user')
  void readTick
  const rank = (c: Conversation): number => {
    if (c.pinned) return -2
    if (c.id === 'group') return -1
    if (c.kind === 'group') return -0.5
    const agentId = c.memberIds.find((id) => id !== 'user')
    const i = team.agents.findIndex((a) => a.id === agentId)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  const ordered = [...conversations].sort((a, b) => rank(a) - rank(b) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
  const filtered = ordered.filter((c) => conversationTitle(team, c).toLowerCase().includes(q.trim().toLowerCase()))
  const visible = filtered.filter((c) => !c.hidden)
  const hidden = filtered.filter((c) => c.hidden)
  const attention = new Set(approvals.map((a) => a.conversationId))
  const now = Date.now()
  const tones = team.agents.map((a) => presenceOf(activity.get(a.id), now, { connected }).tone)
  const working = tones.filter((t) => t === 'working').length
  const needs = tones.filter((t) => t === 'attention' || t === 'problem').length
  const officeLine = !connected ? t('sidebar.office.disconnected') : [
    t('sidebar.office.working', { n: working }),
    needs ? t(needs === 1 ? 'sidebar.office.oneNeedsLook' : 'sidebar.office.manyNeedLook', { n: needs }) : '',
    t('sidebar.office.other', { n: team.agents.length - working - needs }),
  ].filter(Boolean).join(' · ')

  const row = (c: Conversation) => {
    const last = c.messages[c.messages.length - 1]
    const people = conversationAvatars(c).map((id) => personFor(team, id))
    const active = c.id === activeId
    const preview = last ? previewOf(team, c, last.authorId, last.authorId === 'workflow' ? localizedText(getLocale(), last.text, last.note) : last.text) : c.kind === 'group' ? t('sidebar.emptyGroup') : t('sidebar.emptyConversation')
    const agent = c.kind === 'dm' ? people[0]?.agent : undefined
    const since = lastRead(c.id)
    const unread = active ? 0 : c.messages.filter((m) => m.authorId !== 'user' && m.status === 'done' && m.createdAt > since).length
    const project = c.projectId ? projects.find((p) => p.id === c.projectId) : undefined
    const needs = attention.has(c.id) || project?.phase === 'needs-attention' || (project?.tasks.some((t) => t.state === 'failed' || t.state === 'blocked' || t.state === 'interrupted') ?? false)
    return (
      <button
        key={c.id}
        type="button"
        className={`conversation${active ? ' is-active' : ''}${unread > 0 ? ' is-unread' : ''}`}
        onClick={() => onSelect(c.id)}
        onContextMenu={(e) => {
          e.preventDefault()
          onMenu(c.id, e.clientX, e.clientY)
        }}
      >
        <span className="conversation-avatar">
          <AvatarCluster people={people} size={c.kind === 'group' ? 40 : 44} compact />
        </span>
        <span className="conversation-body">
          <span className="conversation-row">
            <span className="conversation-title">
              {c.pinned && <PinIcon />}
              {conversationTitle(team, c)}
            </span>
            {project && <span className={`badge badge-phase phase-${project.phase}`}>{project.paused && project.phase !== 'done' ? t('task.state.paused') : t(`phase.${project.phase}` as MessageKey) || PHASE_BADGE[project.phase]}</span>}
            {agent?.department && <span className="badge">{agent.department}</span>}
            {agent?.muted && <span className="badge" title={t('nav.mutedHint')}>{t('nav.muted')}</span>}
            {last && <span className="conversation-time">{formatTime(last.createdAt)}</span>}
          </span>
          <span className="conversation-row">
            <span className="conversation-preview">{preview}</span>
            {needs ? <span className="dot is-attention" title={t('nav.needsYou')} /> :busy.has(c.id) ? <span className="dot" aria-label={t('nav.replying')} /> : unread > 0 ? <span className="unread">{unread > 99 ? '99+' : unread}</span> : null}
          </span>
        </span>
        <span
          className="conversation-more"
          role="button"
          tabIndex={-1}
          aria-label={t('nav.more')}
          onClick={(e) => {
            e.stopPropagation()
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
            onMenu(c.id, r.left, r.bottom + 4)
          }}
        >
          <MoreIcon />
        </span>
      </button>
    )
  }

  return (
    <aside className="sidebar">
      <div className={`app-brand${desktopBridge()?.platform === 'darwin' ? ' is-mac' : ''}`} aria-label="Synodica">
        <img src="/icon-192.png" alt="" width="36" height="36" />
        <span><strong>Synodica</strong><small>{'\u661f\u8bae'}</small></span>
      </div>
      <div className="sidebar-top">
        <button type="button" className="icon-button" title={t('nav.searchHint')} aria-label={t('nav.search')} onClick={onSearch}>
          <SearchIcon />
        </button>
        <button type="button" className="icon-button" title={t('nav.newChat')} aria-label={t('nav.newChat')} onClick={onNewChat}>
          <PlusIcon />
        </button>
        <button type="button" className="btn btn-pill new-project" title={t('nav.newProjectHint')} onClick={onNewProject}>
          + {t('nav.newProject')}
        </button>
      </div>
      <label className="search">
        <SearchIcon />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('nav.filter')} />
      </label>
      <button type="button" className={`office-link${officeActive ? ' is-active' : ''}`} onClick={onOffice} aria-current={officeActive ? 'page' : undefined}>
        <span className="office-link-title">{t('nav.office')}</span>
        <span className="office-link-line">{officeLine}</span>
      </button>
      <button type="button" className={`office-link usage-link${usageActive ? ' is-active' : ''}`} onClick={onUsage} aria-current={usageActive ? 'page' : undefined}>
        <span className="office-link-title">{t('nav.usage')}</span>
        {usageLine && <span className="office-link-line">{usageLine}</span>}
      </button>
      <nav className="conversation-list">
        {visible.map(row)}
        {hidden.length > 0 && (
          <button type="button" className="hidden-toggle" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? t('sidebar.hideHidden') : t(hidden.length === 1 ? 'sidebar.showOneHidden' : 'sidebar.showManyHidden', { n: hidden.length })}
          </button>
        )}
        {showHidden && hidden.map(row)}
      </nav>
      <div className="sidebar-bottom">
        <button type="button" className="sidebar-item" onClick={onSettings}>
          <span className="sidebar-item-icon">
            <GearIcon />
          </span>
          <span>{t('nav.settings')}</span>
        </button>
        <LocaleSwitch />
        <button type="button" className="sidebar-item" onClick={onSettings}>
          <Avatar person={owner} size={30} />
          <span>{owner.name}</span>
          <span className="muted small">{team.company}</span>
        </button>
      </div>
    </aside>
  )
}

function previewOf(team: Team, c: Conversation, authorId: string, text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const name = authorId === 'workflow' ? t('common.workflow') : personFor(team, authorId).name
  if (clean.length === 0) return `${name} is typing…`
  if (c.kind === 'dm' || authorId === 'user') return clean
  return `${name}: ${clean}`
}

function PlusIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M10 4v12M4 10h12" />
    </svg>
  )
}

function PinIcon() {
  return (
    <svg className="pin-icon" width="12" height="12" viewBox="0 0 20 20" fill="currentColor">
      <path d="M12 2l6 6-2 1-3-1-3 3 1 4-1 1-4-4-4 4-1-1 4-4-4-4 1-1 4 1 3-3-1-3z" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="9" cy="9" r="6" />
      <path d="M14 14l3.5 3.5" />
    </svg>
  )
}

function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  )
}

function MoreIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 20 20" fill="currentColor">
      <circle cx="4" cy="10" r="1.8" />
      <circle cx="10" cy="10" r="1.8" />
      <circle cx="16" cy="10" r="1.8" />
    </svg>
  )
}
