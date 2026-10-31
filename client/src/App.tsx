import { useEffect, useReducer, useRef, useState } from 'react'
import type { NativePetSettings } from '../../shared/desktop'
import { parseAppLink, type AppLink, type PetPrefs } from '../../shared/presence'
import type { Conversation, ServerEvent } from '../../shared/types'
import type { SequencedEvent, SyncFrame } from '../../shared/sync'
import { initialReplyLanguage, REPLY_DEFAULT_STORAGE_KEY } from '../../shared/i18n'
import { acknowledgeMessage, authStatus, clearConversation, correct, deleteConversation, duplicateAgent, exportUrl, fetchUsage, petSettings, petStatus, projectAction, putSettings, resumeCorrection, sendMessageFull, setKnownProjects, stopRound, updateAgent, updateConversation, type PetStatusBody } from './api'
import { desktopBridge } from './companion'
import { connectEventStream } from './eventStream'
import { ChatView } from './components/ChatView'
import { DshPetPanel } from './components/DshPetPanel'
import { Office } from './components/Office'
import { Composer, type ReplyTarget } from './components/Composer'
import { useUpstreamPet } from './dshpet'
import { t, useLocale } from './i18n'
import { Menu, type MenuItem } from './components/Menu'
import { NewChat } from './components/NewChat'
import { NewProject } from './components/NewProject'
import { TeamTemplate } from './components/TeamTemplate'
import { Profile } from './components/Profile'
import { Search } from './components/Search'
import { Settings, type SettingsSection } from './components/Settings'
import { Sidebar } from './components/Sidebar'
import { Usage } from './components/Usage'
import { QuotaDock } from './components/QuotaDock'
import { usageCounts } from '../../shared/usage'
import { personFor } from './people'
import { initialState, reducer } from './state'
import { markRead, markUnread } from './unread'

interface MenuState {
  x: number
  y: number
  conversationId: string
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [activeId, setActiveId] = useState('group')
  const [error, setError] = useState<string | null>(null)
  const [settings, setSettings] = useState<SettingsSection | null>(null)
  /** undefined = closed, null = new employee, string = editing that employee */
  const [profile, setProfile] = useState<string | null | undefined>(undefined)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** undefined = closed, null = new chat, Conversation = editing */
  const [chatEditor, setChatEditor] = useState<Conversation | null | undefined>(undefined)
  const [search, setSearch] = useState(false)
  const [newProject, setNewProject] = useState(false)
  const [template, setTemplate] = useState(false)
  const [replyTo, setReplyTo] = useState<ReplyTarget | null>(null)
  const [jumpTo, setJumpTo] = useState<string | null>(null)
  const [readTick, setReadTick] = useState(0)
  /** Main area: a conversation, or the office (all desks). */
  const [view, setView] = useState<'chat' | 'office' | 'usage'>('chat')
  const [officeFilter, setOfficeFilter] = useState('all')
  /** #/usage/<id>: the account, provider or employee to scroll to on the usage page. */
  const [usageFocus, setUsageFocus] = useState<string | undefined>(undefined)
  /** Narrow windows: the sidebar is a drawer. */
  const [navOpen, setNavOpen] = useState(false)
  const [bridge] = useState(() => desktopBridge())
  const [nativePet, setNativePet] = useState<NativePetSettings | undefined>(undefined)
  const latest = useRef({ activeId, state })
  latest.current = { activeId, state }
  useEffect(() => setKnownProjects(state.projects), [state.projects])
  // The whole tree re-renders in the new language when the switch changes.
  const locale = useLocale()
  const [pet, setPet] = useState<PetStatusBody | null>(null)
  useEffect(() => {
    void petStatus()
      .then(setPet)
      .catch(() => setPet(null))
  }, [])
  const petRunning = pet?.status.state === 'running'
  const upstream = useUpstreamPet(petRunning, locale)

