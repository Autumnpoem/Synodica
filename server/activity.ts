import { classifyToolLine, type ActivityStreamEvent } from '../shared/presence.js'
import type { ActivitySnapshot, AgentActivity, AgentActivityState, AgentLedgerDay, ApprovalRequest, Project, ProviderCheck, ProviderStatus, ServerEvent, Team, ToolKind } from '../shared/types.js'
import { realClock, type ActivityLedger, type Clock } from './ledger.js'

interface Live {
  state: 'thinking' | 'tool' | 'waiting-approval'
  conversationId: string
  projectId?: string
  taskRef?: string
  detail?: string
  toolKind?: ToolKind
  /** When the provider last produced anything. */
  lastEventAt: number
  /** The lastEventAt value last reported to clients (deltas are reported at most every DELTA_REPORT_MS). */
  reportedEventAt: number
}

interface Done {
  /** "replied": a turn posted a reply. "done": a task this employee owns was accepted. */
  state: 'replied' | 'done'
  until: number
  detail: string
  conversationId?: string
  projectId?: string
  taskRef?: string
}

/** Streaming text refreshes "last activity" at most this often, so deltas do not flood the event stream. */
export const DELTA_REPORT_MS = 15_000
/** How long the server reports "replied" or "done" after the real event, when enabled. */
export const DONE_MS = 6_000

/**
 * How a provider turn ended. Only "replied" (a reply was posted) shows a transient state; a skip,
 * a Stop, a refused start or a session retry return to the derived idle / queued / waiting state.
 * A plain string is an error message ("Stopped." counts as stopped).
 */
export type TurnEnd = { outcome: 'replied' } | { outcome: 'skipped' } | { outcome: 'stopped' } | { outcome: 'retry' } | { outcome: 'failed'; error: string }

// ---------- the safe projection ----------
// Activity reaches the office, the pet overlay and /api/activity/*. Tool lines carry tool input
// (commands, file paths, queries, URLs) and errors carry arbitrary payloads, so the tracker keeps
// only a classified tool name or reason. The full lines stay in the project chat.

const MAX_DETAIL = 80
const TOOL_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Read', 'Glob', 'Grep', 'LS'])
const HOST = /^[a-z0-9.-]{1,63}$/i

/** The web host of the first http(s) URL in a line: no credentials, port, path, query or fragment. */
function hostOf(line: string): string | undefined {
  const m = /\bhttps?:\/\/[^\s'"<>]+/i.exec(line)
  if (!m) return undefined
  try {
    const host = new URL(m[0]).hostname
    return HOST.test(host) ? host : undefined
  } catch {
    return undefined
  }
}

/**
 * The presentation detail of a tool line: the tool name only ("Bash", "Write"), "Fetching <host>"
 * for web fetches, or a fixed phrase. Command arguments, paths, patterns and queries are dropped.
 */
export function safeToolDetail(line: string): string {
  const word = line.trim().split(/[\s:]/, 1)[0] ?? ''
  if (word === 'Fetching' || word === 'WebFetch') {
    const host = hostOf(line)
    return host ? `Fetching ${host}` : 'Fetching a web page'
  }
  if (word === 'Searching' || word === 'WebSearch') return 'Searching the web'
  if (word === 'Edited') return 'Edited files'
  if (TOOL_NAMES.has(word)) return word
  return 'Using a tool'
}

/** A tool name as shown for approvals: a plain identifier, or a generic phrase. */
export function safeToolName(tool: string): string {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,59}$/.test(tool) ? tool : 'a tool'
}

/**
 * Classify a turn error or provider probe failure into a fixed, credential-free reason. Raw
 * messages can carry URLs with keys, response bodies or command output, so none of their text is
 * copied except an HTTP status code.
 */
