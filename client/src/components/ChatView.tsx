import { useEffect, useRef, useState } from 'react'
import type { AgentActivity, ApprovalRequest, Conversation, Message, Project, Team, UsageSummary } from '../../../shared/types'
import { capabilityNotes, effortLabel, providerLabel } from '../../../shared/catalog-i18n'
import { activityLine } from '../activity'
import { formatCost, formatDuration, formatTokens, modelLabel } from '../format'
import { getLocale, t } from '../i18n'
import { conversationAvatars, conversationTitle, personFor, type Person } from '../people'
import { ApprovalCard } from './Approval'
import { Avatar, AvatarCluster } from './Avatar'
import type { ReplyTarget } from './Composer'
import { AttachmentList, attachmentFromPath, producedFiles } from './Preview'
import { ProjectBoard } from './ProjectBoard'
import { RichText } from './RichText'

interface ChatViewProps {
  team: Team
  conversation: Conversation
  typing: Set<string>
  usage: UsageSummary
  approvals: ApprovalRequest[]
  jumpTo: string | null
  onEditAgent: (id: string) => void
  onReply: (target: ReplyTarget) => void
  profileOpen: boolean
  project?: Project
  activity: Map<string, AgentActivity>
  busy: boolean
}

interface Group {
  authorId: string
  messages: Message[]
}

function groupMessages(messages: Message[]): Group[] {
  const groups: Group[] = []
  for (const m of messages) {
    const last = groups[groups.length - 1]
    if (last && last.authorId === m.authorId && m.createdAt - (last.messages[last.messages.length - 1]?.createdAt ?? 0) < 5 * 60_000) {
      last.messages.push(m)
    } else {
      groups.push({ authorId: m.authorId, messages: [m] })
    }
  }
  return groups
}

function personOf(team: Team, id: string): Person {
  if (id === 'routine') return { id, label: 'ROUTINE', name: 'Routine', color: '#f59e0b', kind: 'agent' }
  return personFor(team, id)
}

