// Pure presentation logic for the office view and the desktop pet, shared by the browser client,
// the Electron overlay and the server tests. Everything here is derived from real AgentActivity
// reports; nothing invents activity.
import type { AgentActivity, AgentActivityState, AgentLedgerDay, LedgerBucket, ProviderCheck, ToolKind } from './types.js'

/** What the office card and the pet show. Finer than AgentActivityState where evidence exists. */
export type Presence =
  | 'thinking'
  | 'coding'
  | 'command'
  | 'reading'
  | 'browsing'
  | 'tool'
  | 'stalled'
  | 'queued'
  | 'waiting-approval'
  | 'waiting-dependency'
  | 'waiting-user'
  | 'replied'
  | 'done'
  | 'failed'
  | 'interrupted'
  | 'idle'
  | 'offline'
  | 'unknown'

/** How a presence should be treated: ok (working or done), wait (legitimate waiting), attention (needs you), problem, quiet (idle), unknown. */
export type Tone = 'working' | 'wait' | 'attention' | 'problem' | 'quiet' | 'unknown' | 'done'

export const PRESENCE_LABEL: Record<Presence, string> = {
  thinking: 'Thinking',
  coding: 'Editing files',
  command: 'Running a command',
  reading: 'Reading files',
  browsing: 'Browsing the web',
  tool: 'Using a tool',
  stalled: 'No recent activity',
  queued: 'Queued · next in line',
  'waiting-approval': 'Waiting for your approval',
  'waiting-dependency': 'Waiting for a prerequisite',
  'waiting-user': 'Waiting for you',
  replied: 'Replied',
  done: 'Task accepted',
  failed: 'Last turn failed',
  interrupted: 'Interrupted',
  idle: 'Idle · nothing assigned',
  offline: 'Provider unavailable',
  unknown: 'Unknown',
}

/** A short non-colour marker for each presence (screen readers get the label). */
export const PRESENCE_GLYPH: Record<Presence, string> = {
  thinking: '…',
  coding: '✎',
  command: '>_',
  reading: '¶',
  browsing: '@',
  tool: '⚙',
  stalled: '?',
  queued: '›',
  'waiting-approval': '!',
  'waiting-dependency': '⧗',
  'waiting-user': '?',
  replied: '↩',
  done: '✓',
  failed: '✕',
  interrupted: '‖',
  idle: '–',
  offline: '⏻',
  unknown: '·',
}

export const PRESENCE_TONE: Record<Presence, Tone> = {
  thinking: 'working',
  coding: 'working',
  command: 'working',
  reading: 'working',
  browsing: 'working',
  tool: 'working',
  stalled: 'problem',
  queued: 'wait',
  'waiting-approval': 'attention',
  'waiting-dependency': 'wait',
  'waiting-user': 'attention',
  // A reply is not a delivered task: no success tone and no celebration.
  replied: 'quiet',
  done: 'done',
  failed: 'problem',
  interrupted: 'problem',
  idle: 'quiet',
  offline: 'problem',
  unknown: 'unknown',
}

/** A live turn with nothing from the provider for this long is shown as "no recent activity". */
export const STALL_AFTER_MS = 5 * 60_000

/**
 * Classify a tool activity line ("Write src/a.ts", "Bash npm test", "Fetching https://…") by its
 * leading tool name. Returns null for lines that are not tool calls (the API adapter's "Thinking…").
 */
export function classifyToolLine(line: string): ToolKind | null {
  const t = line.trim()
  if (!t || /^thinking/i.test(t)) return null
  const word = t.split(/[\s:]/, 1)[0] ?? ''
  if (['Write', 'Edit', 'Edited', 'MultiEdit', 'NotebookEdit'].includes(word)) return 'file'
  if (word === 'Bash') return 'command'
  if (['Read', 'Glob', 'Grep', 'LS'].includes(word)) return 'read'
  if (['Fetching', 'Searching', 'WebFetch', 'WebSearch'].includes(word)) return 'web'
  return 'other'
}

const TOOL_PRESENCE: Record<ToolKind, Presence> = { file: 'coding', command: 'command', read: 'reading', web: 'browsing', other: 'tool' }

const STATE_PRESENCE: Record<Exclude<AgentActivityState, 'tool'>, Presence> = {
  thinking: 'thinking',
  queued: 'queued',
  'waiting-approval': 'waiting-approval',
  'waiting-dependency': 'waiting-dependency',
  'waiting-user': 'waiting-user',
  replied: 'replied',
  done: 'done',
  error: 'failed',
  interrupted: 'interrupted',
  idle: 'idle',
  offline: 'offline',
}