export function safeReason(raw: string, fallback: string): string {
  // URLs are not evidence of anything (a query may say "api_key"); classify the words around them.
  const s = String(raw ?? '').replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '<url>')
  if (/is writing in this folder/i.test(s)) return 'Did not start: another writer is using this folder'
  const http = /\bHTTP\s+(\d{3})\b/i.exec(s)
  if (http) return `HTTP ${http[1]}`
  if (/rate.?limit|too many requests|quota/i.test(s)) return 'Rate limited by the provider'
  if (/CLI not found|ENOENT|command not found/i.test(s)) return 'Provider CLI not found'
  if (/not logged in|log ?in|sign ?in|unauthori[sz]ed|forbidden|api.?key|authenticat/i.test(s)) return 'Not signed in or not authorized'
  if (/timed? ?out|ETIMEDOUT/i.test(s)) return 'Timed out'
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|could not reach|fetch failed|network/i.test(s)) return 'Could not reach the provider'
  if (/stream broke/i.test(s)) return 'The provider stream broke'
  if (/no base url/i.test(s)) return 'No base URL configured'
  return fallback
}

const TURN_FAILED = 'The turn failed · details in the chat'
const CHECK_FAILED = 'Check failed · details on the Providers page'

/** Only the documented AgentActivity fields, with the detail bounded. */
function publicActivity(a: AgentActivity): AgentActivity {
  return {
    agentId: a.agentId,
    state: a.state,
    since: a.since,
    ...(a.conversationId ? { conversationId: a.conversationId } : {}),
    ...(a.projectId ? { projectId: a.projectId } : {}),
    ...(a.taskRef ? { taskRef: a.taskRef } : {}),
    ...(a.detail ? { detail: a.detail.slice(0, MAX_DETAIL) } : {}),
    ...(a.lastActiveAt !== undefined ? { lastActiveAt: a.lastActiveAt } : {}),
    ...(a.toolKind ? { toolKind: a.toolKind } : {}),
    ...(a.lastEventAt !== undefined ? { lastEventAt: a.lastEventAt } : {}),
  }
}

function publicChecks(checks: Record<string, ProviderCheck>): Record<string, ProviderCheck> {
  return Object.fromEntries(Object.entries(checks).map(([id, c]) => [id, { ok: c.ok, detail: c.detail.slice(0, MAX_DETAIL), at: c.at }]))
}

export interface TrackerOptions {
  clock?: Clock
  ledger?: ActivityLedger
  /** Length of the transient "done" state after a real completion. 0 (the default) turns it off. */
  doneMs?: number
}

/**
 * What an employee is doing when no provider turn is running, derived from the task board.
 * Distinguishes unassigned time (idle) from legitimate waiting and from real failure. Exported for tests.
 */
export function deriveIdleState(agentId: string, projects: Project[]): { state: AgentActivityState; projectId?: string; taskRef?: string; detail?: string } {
  const open = projects.filter((p) => !p.archived)
  const find = (pred: (p: Project, t: Project['tasks'][number]) => boolean) => {
    for (const p of open) for (const t of p.tasks) if (pred(p, t)) return { p, t }
    return undefined
  }
  const interrupted = find((_p, t) => t.state === 'interrupted' && (t.ownerId === agentId || (t.resumeTo === 'implemented' && t.reviewerId === agentId)))
  // Task reasons can quote findings, errors or questions; the board shows them, the projection does not.
  if (interrupted) return { state: 'interrupted', projectId: interrupted.p.id, taskRef: interrupted.t.id, detail: `${interrupted.t.id} was interrupted` }
  const user = find((_p, t) => t.ownerId === agentId && (t.state === 'failed' || (t.state === 'blocked' && t.blockedOn === 'user')))
  if (user) return { state: 'waiting-user', projectId: user.p.id, taskRef: user.t.id, detail: user.t.state === 'failed' ? `${user.t.id} failed · needs you` : `${user.t.id} waits for you` }
  const queued = find((p, t) => !p.paused && ((t.ownerId === agentId && (t.state === 'ready' || t.state === 'rework')) || (t.reviewerId === agentId && t.state === 'implemented')))
  if (queued) return { state: 'queued', projectId: queued.p.id, taskRef: queued.t.id, detail: `${queued.t.id} is next in line` }
  const deps = find((_p, t) => t.ownerId === agentId && (t.state === 'waiting' || (t.state === 'blocked' && t.blockedOn === 'dependency')))
  if (deps) return { state: 'waiting-dependency', projectId: deps.p.id, taskRef: deps.t.id, detail: `${deps.t.id} waits for ${deps.t.dependsOn.join(', ')}` }
  return { state: 'idle' }
}