  // The native Pet menu and the pet's bubbles / menu items follow the interface language.
  useEffect(() => {
    bridge?.setLocale?.(locale)
  }, [bridge, locale])
  const petLocale = pet?.settings.locale
  useEffect(() => {
    if (!petLocale || petLocale === locale) return
    void petSettings({ locale })
      .then((r) => setPet((p) => (p ? { ...p, settings: r.settings } : p)))
      .catch(() => {})
  }, [locale, petLocale])

  // A fresh office opened with the Chinese UI replies in Chinese by default (once; never overrides an existing choice).
  const teamLanguage = state.team?.settings.language
  useEffect(() => {
    if (!teamLanguage || state.conversations.length === 0) return
    let decided = false
    try {
      decided = localStorage.getItem(REPLY_DEFAULT_STORAGE_KEY) === '1'
    } catch {
      decided = true
    }
    const next = initialReplyLanguage(teamLanguage, locale, state.conversations, decided)
    try {
      localStorage.setItem(REPLY_DEFAULT_STORAGE_KEY, '1')
    } catch {
      // storage disabled: decided again next time, still never overriding a used office
    }
    if (next) void putSettings({ settings: { language: next } }).catch(() => {})
  }, [teamLanguage, state.conversations.length > 0])

  const navigate = (link: AppLink) => {
    setNavOpen(false)
    if (link.view === 'office') {
      setView('office')
      setOfficeFilter(link.projectId ?? 'all')
      return
    }
    if (link.view === 'usage') {
      setView('usage')
      setUsageFocus(link.focus)
      return
    }
    // Unknown conversations fall back to the team chat (the lookup below), never to anything else.
    setActiveId(link.conversationId)
    setView('chat')
  }
  const navigateRef = useRef(navigate)
  navigateRef.current = navigate

  // Deep links: #/chat/<id>, #/approval/<id>, #/office[/<projectId>] (bookmarks, the desktop pet).
  useEffect(() => {
    const onHash = () => {
      const link = parseAppLink(window.location.hash)
      if (link) navigateRef.current(link)
      // Usage links (sidebar, desks, profiles) are clicked repeatedly: drop the hash so the same link fires again.
      if (link?.view === 'usage') window.history.replaceState(null, '', window.location.pathname + window.location.search)
    }
    onHash()
    window.addEventListener('hashchange', onHash)
    const offNav = bridge?.onNavigate((hash) => {
      const link = parseAppLink(hash)
      if (link) navigateRef.current(link)
    })
    const offPet = bridge?.onPetSettings(setNativePet)
    void bridge?.getPetSettings().then(setNativePet).catch(() => setNativePet(undefined))
    return () => {
      window.removeEventListener('hashchange', onHash)
      offNav?.()
      offPet?.()
    }
  }, [bridge])

