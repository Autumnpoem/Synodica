import { randomUUID } from 'node:crypto'
import type { Account } from './account.js'
import type { ActivityTracker } from './activity.js'
import { providerKeepsSession, runAgentTurn } from './agent.js'
import { reviewByRules, type Approvals } from './approvals.js'
import { emit } from './events.js'
import { collectAttachments } from './files.js'
import type { Memory } from './memory.js'
import { canWrite, WorkspaceLocks } from './locks.js'
import { findMentions } from './mentions.js'
import { explicitDebate, explicitEveryone, routeSpeakers, type RouteMode } from './router.js'
import { part } from '../shared/notes.js'
import type { Store } from './store.js'
import { summarizeUsage } from './usage.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import { agentCwd } from './providers/types.js'
import type { TurnOutcome, TurnRequest } from './workflow.js'
import { renderNote } from '../shared/notes.js'
import type { Agent, Attachment, Conversation, Message, NotePart, ProviderDef, Routine, Team } from '../shared/types.js'

interface RoundState {
  running: boolean
  abort: AbortController | null
  pending: { message: Message; forced?: Agent[]; note?: string }[]
  active: Map<string, Set<AbortController>>
  suppressed: Set<string>
}

/**
 * Decide who speaks first for an owner message without the router (DMs, mentions, the
 * non-smart group modes). Returns null when the smart router should decide. Exported for tests.
 */
export function initialQueue(team: Team, conversation: Conversation, userText: string, replyTargetId?: string): Agent[] | null {
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  if (conversation.kind === 'dm') return members
  const mentioned = findMentions(userText, members)
  if (mentioned.length > 0) return mentioned
  const replyTarget = members.find((a) => a.id === replyTargetId)
  if (replyTarget) return [replyTarget]
  const unmuted = members.filter((a) => !a.muted)
  if (explicitEveryone(userText)) return unmuted
  if (unmuted.length >= 2 && explicitDebate(userText)) return unmuted
  if (team.settings.groupMode === 'mentions-only') return unmuted.slice(0, 1)
  if (team.settings.groupMode === 'everyone') return unmuted
  return null
}

/** Expand /skill-id tokens into the skill's instructions. Exported for tests. */
export function expandSkills(team: Team, text: string): string {
  return text.replace(/(^|\s)\/([a-z0-9_-]+)\b/g, (whole, lead: string, id: string) => {
    const skill = team.skills[id]
    if (!skill) return whole
    return `${lead}[Skill "${skill.name}": ${skill.body.trim()}]`
  })
}

/** Ordinary chats only: small, clear build requests may still be done right away. */
const BUILD_NOTE = 'Dispatcher: the boss asked for something to be made. If it is small and clear, build it now with your tools, then reply with the full path and one or two sentences. If it is a multi-part project or has real trade-offs, say so in one line and suggest starting a project (kickoff) instead of building in chat.'
const ROUTINE_NOTE = 'This is a scheduled routine, not a live chat. Do the job fully with your tools, then post the result here. If a source is unavailable, say so instead of guessing.'
const DEBATE_NOTE = 'Respond to another participant\'s latest argument with one new, concrete reason or objection. If nothing material remains, reply exactly [skip].'

const FALLBACK_PROVIDER: ProviderDef = { kind: 'claude', label: 'Claude (subscription)' }

export interface PostOptions {
  requestId?: string
  attachments?: Attachment[]
  replyTo?: Message['replyTo']
  /** Author id; defaults to the owner. Routines post as 'routine'. */
  authorId?: string
  /** Skip routing and make exactly these employees reply. */
  forced?: Agent[]
  note?: string
}

/** What a project chat contributes to every turn in it. */
export interface ProjectScope {
  id: string
  workspace: string
  context: string
}