/**
 * What the desktop pet overlay loads: names, colours, task titles, approvals (who / where / which
 * tool) and activity. Never messages, briefs, tool inputs, provider URLs or keys.
 */
export function activitySnapshot(team: Team, projects: Project[], approvals: ApprovalRequest[], tracker: ActivityTracker, now = Date.now()): ActivitySnapshot {
  return {
    agents: team.agents.map((a) => ({ id: a.id, name: a.name, role: a.role, color: a.color, shape: a.shape, provider: a.provider, model: a.model, ...(a.avatar ? { avatar: a.avatar } : {}) })),
    providers: Object.fromEntries(Object.entries(team.providers).map(([id, p]) => [id, { kind: p.kind, label: p.label }])),
    projects: projects.filter((p) => !p.archived).map((p) => ({ id: p.id, name: p.name, conversationId: p.conversationId, phase: p.phase, tasks: p.tasks.map((t) => ({ id: t.id, title: t.title, state: t.state, ownerId: t.ownerId, ...(t.reviewerId ? { reviewerId: t.reviewerId } : {}) })) })),
    approvals: approvals.map((r) => ({ id: r.id, conversationId: r.conversationId, agentId: r.agentId, tool: safeToolName(r.tool), createdAt: r.createdAt })),
    activity: tracker.list().map(publicActivity),
    ledger: tracker.ledgers(),
    providerChecks: publicChecks(tracker.providerChecks()),
    serverNow: now,
  }
}

/** The overlay stream's view of a server event: activity and provider checks, or a bare "changed". */
export function streamEventFor(event: ServerEvent): ActivityStreamEvent | undefined {
  if (event.type === 'activity') return event.ledger ? { type: 'activity', activity: publicActivity(event.activity), ledger: event.ledger } : { type: 'activity', activity: publicActivity(event.activity) }
  if (event.type === 'providers') return { type: 'providers', checks: publicChecks(event.checks) }
  if (event.type === 'project' || event.type === 'team' || event.type === 'approval:request' || event.type === 'approval:resolved') return { type: 'changed' }
  return undefined
}

/** Per-employee activity, fed only by real turn events, task state and provider probes. */
export class ActivityTracker {
  private readonly live = new Map<string, Live>()
  private readonly current = new Map<string, AgentActivity>()
  private readonly lastError = new Map<string, string>()
  private readonly lastActive = new Map<string, number>()
  private readonly done = new Map<string, Done>()
  private readonly doneTimers = new Map<string, unknown>()
  /** Task states seen on the last refresh, to detect real transitions to "accepted". */
  private readonly taskStates = new Map<string, string>()
  private offline = new Map<string, string>()
  private readonly checks = new Map<string, ProviderCheck>()
  private readonly clock: Clock
  private readonly doneMs: number

  constructor(
    private readonly getTeam: () => Team,
    private readonly getProjects: () => Project[],
    private readonly emit: (a: AgentActivity, ledger?: AgentLedgerDay) => void,
    private readonly opts: TrackerOptions = {},
  ) {
    this.clock = opts.clock ?? realClock
    this.doneMs = opts.doneMs ?? 0
  }

  list(): AgentActivity[] {
    this.refresh()
    return [...this.current.values()]
  }

  /** Today's ledger for every employee on the team. */
  ledgers(): AgentLedgerDay[] {
    return this.opts.ledger?.list(this.getTeam().agents.map((a) => a.id), this.clock.now()) ?? []
  }

  providerChecks(): Record<string, ProviderCheck> {
    return Object.fromEntries(this.checks)
  }

  turnStart(agentId: string, conversationId: string, projectId?: string, taskRef?: string): void {
    const now = this.clock.now()
    this.lastError.delete(agentId)
    this.clearDone(agentId)
    this.live.set(agentId, { state: 'thinking', conversationId, ...(projectId ? { projectId } : {}), ...(taskRef ? { taskRef } : {}), lastEventAt: now, reportedEventAt: now })
    this.refresh(agentId)
  }