export interface PresenceView {
  presence: Presence
  tone: Tone
  /** Readable state text, never colour only. */
  label: string
  /** The latest tool line or reason, when there is one. */
  detail?: string
  /** True while a provider turn is running (thinking, a tool, an approval, or a suspected stall). */
  live: boolean
  /** Milliseconds since the provider last produced anything, for live turns. */
  quietFor?: number
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

/**
 * Map one activity report to what is shown. `undefined` (never reported) and a lost connection are
 * "unknown", never idle. A live turn that has been quiet for `stallMs` is "no recent activity": a
 * suspected stall, not a claim that the model stopped.
 */
export function presenceOf(a: AgentActivity | undefined, now: number, opts: { connected?: boolean; stallMs?: number } = {}): PresenceView {
  if (opts.connected === false) {
    return { presence: 'unknown', tone: 'unknown', label: 'Unknown · connection lost', ...(a ? { detail: `Last known: ${presenceOf(a, now).label}` } : {}), live: false }
  }
  if (!a) return { presence: 'unknown', tone: 'unknown', label: 'Unknown · no report yet', live: false }
  const live = a.state === 'thinking' || a.state === 'tool' || a.state === 'waiting-approval'
  const detail = a.detail ? { detail: a.detail } : {}
  if (live) {
    const quietFor = Math.max(0, now - (a.lastEventAt ?? a.since))
    // Waiting for your approval is legitimately quiet; only thinking and tools can stall.
    if (a.state !== 'waiting-approval' && quietFor >= (opts.stallMs ?? STALL_AFTER_MS)) {
      return { presence: 'stalled', tone: 'problem', label: `No recent activity for ${formatDuration(quietFor)}`, ...detail, live, quietFor }
    }
    const presence = a.state === 'tool' ? TOOL_PRESENCE[a.toolKind ?? classifyToolLine(a.detail ?? '') ?? 'other'] : STATE_PRESENCE[a.state]
    return { presence, tone: PRESENCE_TONE[presence], label: PRESENCE_LABEL[presence], ...detail, live, quietFor }
  }
  const presence = STATE_PRESENCE[a.state as Exclude<AgentActivityState, 'tool'>] ?? 'unknown'
  return { presence, tone: PRESENCE_TONE[presence], label: PRESENCE_LABEL[presence], ...(a.state === 'idle' ? {} : detail), live: false }
}

// ---------- today's time accounting ----------

export const LEDGER_TIMELINE = 48

export function bucketOf(state: AgentActivityState): LedgerBucket {
  switch (state) {
    case 'thinking':
    case 'tool':
    case 'replied':
    case 'done':
      return 'working'
    case 'queued':
    case 'waiting-approval':
    case 'waiting-dependency':
    case 'waiting-user':
      return 'waiting'
    case 'idle':
      return 'idle'
    default:
      return 'problem'
  }
}

/** Local calendar day of a timestamp, YYYY-MM-DD. */
export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function startOfLocalDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Totals including the still-running segment up to `now`. A ledger from another day counts nothing. */
export function ledgerTotals(day: AgentLedgerDay | undefined, now: number): Record<LedgerBucket, number> & { observed: number } {
  const out = { working: 0, waiting: 0, idle: 0, problem: 0, observed: 0 }
  if (!day || day.day !== localDay(now)) return out
  for (const k of ['working', 'waiting', 'idle', 'problem'] as const) out[k] = day.totals[k]
  if (day.open && now > day.open.since) out[day.open.bucket] += now - day.open.since
  out.observed = out.working + out.waiting + out.idle + out.problem
  return out
}

// ---------- provider status ----------

/** Provider reachability as last probed. Not probed = unknown, never assumed reachable. */
export function providerLine(check: ProviderCheck | undefined, now: number): { state: 'ok' | 'down' | 'unknown'; text: string } {
  if (!check) return { state: 'unknown', text: 'Not checked yet' }
  const ago = `${formatDuration(now - check.at)} ago`
  return check.ok ? { state: 'ok', text: `Reachable (checked ${ago})` } : { state: 'down', text: `Unavailable: ${check.detail} (checked ${ago})` }
}

// ---------- follow targets and deep links ----------

const ID = /^[A-Za-z0-9_-]{1,80}$/

export type FollowTarget = { kind: 'team' } | { kind: 'agent'; id: string } | { kind: 'project'; id: string }

export function followKey(t: FollowTarget): string {
  return t.kind === 'team' ? 'team' : `${t.kind}:${t.id}`
}

/** Parse a stored follow target. Anything malformed falls back to the whole team. */
export function parseFollow(raw: unknown): FollowTarget {
  if (typeof raw !== 'string') return { kind: 'team' }
  const m = /^(agent|project):(.+)$/.exec(raw)
  if (m && m[2] && ID.test(m[2])) return { kind: m[1] as 'agent' | 'project', id: m[2] }
  return { kind: 'team' }
}

/** Places inside the app a pet or a notification may open. Nothing else is reachable through a link. */
export type AppLink =
  | { view: 'chat'; conversationId: string }
  | { view: 'office'; projectId?: string }
  | { view: 'approval'; conversationId: string }
  /** The account usage page; `focus` is an account key, provider id or employee id to scroll to. */
  | { view: 'usage'; focus?: string }

export function linkToHash(link: AppLink): string {
  if (link.view === 'office') return link.projectId ? `#/office/${link.projectId}` : '#/office'
  if (link.view === 'usage') return link.focus ? `#/usage/${link.focus}` : '#/usage'
  return `#/${link.view}/${link.conversationId}`
}

/**
 * Validate a deep link: either a `#/…` hash or a `{view, …}` object. Only the allow-listed views,
 * with plain ids, are accepted; URLs, other schemes, paths, query strings and odd characters are refused.
 */
export function parseAppLink(raw: unknown): AppLink | null {
  if (typeof raw === 'string') {
    if (raw.length > 120) return null
    const m = /^#\/(chat|office|approval|usage)(?:\/([A-Za-z0-9_-]{1,80}))?$/.exec(raw)
    if (!m) return null
    const view = m[1]
    const id = m[2]
    if (view === 'office') return id ? { view, projectId: id } : { view }
    if (view === 'usage') return id ? { view, focus: id } : { view }
    return id ? { view: view as 'chat' | 'approval', conversationId: id } : null
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (o.view === 'office') {
    if (keys.some((k) => k !== 'view' && k !== 'projectId')) return null
    if (o.projectId === undefined) return { view: 'office' }
    return typeof o.projectId === 'string' && ID.test(o.projectId) ? { view: 'office', projectId: o.projectId } : null
  }
  if (o.view === 'usage') {
    if (keys.some((k) => k !== 'view' && k !== 'focus')) return null
    if (o.focus === undefined) return { view: 'usage' }
    return typeof o.focus === 'string' && ID.test(o.focus) ? { view: 'usage', focus: o.focus } : null
  }
  if (o.view === 'chat' || o.view === 'approval') {
    if (keys.some((k) => k !== 'view' && k !== 'conversationId')) return null
    return typeof o.conversationId === 'string' && ID.test(o.conversationId) ? { view: o.view, conversationId: o.conversationId } : null
  }
  return null
}

// ---------- what the pet shows ----------

export interface FocusAgent {
  id: string
  name: string
  role: string
  color: string
  shape: string
}

export interface FocusProject {
  id: string
  name: string
  conversationId: string
  tasks: { id: string; title: string }[]
}

export interface FocusInput {
  target: FollowTarget
  agents: FocusAgent[]
  activity: Map<string, AgentActivity> | AgentActivity[]
  projects: FocusProject[]
  /** Pending approvals: who and where. */
  approvals: { conversationId: string; agentId: string; tool: string }[]
  now: number
  connected: boolean
  stallMs?: number
}

export interface PetFocus {
  /** The employee shown, when there is one. */
  agent?: FocusAgent
  view: PresenceView
  /** When the shown employee entered the reported state. */
  since?: number
  /** e.g. "T-3 · Build the login form" */
  task?: string
  projectName?: string
  /** Where clicking the pet goes. */
  link: AppLink
  /** Something that needs you (approval, failure, question), with where to act. */
  attention?: { text: string; link: AppLink }
  /** Team or project view: how many employees are in each tone. */
  counts?: Partial<Record<Tone, number>>
  /** Short title: the employee name, the project name, or "Team". */
  title: string
}

// Lower = more important to show.
const PRIORITY: Record<Tone, number> = { attention: 0, problem: 1, working: 2, done: 3, wait: 4, quiet: 5, unknown: 6 }

/**
 * Decide what the pet shows for a follow target. For the team or a project it picks the most
 * important employee: someone who needs you, then a problem, then the most recently active worker.
 */
export function petFocus(input: FocusInput): PetFocus {
  const acts = input.activity instanceof Map ? input.activity : new Map(input.activity.map((a) => [a.agentId, a]))
  const projectOf = (id: string | undefined) => (id ? input.projects.find((p) => p.id === id) : undefined)
  const viewFor = (agentId: string) => presenceOf(acts.get(agentId), input.now, { connected: input.connected, ...(input.stallMs ? { stallMs: input.stallMs } : {}) })

  const describe = (agent: FocusAgent, title: string, counts?: Partial<Record<Tone, number>>): PetFocus => {
    const a = acts.get(agent.id)
    const view = viewFor(agent.id)
    const project = projectOf(a?.projectId)
    const taskTitle = a?.taskRef ? project?.tasks.find((t) => t.id === a.taskRef)?.title : undefined
    const link: AppLink = a?.conversationId && ID.test(a.conversationId) ? { view: 'chat', conversationId: a.conversationId } : project ? { view: 'chat', conversationId: project.conversationId } : { view: 'office' }
    const approval = input.approvals.find((r) => r.agentId === agent.id)
    let attention: PetFocus['attention']
    if (approval && ID.test(approval.conversationId)) attention = { text: `${agent.name} needs your approval: ${approval.tool}`, link: { view: 'approval', conversationId: approval.conversationId } }
    else if (view.tone === 'attention' || view.tone === 'problem') attention = { text: `${agent.name}: ${view.label}${view.detail ? ` · ${view.detail}` : ''}`, link: project ? { view: 'chat', conversationId: project.conversationId } : { view: 'office' } }
    return {
      agent,
      view,
      ...(a ? { since: a.since } : {}),
      ...(a?.taskRef ? { task: taskTitle ? `${a.taskRef} · ${taskTitle}` : a.taskRef } : {}),
      ...(project ? { projectName: project.name } : {}),
      link,
      ...(attention ? { attention } : {}),
      ...(counts ? { counts } : {}),
      title,
    }
  }

  if (input.target.kind === 'agent') {
    const id = input.target.id
    const agent = input.agents.find((a) => a.id === id)
    if (agent) return describe(agent, agent.name)
    return { view: { presence: 'unknown', tone: 'unknown', label: 'Unknown · that employee is not on the team', live: false }, link: { view: 'office' }, title: 'Unknown employee' }
  }

  const project = input.target.kind === 'project' ? projectOf(input.target.id) : undefined
  if (input.target.kind === 'project' && !project) {
    return { view: { presence: 'unknown', tone: 'unknown', label: 'Unknown · that project is not open', live: false }, link: { view: 'office' }, title: 'Unknown project' }
  }
  const pool = project ? input.agents.filter((a) => acts.get(a.id)?.projectId === project.id) : input.agents
  const counts: Partial<Record<Tone, number>> = {}
  for (const a of pool) {
    const tone = viewFor(a.id).tone
    counts[tone] = (counts[tone] ?? 0) + 1
  }
  const title = project ? project.name : 'Team'
  const officeLink: AppLink = project ? { view: 'office', projectId: project.id } : { view: 'office' }
  const ranked = [...pool].sort((x, y) => {
    const vx = viewFor(x.id)
    const vy = viewFor(y.id)
    const d = PRIORITY[vx.tone] - PRIORITY[vy.tone]
    if (d !== 0) return d
    const lx = acts.get(x.id)?.lastEventAt ?? acts.get(x.id)?.since ?? 0
    const ly = acts.get(y.id)?.lastEventAt ?? acts.get(y.id)?.since ?? 0
    return ly - lx
  })
  const top = ranked[0]
  if (!top) {
    const label = !input.connected ? 'Unknown · connection lost' : project ? 'Nobody is on this project right now' : 'No employees yet'
    return { view: { presence: input.connected && project ? 'idle' : 'unknown', tone: input.connected && project ? 'quiet' : 'unknown', label, live: false }, link: officeLink, counts, title }
  }
  const focus = describe(top, title, counts)
  // From the team or project view, clicking the pet opens the office unless someone needs you.
  return { ...focus, link: focus.attention ? focus.attention.link : officeLink }
}

// ---------- browser pet preferences ----------

export interface PetPrefs {
  visible: boolean
  /** 0.5 to 2. */
  scale: number
  /** followKey() of the target. */
  follow: string
  /** Animations off (in addition to the system's reduced-motion setting). */
  paused: boolean
  /** Position as fractions of the viewport (0..1), so a resized window keeps it on screen. */
  x: number
  y: number
}

export const DEFAULT_PET_PREFS: PetPrefs = { visible: true, scale: 1, follow: 'team', paused: false, x: 0.92, y: 0.86 }

export function clampScale(v: unknown, fallback = 1): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback
  return Math.round(Math.min(2, Math.max(0.5, n)) * 100) / 100
}

const fraction = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback)

/** Accept stored or edited preferences; every field is checked and falls back to the default. */
export function sanitizePetPrefs(raw: unknown): PetPrefs {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  return {
    visible: typeof o.visible === 'boolean' ? o.visible : DEFAULT_PET_PREFS.visible,
    scale: clampScale(o.scale, DEFAULT_PET_PREFS.scale),
    follow: followKey(parseFollow(o.follow)),
    paused: typeof o.paused === 'boolean' ? o.paused : DEFAULT_PET_PREFS.paused,
    x: fraction(o.x, DEFAULT_PET_PREFS.x),
    y: fraction(o.y, DEFAULT_PET_PREFS.y),
  }
}

/** Events on the overlay's filtered stream (/api/activity/events). */
export type ActivityStreamEvent =
  | { type: 'activity'; activity: AgentActivity; ledger?: AgentLedgerDay }
  | { type: 'providers'; checks: Record<string, ProviderCheck> }
  /** Something the snapshot holds changed (projects, approvals, team); refetch it. */
  | { type: 'changed' }