export function ChatView({ team, conversation, typing, usage, approvals, jumpTo, onEditAgent, onReply, profileOpen, project, activity, busy }: ChatViewProps) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const pinned = useRef(true)
  const [showInfo, setShowInfo] = useState(true)
  const [tab, setTab] = useState<'board' | 'members'>('board')
  // Re-render now and then so "for 3m" activity durations stay current.
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((x) => x + 1), 15_000)
    return () => clearInterval(timer)
  }, [])
  const groups = groupMessages(conversation.messages)
  const typingPeople = [...typing].filter((id) => !conversation.messages.some((m) => m.authorId === id && m.status === 'streaming')).map((id) => personFor(team, id))
  const pendingHere = approvals.filter((a) => a.conversationId === conversation.id)

  const lastMessage = conversation.messages[conversation.messages.length - 1]
  const lastKey = `${conversation.id}:${conversation.messages.length}:${lastMessage?.text.length ?? 0}:${typingPeople.length}:${pendingHere.length}`
  // Keep the view pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current
    if (!el || !pinned.current) return
    el.scrollTop = el.scrollHeight
  }, [lastKey])

  useEffect(() => {
    pinned.current = true
    const el = scroller.current
    if (el) el.scrollTop = el.scrollHeight
  }, [conversation.id])

  useEffect(() => {
    if (!jumpTo) return
    const el = document.getElementById(`m-${jumpTo}`)
    if (!el) return
    pinned.current = false
    el.scrollIntoView({ block: 'center' })
    el.classList.add('is-highlight')
    const timer = setTimeout(() => el.classList.remove('is-highlight'), 2000)
    return () => clearTimeout(timer)
  }, [jumpTo])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const people = conversationAvatars(conversation).map((id) => personFor(team, id))
  const convUsage = usage.byConversation[conversation.id]
  const panel = showInfo && !profileOpen

  return (
    <section className="chat">
      <header className="chat-header">
        <AvatarCluster people={people} size={30} />
        <h1 className="chat-title">{conversationTitle(team, conversation)}</h1>
        {convUsage && (
          <span className="chat-usage" title={t('chat.usageHint')}>
            {t('chat.usage', { tokens: formatTokens(convUsage.inputTokens + convUsage.cacheReadTokens + convUsage.cacheCreationTokens + convUsage.outputTokens), cost: formatCost(convUsage.costUsd) })}
          </span>
        )}
        <button type="button" className={`icon-button${panel ? ' is-active' : ''}`} onClick={() => setShowInfo((v) => !v)} aria-label={panel ? t('chat.hideMembers') : t('chat.showMembers')}>
          {panel ? <ChevronsIcon /> : <InfoIcon />}
        </button>
      </header>
      <div className="chat-body">
        <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
          <div className="chat-messages">
            {groups.length === 0 && (
              <div className="chat-empty">
                <AvatarCluster people={people} size={56} />
                <p>{project ? t('chat.emptyProject') : conversation.kind === 'group' ? t('chat.emptyGroup') : t('chat.emptyDm', { name: people[0]?.label ?? t('chat.colleague') })}</p>
              </div>
            )}
            {groups.map((g) => (
              <MessageGroup key={g.messages[0]?.id ?? g.authorId} team={team} group={g} onReply={onReply} />
            ))}
            {pendingHere.map((r) => (
              <ApprovalCard key={r.id} team={team} request={r} />
            ))}
            {typingPeople.map((p) => (
              <div key={p.id} className="message-group is-agent">
                <span className="message-label" style={{ color: p.color }}>
                  {p.label}
                </span>
                <div className="message-row">
                  <span className="message-avatar">
                    <Avatar person={p} size={28} />
                  </span>
                  <div className="bubble bubble-typing" aria-label={t('chat.typing', { name: p.name })}>
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        {panel && (
          <aside className={`info-panel${project ? ' is-project' : ''}`}>
            {project && (
              <div className="panel-tabs">
                <button type="button" className={tab === 'board' ? 'is-active' : ''} onClick={() => setTab('board')}>
                  {t('chat.board')}
                </button>
                <button type="button" className={tab === 'members' ? 'is-active' : ''} onClick={() => setTab('members')}>
                  {t('settings.nav.team')}
                </button>
              </div>
            )}
            {project && tab === 'board' ? (
              <ProjectBoard team={team} project={project} conversation={conversation} activity={activity} busy={busy} />
            ) : (
              <>
                <h2>{t('newChat.members')}</h2>
                {conversation.memberIds
                  .filter((id) => id !== 'user')
                  .map((id) => {
                    const p = personFor(team, id)
                    const a = p.agent
                    const speaking = typing.has(id)
                    const u = usage.byAgent[id]
                    const act = activity.get(id)
                    const def = a ? team.providers[a.provider] : undefined
                    return (
                      <button key={id} type="button" className="info-member" onClick={() => onEditAgent(id)} title={def ? `${providerLabel(getLocale(), def)}: ${capabilityNotes(getLocale(), def.kind)}` : t('menu.editProfile')}>
                        <Avatar person={p} size={30} />
                        <span className="info-text">
                          <span className="info-name">{p.label}</span>
                          {a && (
                            <span className="info-meta">
                              {(def?.kind ?? 'claude') === 'claude' ? '' : `${def?.label.split(' ')[0] ?? a.provider} · `}
                              {modelLabel(a.model)} · {effortLabel(getLocale(), { id: a.effort, label: a.effort })}
                              {a.muted ? ` · ${t('nav.muted')}` : ''}
                              {u ? ` · ${formatTokens(u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens + u.outputTokens)} tok` : ''}
                            </span>
                          )}
                          <span className={`info-activity act-${act?.state ?? 'unknown'}`}>{activityLine(act)}</span>
                        </span>
                        {speaking && <span className="dot" aria-label={t('chat.typing', { name: p.name })} />}
                      </button>
                    )
                  })}
              </>
            )}
          </aside>
        )}
      </div>
    </section>
  )
}

function MessageGroup({ team, group, onReply }: { team: Team; group: Group; onReply: (t: ReplyTarget) => void }) {
  const person = personOf(team, group.authorId)
  const mine = person.kind === 'owner'
  const isRoutine = group.authorId === 'routine'
  return (
    <div className={`message-group ${mine ? 'is-mine' : 'is-agent'}${isRoutine ? ' is-routine' : ''}`}>
      {!mine && (
        <span className="message-label" style={{ color: person.color }}>
          {person.label}
        </span>
      )}
      {group.messages.map((m, i) => {
        const last = i === group.messages.length - 1
        // Employees' shared files come as attachments; older messages fall back to path detection.
        const shared = m.attachments && m.attachments.length > 0 ? m.attachments : !mine && m.status === 'done' ? producedFiles(m.text).map(attachmentFromPath) : []
        return (
          <div key={m.id} id={`m-${m.id}`} className="message-row">
            {!mine && <span className="message-avatar">{last && (isRoutine ? <span className="routine-avatar">⏰</span> : <Avatar person={person} size={28} />)}</span>}
            <div className="bubble-wrap">
              {m.replyTo && (
                <div className="reply-quote" dir="auto">
                  <strong>{m.replyTo.authorId === 'user' ? team.owner.name : personOf(team, m.replyTo.authorId).name}</strong> {m.replyTo.excerpt}
                </div>
              )}
              <div dir="auto" className={`bubble${m.status === 'streaming' ? ' is-streaming' : ''}${m.status === 'error' ? ' is-error' : ''}${m.status === 'superseded' ? ' is-superseded' : ''}${m.authorId === 'workflow' ? ' is-workflow' : ''}`}>
                {m.status === 'superseded' && <div className="superseded-label">{t('chat.superseded')}</div>}
                {m.taskRef && <span className="task-ref">{m.taskRef}</span>}
                {m.activity && m.activity.length > 0 && (
                  <div className="activity">
                    {m.activity.slice(-4).map((line, j) => (
                      <div key={j} className="activity-line">
                        <ToolIcon />
                        <span>{line}</span>
                      </div>
                    ))}
                  </div>
                )}
                {m.text.length > 0 ? <RichText text={m.text} team={team} /> : m.status === 'streaming' ? <span className="working">{t('chat.working')}</span> : null}
              </div>
              {shared.length > 0 && <AttachmentList items={shared} team={team} />}
              <div className="message-meta">
                {m.usage && (
                  <span>
                    {t('chat.msgUsage', { model: modelLabel(m.usage.model), in: formatTokens(m.usage.inputTokens + m.usage.cacheReadTokens + m.usage.cacheCreationTokens), out: formatTokens(m.usage.outputTokens), cost: formatCost(m.usage.costUsd), time: formatDuration(m.usage.durationMs) })}
                    {m.usage.numTurns > 1 ? ` · ${t('chat.steps', { n: m.usage.numTurns })}` : ''}
                  </span>
                )}
                {m.status === 'done' && m.text && (
                  <button type="button" className="link" onClick={() => onReply({ messageId: m.id, authorId: m.authorId, excerpt: m.text.replace(/\s+/g, ' ').slice(0, 120) })}>
                    {t('chat.reply')}
                  </button>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ChevronsIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 5l5 5-5 5M11 5l5 5-5 5" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v5M10 6.5v.5" />
    </svg>
  )
}

function ToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M4 6l6 4-6 4M11 15h5" />
    </svg>
  )
}