  useEffect(() => {
    let alive = true
    // Usage is a separate report; the stream owns the complete office snapshot.
    void fetchUsage().then((report) => { if (alive) dispatch({ type: 'accountUsage', report }) }).catch(() => {})
    const closeStream = connectEventStream('/api/events', (es) => {
      es.addEventListener('sync', (e) => {
        if (!alive) return
        try {
          const frame = JSON.parse((e as MessageEvent).data) as SyncFrame
          for (const conversation of frame.state.conversations) for (const message of conversation.messages) acknowledgeMessage(message)
          dispatch({ type: 'sync', frame })
          dispatch({ type: 'connected', connected: true })
          setError(null)
          void fetchUsage().then((report) => { if (alive) dispatch({ type: 'accountUsage', report }) }).catch(() => {})
        } catch { setError('Invalid office snapshot') }
      })
      es.onerror = () => {
        dispatch({ type: 'connected', connected: false })
        void authStatus().then((status) => { if (alive && !status.authenticated) window.location.reload() }).catch(() => {})
      }
      es.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as SequencedEvent
          if (event.type === 'server' && event.state === 'draining') {
            dispatch({ type: 'connected', connected: false })
            setError(t('sync.draining'))
            return
          }
          if (event.type === 'pet:navigate') {
            // A pet menu item: open the real task, approval or office it points at.
            const link = parseAppLink(event.hash)
            if (link) {
              navigateRef.current(link)
              window.focus()
            }
            return
          }
          if (event.type === 'message:done') acknowledgeMessage(event.message)
          dispatch({ type: 'sequenced', event })
          maybeNotify(event)
        } catch {
          // ignore malformed frames
        }
      }
    })
    return () => {
      alive = false
      closeStream()
    }
  }, [])

  const maybeNotify = (event: ServerEvent) => {
    const { state: s, activeId: current } = latest.current
    if (!s.team?.settings.notifications || typeof Notification === 'undefined') return
    let title = ''
    let body = ''
    let conversationId = ''
    if (event.type === 'message:done' && event.message.authorId !== 'user' && event.message.status === 'done') {
      const away = document.hidden || !document.hasFocus() || event.message.conversationId !== current
      if (!away) return
      title = s.team ? personFor(s.team, event.message.authorId).label : 'Reply'
      body = event.message.text.slice(0, 160)
      conversationId = event.message.conversationId
    } else if (event.type === 'approval:request') {
      title = `${s.team ? personFor(s.team, event.request.agentId).name : 'An employee'} needs your approval`
      body = `${event.request.tool}: ${event.request.summary}`.slice(0, 160)
      conversationId = event.request.conversationId
    } else return
    const show = () => {
      const n = new Notification(title, { body, silent: true })
      n.onclick = () => {
        window.focus()
        setActiveId(conversationId)
        setView('chat')
      }
    }
    if (Notification.permission === 'granted') show()
    else if (Notification.permission === 'default') void Notification.requestPermission().then((p) => p === 'granted' && show())
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearch((v) => !v)
        return
      }
      if (e.key !== 'Escape') return
      if (navOpen) setNavOpen(false)
      else if (menu) setMenu(null)
      else if (template) setTemplate(false)
      else if (newProject) setNewProject(false)
      else if (search) setSearch(false)
      else if (chatEditor !== undefined) setChatEditor(undefined)
      else if (settings) setSettings(null)
      else if (profile !== undefined) setProfile(undefined)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menu, search, chatEditor, settings, profile, template, newProject, navOpen])

  const conversation = state.conversations.find((c) => c.id === activeId) ?? state.conversations.find((c) => c.id === 'group') ?? state.conversations[0]

  // Reading a conversation marks it read (also as new replies arrive while it is open).
  const lastAt = conversation?.messages[conversation.messages.length - 1]?.createdAt ?? 0
  useEffect(() => {
    if (!conversation || view !== 'chat') return
    markRead(conversation.id)
    setReadTick((t) => t + 1)
  }, [conversation?.id, lastAt, view])

  useEffect(() => setReplyTo(null), [activeId])

  if (!state.team || !conversation) {
    return (
      <div className="boot">
        {error ? <p className="boot-error">{t('app.unreachable', { error })}</p> : <p>{t('app.opening')}</p>}
      </div>
    )
  }

  const team = state.team
  const busy = state.busy.has(conversation.id)
  const project = conversation.projectId ? state.projects.find((p) => p.id === conversation.projectId) : undefined
  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err))

  const menuItems = (conversationId: string): MenuItem[] => {
    const c = state.conversations.find((x) => x.id === conversationId)
    if (!c) return []
    const agentId = c.kind === 'dm' ? c.memberIds.find((id) => id !== 'user') : undefined
    const agent = agentId ? team.agents.find((a) => a.id === agentId) : undefined
    const items: MenuItem[] = []
    items.push({ label: c.pinned ? t('menu.unpin') : t('menu.pin'), onClick: () => void updateConversation(c.id, { pinned: !c.pinned }).catch(fail) })
    items.push({
      label: t('menu.markUnread'),
      onClick: () => {
        markUnread(c.id)
        if (latest.current.activeId === c.id) setActiveId('group')
        setReadTick((t) => t + 1)
      },
    })
    if (c.id !== 'group') items.push({ label: c.hidden ? t('menu.unhide') : t('menu.hide'), onClick: () => void updateConversation(c.id, { hidden: !c.hidden }).catch(fail) })
    if (c.kind === 'group') items.push({ label: c.id === 'group' ? t('menu.rename') : t('menu.editChat'), onClick: () => setChatEditor(c) })
    if (agent) {
      items.push({ label: t('menu.editProfile'), divider: true, onClick: () => setProfile(agent.id) })
      items.push({ label: agent.muted ? t('menu.unmute') : t('menu.mute'), onClick: () => void updateAgent(agent.id, { muted: !agent.muted }).catch(fail) })
      items.push({ label: t('menu.duplicate'), onClick: () => void duplicateAgent(agent.id).then(({ agent: copy }) => setProfile(copy.id)).catch(fail) })
    }
    items.push({ label: t('menu.export'), divider: true, onClick: () => window.open(exportUrl(c.id), '_blank') })
    items.push({ label: t('menu.clear'), onClick: () => void clearConversation(c.id).catch(fail) })
    const proj = c.projectId ? state.projects.find((p) => p.id === c.projectId) : undefined
    if (proj && !proj.archived) {
      items.push({ label: t('menu.archive'), danger: true, divider: true, onClick: () => void projectAction(proj.id, 'archive').catch(fail) })
    } else if (c.kind === 'group' && c.id !== 'group' && !c.projectId) {
      items.push({
        label: t('menu.deleteChat'),
        danger: true,
        divider: true,
        onClick: () => {
          void deleteConversation(c.id)
            .then(() => {
              if (latest.current.activeId === c.id) setActiveId('group')
            })
            .catch(fail)
        },
      })
    }
    if (agent) items.push({ label: t('menu.deleteEmployee'), danger: true, divider: true, onClick: () => setProfile(agent.id) })
    return items
  }

  const openChat = (id: string) => navigate({ view: 'chat', conversationId: id })
  const showOffice = (projectId?: string) => navigate(projectId ? { view: 'office', projectId } : { view: 'office' })
  const counts = state.accountUsage ? usageCounts(state.accountUsage) : { low: 0, attention: 0 }
  const usageLine = counts.low ? t('quota.lowCount', { n: counts.low }) : counts.attention ? t('quota.attention', { n: counts.attention }) : ''

  return (
    <div className={`app${navOpen ? ' is-nav-open' : ''}`}>
      {navOpen && <button type="button" className="nav-scrim" aria-label={t('nav.closeSidebar')} onClick={() => setNavOpen(false)} />}
      <Sidebar
        team={team}
        conversations={state.conversations}
        activeId={view === 'chat' ? conversation.id : ''}
        busy={state.busy}
        approvals={state.approvals}
        readTick={readTick}
        onSelect={openChat}
        officeActive={view === 'office'}
        onOffice={() => showOffice()}
        usageActive={view === 'usage'}
        onUsage={() => navigate({ view: 'usage' })}
        usageLine={usageLine}
        activity={state.activity}
        connected={state.connected}
        onMenu={(id, x, y) => setMenu({ conversationId: id, x, y })}
        onSettings={() => setSettings('general')}
        onNewChat={() => setChatEditor(null)}
        onNewProject={() => setNewProject(true)}
        onSearch={() => setSearch(true)}
        projects={state.projects}
      />
      <main className="main">
        <button type="button" className="nav-toggle" aria-label={t('nav.openSidebar')} aria-expanded={navOpen} onClick={() => setNavOpen(true)}>
          <span aria-hidden="true">☰</span>
        </button>
        {view === 'usage' ? (
          <Usage
            report={state.accountUsage}
            {...(usageFocus ? { focus: usageFocus } : {})}
            clockOffset={state.clockOffset}
            onReport={(report) => dispatch({ type: 'accountUsage', report })}
            onEditAgent={(id) => setProfile(id)}
            onProviders={() => setSettings('providers')}
            onError={fail}
          />
        ) : view === 'office' ? (
          <Office
            team={team}
            conversations={state.conversations}
            projects={state.projects}
            activity={state.activity}
            ledger={state.ledger}
            providerChecks={state.providerChecks}
            approvals={state.approvals}
            connected={state.connected}
            clockOffset={state.clockOffset}
            filter={officeFilter}
            onFilter={setOfficeFilter}
            onOpenChat={openChat}
            companion={<DshPetPanel team={team} projects={state.projects} {...(upstream.pet ? { upstream: upstream.pet } : {})} {...(upstream.error ? { upstreamError: upstream.error } : {})} onStatus={setPet} />}
          />
        ) : (
          <>
            <ChatView
              team={team}
              conversation={conversation}
              typing={state.typing.get(conversation.id) ?? new Set()}
              usage={state.usage}
              approvals={state.approvals}
              jumpTo={jumpTo}
              onEditAgent={(id) => setProfile(id)}
              onReply={setReplyTo}
              profileOpen={profile !== undefined}
              {...(project ? { project } : {})}
              activity={state.activity}
              busy={busy}
            />
            <Composer
              team={team}
              conversation={conversation}
              busy={busy}
              replyTo={replyTo}
              onClearReply={() => setReplyTo(null)}
              onSend={async (body) => {
                await sendMessageFull(conversation.id, body)
              }}
              onStop={() => void stopRound(conversation.id)}
              onCorrect={async (text, mode) => {
                const { correction } = await correct(conversation.id, text, mode)
                dispatch({ type: 'event', event: { type: 'correction', correction } })
              }}
              {...(state.corrections.get(conversation.id) ? { correction: state.corrections.get(conversation.id) } : {})}
              onResumeCorrection={(id) => void resumeCorrection(id).catch(fail)}
            />
          </>
        )}
        {!state.connected && <div className="offline">{t('app.reconnecting')}</div>}
        {error && (
          <div className="toast" role="alert">
            <span>{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label={t('app.dismiss')}>
              ×
            </button>
          </div>
        )}
      </main>
      {/* The upstream dsh-pet overlay (its own animation, drag, menu and multi-pet runtime). */}
      <QuotaDock
        report={state.accountUsage}
        clockOffset={state.accountUsage ? state.accountUsage.serverNow - Date.now() : 0}
        onOpenUsage={() => { setView('usage'); setUsageFocus(undefined) }}
        onOpenNative={bridge ? () => { void bridge.openQuota() } : undefined}
      />
      {petRunning && pet?.settings.overlay && profile === undefined && chatEditor === undefined && !newProject && !settings && !template && upstream.pet?.Overlay && <upstream.pet.Overlay />}
      {profile !== undefined && (
        <Profile
          team={team}
          agentId={profile}
          usage={profile ? state.usage.byAgent[profile] : undefined}
          onClose={() => setProfile(undefined)}
          onSaved={(id) => {
            setProfile(id)
            if (profile === null) setActiveId(`dm-${id}`)
          }}
        />
      )}
      {settings && (
        <Settings
          team={team}
          routines={state.routines}
          conversations={state.conversations}
          usage={state.usage}
          account={state.account}
          section={settings}
          onSection={setSettings}
          onClose={() => setSettings(null)}
          onEditAgent={(id) => {
            setSettings(null)
            setProfile(id)
          }}
          onAddTeam={() => setTemplate(true)}
        />
      )}
      {chatEditor !== undefined && (
        <NewChat
          team={team}
          {...(chatEditor ? { conversation: chatEditor } : {})}
          onDone={(id) => {
            setChatEditor(undefined)
            if (id) openChat(id)
          }}
        />
      )}
      {search && (
        <Search
          team={team}
          conversations={state.conversations}
          onClose={() => setSearch(false)}
          onPick={(conversationId, messageId) => {
            setSearch(false)
            openChat(conversationId)
            setJumpTo(messageId ? `${messageId}` : null)
            if (messageId) setTimeout(() => setJumpTo(messageId), 50)
          }}
        />
      )}
      {newProject && (
        <NewProject
          team={team}
          onAddTeam={() => setTemplate(true)}
          onDone={(id) => {
            setNewProject(false)
            if (id) openChat(id)
          }}
        />
      )}
      {template && <TeamTemplate team={team} onClose={() => setTemplate(false)} />}
      {menu && <Menu x={menu.x} y={menu.y} items={menuItems(menu.conversationId)} onClose={() => setMenu(null)} />}
    </div>
  )
}