export interface OrchestratorHooks {
  activity?: ActivityTracker
  /** Trusted canonical path for provider-readable attachments; absent in test-only orchestrators. */
  resolveAttachment?: (file: string) => string | undefined
  /** The project a conversation belongs to, with its shared context. */
  projectFor?: (conversationId: string) => ProjectScope | undefined
  /** An employee replied in a chat (the workflow applies the decision owner's team-task blocks). */
  onReply?: (conversationId: string, agentId: string, text: string) => void
  /** Provider dispatcher; tests inject simulated adapters here. */
  runner?: (params: RunTurnParams) => Promise<TurnResult>
  /** Writer locks shared with the workflow, so chat turns and workflow turns never write over each other. */
  locks?: WorkspaceLocks
}

interface TurnOptions {
  note?: string
  context?: string
  cwd?: string
  safe?: boolean
  /** No write, edit or shell tools (workflow review and planning steps). */
  readOnly?: boolean
  /** The workflow already holds the writer lock for this turn. */
  lockHeld?: boolean
  /** Separate provider session (reviews never continue an implementer's thread). */
  sessionScope?: 'work' | 'review'
  taskRef?: string
  projectId?: string
  /** User message that opened this chat round; absent for workflow-only turns. */
  inputMessageId?: string
  /** All opening speakers in a parallel round see the same owner-message transcript. */
  transcript?: Conversation
}

interface TurnReport {
  text: string
  error?: string
  messageId?: string
  activity: string[]
  /** The provider answered after the turn was stopped; the reply is recorded as superseded and `text` is ''. */
  superseded?: boolean
}

export class Orchestrator {
  private readonly rounds = new Map<string, RoundState>()
  /** Conversation id → tail of its turn chain. Chat rounds and workflow turns never overlap in one chat. */
  private readonly locks = new Map<string, Promise<void>>()
  private readonly taskTurns = new Set<string>()
  private readonly runner: (params: RunTurnParams) => Promise<TurnResult>
  private readonly writers: WorkspaceLocks

  constructor(
    private readonly getTeam: () => Team,
    private readonly store: Store,
    private readonly account: Account,
    private readonly approvals: Approvals,
    private readonly memory: Memory,
    /** Whether a file path may be shown in the chat (inside the workspace, an employee folder, a project, or uploads). */
    private readonly allowedFile: (p: string) => boolean,
    private readonly hooks: OrchestratorHooks = {},
  ) {
    this.runner = hooks.runner ?? runAgentTurn
    this.writers = hooks.locks ?? new WorkspaceLocks()
  }

  isBusy(conversationId: string): boolean {
    return (this.rounds.get(conversationId)?.running ?? false) || this.taskTurns.has(conversationId)
  }

  busyIds(): string[] {
    const ids = new Set([...this.rounds.entries()].filter(([, s]) => s.running).map(([id]) => id))
    for (const id of this.taskTurns) ids.add(id)
    return [...ids]
  }

  /** Post a message and start (or queue) a round of replies. */
  post(conversationId: string, text: string, opts: PostOptions = {}): Message {
    const conversation = this.store.get(conversationId)
    if (!conversation) throw new Error(`unknown conversation ${conversationId}`)
    const message: Message = {
      id: randomUUID(),
      conversationId,
      authorId: opts.authorId ?? 'user',
      text: expandSkills(this.getTeam(), text),
      createdAt: Date.now(),
      status: 'done',
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.requestId ? { requestId: opts.requestId } : {}),
    }
    this.store.addMessage(conversationId, message)
    emit({ type: 'message:done', message })