  /** Streamed text arrived. Reported at most every DELTA_REPORT_MS. */
  delta(agentId: string): void {
    const l = this.live.get(agentId)
    if (!l) return
    l.lastEventAt = this.clock.now()
    if (l.lastEventAt - l.reportedEventAt < DELTA_REPORT_MS) return
    l.reportedEventAt = l.lastEventAt
    this.refresh(agentId)
  }

  tool(agentId: string, line: string): void {
    const l = this.live.get(agentId)
    if (!l) return
    const now = this.clock.now()
    l.lastEventAt = now
    l.reportedEventAt = now
    const kind = classifyToolLine(line)
    if (kind === null) {
      // Not a tool call (the API adapter's "Thinking…" marker): the model is reasoning.
      l.state = 'thinking'
    } else {
      l.state = 'tool'
      l.detail = safeToolDetail(line)
      l.toolKind = kind
    }
    this.refresh(agentId)
  }

  waitingApproval(agentId: string, tool: string): void {
    const l = this.live.get(agentId)
    if (!l) return
    l.state = 'waiting-approval'
    l.detail = `Waiting for your approval: ${safeToolName(tool)}`
    l.lastEventAt = l.reportedEventAt = this.clock.now()
    this.refresh(agentId)
  }

  approvalResolved(agentId: string): void {
    const l = this.live.get(agentId)
    if (!l || l.state !== 'waiting-approval') return
    l.state = 'thinking'
    l.lastEventAt = l.reportedEventAt = this.clock.now()
    this.refresh(agentId)
  }

  /**
   * A provider turn ended. Only a posted reply shows the transient "replied" state; it says nothing
   * about the task (a handoff still waits for review). Task completion is "done", set only when the
   * task is really accepted (noticeAccepted). Skips, Stops, refusals and retries show nothing.
   */
  turnEnd(agentId: string, end: TurnEnd | string = { outcome: 'skipped' }): void {
    const how: TurnEnd = typeof end === 'string' ? (end === 'Stopped.' ? { outcome: 'stopped' } : { outcome: 'failed', error: end }) : end
    const l = this.live.get(agentId)
    this.live.delete(agentId)
    const now = this.clock.now()
    this.lastActive.set(agentId, now)
    if (how.outcome === 'failed') this.lastError.set(agentId, safeReason(how.error, TURN_FAILED))
    else if (l && (how.outcome === 'replied' || how.outcome === 'skipped')) {
      // A provider answered (a skip is an answer too): a real reachability signal for its provider.
      const agent = this.getTeam().agents.find((a) => a.id === agentId)
      if (agent && this.offline.has(agent.provider)) {
        this.offline.delete(agent.provider)
        this.checks.set(agent.provider, { ok: true, detail: 'A turn just completed', at: now })
      }
      if (how.outcome === 'replied') this.markDone(agentId, { state: 'replied', detail: l.taskRef ? `Replied on ${l.taskRef}` : 'Replied in the chat', conversationId: l.conversationId, ...(l.projectId ? { projectId: l.projectId } : {}), ...(l.taskRef ? { taskRef: l.taskRef } : {}) })
    }
    this.refresh(agentId)
  }

  /** Provider ids whose last status probe failed, with the reason. */
  setOffline(providers: Map<string, string>): void {
    this.offline = providers
    this.refresh()
  }

  /** Record a real status probe of every provider. Returns the checks for broadcasting. */
  providerStatuses(statuses: ProviderStatus[]): Record<string, ProviderCheck> {
    const now = this.clock.now()
    // Probe details can quote endpoints and error bodies; the full text stays on the Providers page.
    const detail = (s: ProviderStatus): string => (s.ok ? 'Reachable' : safeReason(s.detail, CHECK_FAILED))
    for (const s of statuses) this.checks.set(s.id, { ok: s.ok, detail: detail(s), at: now })
    this.setOffline(new Map(statuses.filter((s) => !s.ok).map((s) => [s.id, detail(s)])))
    return this.providerChecks()
  }