    const state = this.state(conversationId)
    const job = { message, ...(opts.forced ? { forced: opts.forced } : {}), ...(opts.note ? { note: opts.note } : {}) }
    if (state.running) state.pending.push(job)
    else void this.runRound(conversationId, job)
    return message
  }

  /**
   * A workflow line in a chat: recorded and shown, never starts a round. A structured note is stored
   * with its English rendering as the text, so the UI can show it in its own locale.
   */
  postNote(conversationId: string, text: string | NotePart[]): Message | undefined {
    if (!this.store.get(conversationId)) return undefined
    if (typeof text === 'string') return this.record(conversationId, text, { authorId: 'workflow' })
    return this.record(conversationId, renderNote('en', text), { authorId: 'workflow', note: text })
  }

  /** Record a message without starting a round (workflow commands, notes). */
  record(conversationId: string, text: string, opts: { authorId?: string; attachments?: Attachment[]; correctionId?: string; note?: NotePart[]; requestId?: string } = {}): Message {
    const message: Message = { id: randomUUID(), conversationId, authorId: opts.authorId ?? 'user', text, createdAt: Date.now(), status: 'done', ...(opts.requestId ? { requestId: opts.requestId } : {}), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}), ...(opts.correctionId ? { correctionId: opts.correctionId } : {}), ...(opts.note ? { note: opts.note } : {}) }
    this.store.addMessage(conversationId, message)
    emit({ type: 'message:done', message })
    return message
  }

  /** Run a routine: post its instruction as a routine message and make its owner reply. */
  async runRoutine(routine: Routine): Promise<{ messageId?: string }> {
    const team = this.getTeam()
    const agent = team.agents.find((a) => a.id === routine.agentId)
    if (!agent) throw new Error(`employee ${routine.agentId} no longer exists`)
    const conversation = this.store.get(routine.conversationId)
    if (!conversation) throw new Error(`conversation ${routine.conversationId} no longer exists`)
    if (!conversation.memberIds.includes(agent.id)) throw new Error(`${agent.name} is not in that conversation`)
    const before = conversation.messages.length
    this.post(routine.conversationId, `⏰ ${routine.name}\n${routine.instruction}`, { authorId: 'routine', forced: [agent], note: ROUTINE_NOTE })
    await this.waitForIdle(routine.conversationId)
    const reply = this.store.get(routine.conversationId)?.messages.slice(before + 1).find((m) => m.authorId === agent.id)
    if (!reply) return {}
    if (reply.status === 'error') throw new Error(reply.text.replace(/^⚠️\s*/, ''))
    if (reply.status === 'superseded') throw new Error('the routine was stopped before its reply arrived')
    return { messageId: reply.id }
  }

  /**
   * The workflow's turn runner: one employee turn in the project chat, streamed like any reply,
   * serialized with chat rounds, in the project workspace and without permission bypass.
   */
  runTaskTurn(req: TurnRequest): Promise<TurnOutcome> {
    const conversationId = req.project.conversationId
    return this.exclusive(conversationId, async () => {
      if (req.signal.aborted) return { text: '', error: 'Stopped.', activity: [] }
      this.taskTurns.add(conversationId)
      emit({ type: 'round', conversationId, running: true })
      try {
        const r = await this.turn(conversationId, req.agent, req.signal, { note: req.note, context: req.context, cwd: req.cwd, safe: true, readOnly: req.readOnly, lockHeld: true, sessionScope: req.sessionScope, taskRef: req.ref, projectId: req.project.id })
        return { text: r.text, activity: r.activity, ...(r.error ? { error: r.error } : {}), ...(r.messageId ? { messageId: r.messageId } : {}), ...(r.superseded ? { superseded: true } : {}) }
      } finally {
        this.taskTurns.delete(conversationId)
        if (!this.isBusy(conversationId)) emit({ type: 'round', conversationId, running: false })
      }
    })
  }

  stop(conversationId: string): void {
    const state = this.rounds.get(conversationId)
    if (!state) return
    state.pending = []
    state.abort?.abort()
  }

  /**
   * Interrupt for a correction: drop queued rounds, abort the running provider turn (adapters kill
   * their subprocess where they can), and report whether anything was running. The round loop checks
   * the aborted signal before every next speaker, so no further old employee is dispatched.
   */
  interrupt(conversationId: string): { wasRunning: boolean } {
    const state = this.rounds.get(conversationId)
    const wasRunning = this.isBusy(conversationId)
    if (state) {
      state.pending = []
      state.abort?.abort()
    }
    return { wasRunning }
  }

  /** Stop one employee's current and queued turns while the other participants continue. */
  interruptAgent(conversationId: string, agentId: string): { wasRunning: boolean } {
    const state = this.state(conversationId)
    const active = state.active.get(agentId)
    const wasRunning = (active?.size ?? 0) > 0
    if (state.running) state.suppressed.add(agentId)
    for (const controller of active ?? []) controller.abort()
    return { wasRunning }
  }

  /** Start a fresh round for an already recorded owner message (the corrected instruction). */
  replyTo(conversationId: string, message: Message, note?: string, targetAgentId?: string): void {
    const state = this.state(conversationId)
    const conversation = this.store.get(conversationId)
    const target = targetAgentId && this.getTeam().agents.find((a) => a.id === targetAgentId && conversation?.memberIds.includes(a.id))
    if (targetAgentId && !target) throw new Error(`unknown conversation member ${targetAgentId}`)
    const job = { message, ...(note ? { note } : {}), ...(target ? { forced: [target] } : {}) }
    if (state.running) state.pending.push(job)
    else void this.runRound(conversationId, job)
  }

  /** Runs a minimal Claude turn just to refresh the Claude account's rate-limit picture (Settings → Claude account). */
  async probeAccount(): Promise<void> {
    const team = this.getTeam()
    const base = team.agents[0]
    const probe: Agent = {
      ...(base ?? { id: 'x', name: 'X', role: 'X', color: '#fff', shape: 'blob', permissionMode: 'dontAsk', effort: 'low', personality: '', tools: [], mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, muted: false, model: '', provider: 'claude', approvals: 'auto' }),
      id: 'probe',
      name: 'PROBE',
      provider: 'claude',
      model: 'claude-haiku-4-5',
      effort: 'low',
      tools: [],
      mcpServers: [],
      inheritClaudeSettings: false,
      autoApproveTools: false,
      approvals: 'auto',
      personality: 'Reply with the single word OK.',
    }
    const conversation: Conversation = {
      id: 'probe',
      kind: 'dm',
      name: 'probe',
      memberIds: ['user', 'probe'],
      messages: [{ id: 'p', conversationId: 'probe', authorId: 'user', text: 'ping', createdAt: Date.now(), status: 'done' }],
      sessions: {},
    }
    await this.runner({
      team: { ...team, agents: [probe] },
      conversation,
      agent: probe,
      provider: team.providers.claude ?? FALLBACK_PROVIDER,
      sessionId: undefined,
      signal: new AbortController().signal,
      handlers: {
        onDelta: () => {},
        onActivity: () => {},
        onSession: () => {},
        onInit: (src, ver) => this.account.noteInit(src, ver),
        onRateLimit: (info) => this.account.noteRateLimit(info),
      },
    })
    emit({ type: 'account', account: this.account.get() })
  }

  /** Resolves when no chat round or workflow turn is running or queued in the conversation. */
  waitForIdle(conversationId: string): Promise<void> {
    return new Promise((resolve) => {
      const check = (): void => {
        const s = this.rounds.get(conversationId)
        if ((!s || (!s.running && s.pending.length === 0)) && !this.taskTurns.has(conversationId)) resolve()
        else setTimeout(check, 50)
      }
      check()
    })
  }

  private exclusive<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(conversationId) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.locks.set(conversationId, tail)
    void tail.then(() => {
      if (this.locks.get(conversationId) === tail) this.locks.delete(conversationId)
    })
    return run
  }

  private state(conversationId: string): RoundState {
    let s = this.rounds.get(conversationId)
    if (!s) {
      s = { running: false, abort: null, pending: [], active: new Map(), suppressed: new Set() }
      this.rounds.set(conversationId, s)
    }
    return s
  }

  private async runRound(conversationId: string, job: RoundState['pending'][number]): Promise<void> {
    const state = this.state(conversationId)
    state.running = true
    state.abort = new AbortController()
    const signal = state.abort.signal
    emit({ type: 'round', conversationId, running: true })
    const startIndex = this.store.get(conversationId)?.messages.length ?? 0
    const spoke = new Set<string>()
    try {
      await this.exclusive(conversationId, () => this.speakers(conversationId, job, signal, spoke))
    } finally {
      state.running = false
      state.abort = null
      state.active.clear()
      state.suppressed.clear()
      if (!this.isBusy(conversationId)) emit({ type: 'round', conversationId, running: false })
      this.remember(conversationId, startIndex - 1, spoke)
      const next = state.pending.shift()
      if (next) void this.runRound(conversationId, next)
    }
  }

  /** Background memory update for everyone who spoke this round, in the conversation's scope. */
  private remember(conversationId: string, fromIndex: number, spoke: Set<string>): void {
    const team = this.getTeam()
    const conversation = this.store.get(conversationId)
    if (!conversation || spoke.size === 0) return
    const recent = conversation.messages.slice(Math.max(0, fromIndex))
    for (const id of spoke) {
      const agent = team.agents.find((a) => a.id === id)
      if (agent) void this.memory.update(team, agent, recent, conversation.projectId)
    }
  }

  private async speakers(conversationId: string, job: RoundState['pending'][number], signal: AbortSignal, spoke: Set<string>): Promise<void> {
    const conversation = this.store.get(conversationId)
    if (!conversation) return
    const team = this.getTeam()
    const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
    const project = this.hooks.projectFor?.(conversationId)
    const quoted = conversation.messages.find((m) => m.id === job.message.replyTo?.messageId)
    const replyTargetId = quoted && quoted.authorId === job.message.replyTo?.authorId ? quoted.authorId : undefined
    let queue = job.forced ?? initialQueue(team, conversation, job.message.text, replyTargetId)
    const atEveryone = /(^|[^a-z0-9_])@everyone(?![a-z0-9_])/i.test(job.message.text)
    const mentions = findMentions(job.message.text, members)
    const exclusive = conversation.kind === 'dm' || job.forced !== undefined || (!atEveryone && (mentions.length === 1 || (mentions.length === 0 && replyTargetId !== undefined)))
    let mode: RouteMode = 'discuss'
    let routedEveryone = false
    if (queue === null) {
      const route = await routeSpeakers(team, conversation, job.message.text, signal)
      queue = route.speakers
      mode = route.mode
      routedEveryone = route.everyone === true
      console.log(`[router] ${conversation.id}: ${route.speakers.map((a) => a.name).join(', ') || 'nobody'} (${route.mode}) — ${route.why}`)
    }
    const everyone = !exclusive && (atEveryone || routedEveryone || explicitEveryone(job.message.text))
    if (everyone && atEveryone) queue = queue.filter((a) => !a.muted)
    const allMembersMode = team.settings.groupMode === 'everyone' && findMentions(job.message.text, members).length === 0
    const budget = everyone ? Math.min(12, Math.max(team.settings.maxMessagesPerRound, queue.length)) : allMembersMode ? Math.min(12, team.settings.maxMessagesPerRound) : team.settings.maxMessagesPerRound
    const debate = !exclusive && job.message.authorId === 'user' && queue.length >= 2 && explicitDebate(job.message.text)
    const participants = debate ? [...queue] : []
    const state = this.state(conversationId)
    const turns = new Map<string, number>()
    let count = 0
    let first = true

    const runSpeaker = async (agent: Agent, opts: TurnOptions): Promise<TurnReport> => {
      if (signal.aborted || state.suppressed.has(agent.id)) return { text: '', activity: [] }
      const controller = new AbortController()
      const onAbort = (): void => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let active = state.active.get(agent.id)
      if (!active) { active = new Set(); state.active.set(agent.id, active) }
      active.add(controller)
      try {
        return await this.turn(conversationId, agent, controller.signal, opts)
      } finally {
        active.delete(controller)
        if (active.size === 0) state.active.delete(agent.id)
        signal.removeEventListener('abort', onAbort)
      }
    }

    const followMentions = (agent: Agent, reply: string): void => {
      if (!reply || signal.aborted || this.state(conversationId).pending.length > 0) return
      if (project) this.hooks.onReply?.(conversationId, agent.id, reply)
      if (exclusive) return
      if (debate) {
        const index = participants.findIndex((p) => p.id === agent.id)
        const next = participants[(index + 1) % participants.length]
        if (next && !state.suppressed.has(next.id) && (turns.get(next.id) ?? 0) < team.settings.maxTurnsPerAgentPerRound && !queue.some((q) => q.id === next.id)) queue.push(next)
        return
      }
      for (const m of findMentions(reply, members, agent.id)) {
        if (state.suppressed.has(m.id)) continue
        const taken = turns.get(m.id) ?? 0
        if (taken >= team.settings.maxTurnsPerAgentPerRound) continue
        if (queue.some((q) => q.id === m.id)) continue
        queue.push(m)
      }
    }

    if (!exclusive && (everyone || allMembersMode) && queue.length > 1 && !signal.aborted && this.state(conversationId).pending.length === 0) {
      const opening = queue.splice(0, Math.min(queue.length, budget))
      const transcript = structuredClone(conversation)
      let writerTail: Promise<void> = Promise.resolve()
      const replies = opening.map((agent, index) => {
        count++
        turns.set(agent.id, (turns.get(agent.id) ?? 0) + 1)
        const buildNote = !project && index === 0 && mode === 'build' && canWrite(agent) ? BUILD_NOTE : undefined
        const note = index === 0 ? (job.note ?? buildNote) : undefined
        const opts: TurnOptions = { transcript, ...(job.message.authorId === 'user' ? { inputMessageId: job.message.id } : {}), ...(note ? { note } : {}), ...(project ? { context: project.context, cwd: project.workspace, safe: true, projectId: project.id } : {}) }
        const run = async (): Promise<string> => (await runSpeaker(agent, opts)).text
        if (!canWrite(agent)) return run()
        const reply = writerTail.then(() => signal.aborted || this.state(conversationId).pending.length > 0 ? '' : run())
        writerTail = reply.then(() => undefined, () => undefined)
        return reply
      })
      const settled = await Promise.allSettled(replies)
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) throw failed.reason
      const results = settled.map((r) => (r as PromiseFulfilledResult<string>).value)
      first = false
      for (let i = 0; i < opening.length; i++) {
        const agent = opening[i]
        const reply = results[i]
        if (!agent || !reply) continue
        spoke.add(agent.id)
        if (debate) {
          if (project) this.hooks.onReply?.(conversationId, agent.id, reply)
        } else followMentions(agent, reply)
      }
      if (debate && results.filter(Boolean).length >= 2 && !signal.aborted && state.pending.length === 0) {
        for (let i = 0; i < opening.length; i++) {
          const agent = opening[i]
          if (agent && results[i] && !state.suppressed.has(agent.id) && (turns.get(agent.id) ?? 0) < team.settings.maxTurnsPerAgentPerRound) queue.push(agent)
        }
      }
    }

    while (queue.length > 0 && count < budget && !signal.aborted) {
      const agent = queue.shift()
      if (!agent) break
      if (state.suppressed.has(agent.id)) continue
      // A newer owner message arrived mid-round: let the next round handle it with fresh context.
      if (this.state(conversationId).pending.length > 0) break
      count++
      turns.set(agent.id, (turns.get(agent.id) ?? 0) + 1)
      // Project chats run work through the task board, so no build-now nudge there.
      const buildNote = !project && first && mode === 'build' && agent.tools.some((t) => ['Edit', 'Write'].includes(t)) ? BUILD_NOTE : undefined
      const note = first ? (job.note ?? buildNote) : debate && (turns.get(agent.id) ?? 0) > 1 ? DEBATE_NOTE : undefined
      first = false
      const opts: TurnOptions = { ...(job.message.authorId === 'user' ? { inputMessageId: job.message.id } : {}), ...(note ? { note } : {}), ...(project ? { context: project.context, cwd: project.workspace, safe: true, projectId: project.id } : {}) }
      const reply = (await runSpeaker(agent, opts)).text
      if (reply) spoke.add(agent.id)
      // Interrupted (Stop or a correction): a late reply stays in the history but changes nothing.
      if (signal.aborted) break
      if (!reply) continue
      followMentions(agent, reply)
    }
    if (queue.length > 0 && count >= budget && !signal.aborted && this.state(conversationId).pending.length === 0) {
      this.postNote(conversationId, `Round limit reached; no turn was available for: ${[...new Set(queue.map((a) => a.name))].join(', ')}.`)
    }
    if (debate && !signal.aborted && state.pending.length === 0) this.postNote(conversationId, [part('note.discussionRoundComplete', { turns: count })])
  }

  /** Runs one agent turn, streaming into a message. text is '' if the agent skipped or failed. */
  private async turn(conversationId: string, agent: Agent, signal: AbortSignal, opts: TurnOptions = {}): Promise<TurnReport> {
    const conversation = this.store.get(conversationId)
    if (!conversation) return { text: '', error: 'unknown conversation', activity: [] }
    const team = this.getTeam()
    const provider = team.providers[agent.provider] ?? FALLBACK_PROVIDER
    const activity = this.hooks.activity
    const message: Message = {
      id: randomUUID(),
      conversationId,
      authorId: agent.id,
      text: '',
      createdAt: Date.now(),
      status: 'streaming',
      activity: [],
      ...(opts.taskRef ? { taskRef: opts.taskRef } : {}),
    }
    emit({ type: 'typing', conversationId, agentId: agent.id, on: true })
    activity?.turnStart(agent.id, conversationId, opts.projectId, opts.taskRef)
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      this.store.addMessage(conversationId, message)
      emit({ type: 'message:start', message })
    }

    // Sessions are per provider kind (and per review scope): switching provider or role starts fresh.
    const sessionKey = `${agent.id}@${provider.kind}${opts.sessionScope === 'review' ? '#review' : ''}`
    const sessionId = providerKeepsSession(provider.kind) ? conversation.sessions[sessionKey] : undefined
    const notes = this.memory.read(agent.id, opts.projectId)
    const cwd = opts.cwd ?? agentCwd(team.workspace, agent)

    // A chat turn that can write takes the folder's writer lock; if a workflow task or another chat
    // writes in an overlapping folder, this turn is refused (not queued) and says why.
    let release: (() => void) | undefined
    if (!opts.lockHeld && !opts.readOnly && canWrite(agent)) {
      const lock = this.writers.acquire(cwd, { owner: opts.projectId ?? conversationId, label: `${agent.name} in chat "${conversation.name}"` })
      if (!lock.ok) {
        emit({ type: 'typing', conversationId, agentId: agent.id, on: false })
        const error = `${agent.name} did not start: ${lock.holder.label} is writing in this folder. Send the message again when it finishes.`
        start()
        const done = this.store.updateMessage(conversationId, message.id, { text: `⚠️ ${error}`, status: 'error' }) ?? { ...message, text: `⚠️ ${error}`, status: 'error' as const }
        emit({ type: 'message:done', message: done })
        activity?.turnEnd(agent.id, { outcome: 'failed', error })
        return { text: '', error, messageId: message.id, activity: [] }
      }
      release = lock.release
    }

    const params: RunTurnParams = {
      team,
      conversation: opts.transcript ?? conversation,
      ...(opts.inputMessageId ? { inputMessageId: opts.inputMessageId } : {}),
      ...(this.hooks.resolveAttachment ? { resolveAttachment: this.hooks.resolveAttachment } : {}),
      agent,
      provider,
      sessionId,
      signal,
      notes,
      ...(opts.note ? { note: opts.note } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.context ? { context: opts.context } : {}),
      ...(opts.safe ? { safe: true } : {}),
      ...(opts.readOnly ? { readOnly: true } : {}),
      handlers: {
        onDelta: (delta) => {
          start()
          message.text += delta
          activity?.delta(agent.id)
          emit({ type: 'message:delta', conversationId, messageId: message.id, delta })
        },
        onActivity: (line) => {
          start()
          message.activity?.push(line)
          activity?.tool(agent.id, line)
          emit({ type: 'message:activity', conversationId, messageId: message.id, line })
        },
        onSession: (id) => {
          this.store.setSession(conversationId, sessionKey, id)
        },
        onInit: (src, ver) => {
          if (this.account.noteInit(src, ver)) emit({ type: 'account', account: this.account.get() })
        },
        onRateLimit: (info) => {
          this.account.noteRateLimit(info)
          emit({ type: 'account', account: this.account.get() })
        },
        onToolPermission: async (tool, input) => {
          const verdict = reviewByRules(this.getTeam(), tool, input)
          if (verdict === 'allow') return true
          start()
          const line = `Waiting for your approval: ${tool}`
          message.activity?.push(line)
          emit({ type: 'message:activity', conversationId, messageId: message.id, line })
          activity?.waitingApproval(agent.id, tool)
          const allowed = await this.approvals.ask(conversationId, agent.id, tool, input, signal)
          activity?.approvalResolved(agent.id)
          return allowed
        },
      },
    }
    let result: TurnResult
    try {
      result = await this.runner(params)
    } finally {
      release?.()
    }
    emit({ type: 'typing', conversationId, agentId: agent.id, on: false })

    if (result.error && /session|resume|not found|No conversation found|thread/i.test(result.error) && sessionId) {
      // The stored session is gone (e.g. transcript deleted). Forget it and retry once fresh.
      this.store.clearSession(conversationId, sessionKey)
      if (!started) {
        activity?.turnEnd(agent.id, { outcome: 'retry' })
        return this.turn(conversationId, agent, signal, opts)
      }
    }

    const usagePatch = result.usage ? { usage: result.usage } : {}
    const lines = message.activity ?? []

    if (result.error) {
      start()
      const text = message.text.trim().length > 0 ? message.text : `⚠️ ${result.error}`
      const done = this.store.updateMessage(conversationId, message.id, { text, status: 'error', ...usagePatch }) ?? { ...message, text, status: 'error' as const }
      emit({ type: 'message:done', message: done })
      this.emitUsage()
      activity?.turnEnd(agent.id, result.error === 'Stopped.' || signal.aborted ? { outcome: 'stopped' } : { outcome: 'failed', error: result.error })
      return { text: '', error: result.error, messageId: message.id, activity: lines }
    }

    if (result.text.length === 0) {
      // The agent chose to skip. Keep the cost on the books but drop the bubble.
      if (started) {
        this.store.removeMessage(conversationId, message.id)
        emit({ type: 'message:remove', conversationId, messageId: message.id })
      }
      if (result.usage) this.store.recordSilentUsage(conversationId, agent.id, result.usage)
      this.emitUsage()
      // Nothing was said: back to the derived idle / queued / waiting state, no completion.
      activity?.turnEnd(agent.id, signal.aborted ? { outcome: 'stopped' } : { outcome: 'skipped' })
      return { text: '', activity: lines }
    }

    start()
    if (signal.aborted) {
      // Stopped or corrected, yet the provider still returned a complete reply (it ignored the abort).
      // Keep it for the record, clearly marked, but it is not an answer: no attachments, no mentions,
      // no workflow chat ops, no memory, no completion.
      const done = this.store.updateMessage(conversationId, message.id, { text: result.text, status: 'superseded', ...usagePatch }) ?? { ...message, text: result.text, status: 'superseded' as const }
      emit({ type: 'message:done', message: done })
      this.emitUsage()
      activity?.turnEnd(agent.id, { outcome: 'stopped' })
      return { text: '', messageId: message.id, activity: lines, superseded: true }
    }
    const attachments = collectAttachments(result.text, lines, this.allowedFile, cwd)
    const done = this.store.updateMessage(conversationId, message.id, { text: result.text, status: 'done', ...usagePatch, ...(attachments.length ? { attachments } : {}) }) ?? { ...message, text: result.text, status: 'done' as const }
    emit({ type: 'message:done', message: done })
    this.emitUsage()
    // A reply was posted. Whether a task was delivered is the workflow's call (accepted → "done").
    activity?.turnEnd(agent.id, { outcome: 'replied' })
    return { text: result.text, messageId: message.id, activity: lines }
  }

  private emitUsage(): void {
    emit({ type: 'usage', usage: summarizeUsage(this.store.list()) })
  }
}