  /** Recompute one or all employees and emit what changed. */
  refresh(agentId?: string): void {
    const team = this.getTeam()
    const now = this.clock.now()
    const projects = this.getProjects()
    if (!agentId) this.noticeAccepted(projects)
    const ids = agentId ? [agentId] : team.agents.map((a) => a.id)
    for (const gone of [...this.current.keys()]) if (!team.agents.some((a) => a.id === gone)) this.current.delete(gone)
    for (const id of ids) {
      const agent = team.agents.find((a) => a.id === id)
      if (!agent) continue
      const live = this.live.get(id)
      const done = this.done.get(id)
      let next: Omit<AgentActivity, 'since'>
      if (live) {
        next = { agentId: id, state: live.state, conversationId: live.conversationId, ...(live.projectId ? { projectId: live.projectId } : {}), ...(live.taskRef ? { taskRef: live.taskRef } : {}), ...(live.detail ? { detail: live.detail } : {}), ...(live.state === 'tool' && live.toolKind ? { toolKind: live.toolKind } : {}), lastEventAt: live.reportedEventAt }
      } else if (done && done.until > now) {
        next = { agentId: id, state: done.state, detail: done.detail, ...(done.conversationId ? { conversationId: done.conversationId } : {}), ...(done.projectId ? { projectId: done.projectId } : {}), ...(done.taskRef ? { taskRef: done.taskRef } : {}) }
      } else if (this.offline.has(agent.provider)) {
        next = { agentId: id, state: 'offline', detail: this.offline.get(agent.provider) ?? 'provider unavailable' }
      } else if (this.lastError.has(id)) {
        next = { agentId: id, state: 'error', detail: this.lastError.get(id) ?? '' }
      } else {
        next = { agentId: id, ...deriveIdleState(id, projects) }
      }
      const last = this.lastActive.get(id)
      if (last) next.lastActiveAt = last
      const prev = this.current.get(id)
      if (prev && prev.state === next.state && prev.detail === next.detail && prev.taskRef === next.taskRef && prev.lastActiveAt === next.lastActiveAt && prev.lastEventAt === next.lastEventAt && prev.toolKind === next.toolKind) continue
      const activity: AgentActivity = { ...next, since: prev && prev.state === next.state ? prev.since : now }
      this.current.set(id, activity)
      const ledger = this.opts.ledger?.transition(id, activity.state, now)
      this.emit(activity, ledger)
    }
  }

  /** Stop pending timers (tests, shutdown). */
  dispose(): void {
    for (const t of this.doneTimers.values()) this.clock.clearTimeout(t)
    this.doneTimers.clear()
  }

  /** A task that moved to "accepted" since the last refresh is a real completion for its owner. */
  private noticeAccepted(projects: Project[]): void {
    const seen = new Set<string>()
    for (const p of projects) {
      for (const t of p.tasks) {
        const key = `${p.id}/${t.id}`
        seen.add(key)
        const before = this.taskStates.get(key)
        this.taskStates.set(key, t.state)
        if (before !== undefined && before !== 'accepted' && t.state === 'accepted' && !this.live.has(t.ownerId)) {
          this.markDone(t.ownerId, { state: 'done', detail: `${t.id} accepted`, conversationId: p.conversationId, projectId: p.id, taskRef: t.id })
        }
      }
    }
    for (const k of [...this.taskStates.keys()]) if (!seen.has(k)) this.taskStates.delete(k)
  }

  private markDone(agentId: string, d: Omit<Done, 'until'>): void {
    if (this.doneMs <= 0) return
    this.clearDone(agentId)
    const until = this.clock.now() + this.doneMs
    this.done.set(agentId, { ...d, until })
    this.doneTimers.set(
      agentId,
      this.clock.setTimeout(() => {
        this.doneTimers.delete(agentId)
        this.done.delete(agentId)
        this.refresh(agentId)
      }, this.doneMs),
    )
  }

  private clearDone(agentId: string): void {
    const t = this.doneTimers.get(agentId)
    if (t !== undefined) this.clock.clearTimeout(t)
    this.doneTimers.delete(agentId)
    this.done.delete(agentId)
  }
}
