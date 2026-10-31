import type { AccountStatus, AgentActivity, AgentLedgerDay, AppState, ProviderCheck, ApprovalRequest, Conversation, CorrectionRecord, Message, Project, Routine, ServerEvent, Team, UsageSummary } from '../../shared/types'
import type { UsageReport } from '../../shared/usage'
import type { SyncCursor, SyncFrame, SequencedEvent } from '../../shared/sync'

export interface UiState {
  cursor: SyncCursor | null
  team: Team | null
  conversations: Conversation[]
  busy: Set<string>
  typing: Map<string, Set<string>>
  connected: boolean
  usage: UsageSummary
  account: AccountStatus
  routines: Routine[]
  approvals: ApprovalRequest[]
  projects: Project[]
  /** Per-employee activity, keyed by agent id. */
  activity: Map<string, AgentActivity>
  /** Today's observed time per employee, keyed by agent id. */
  ledger: Map<string, AgentLedgerDay>
  /** Latest real provider probes, keyed by provider id. Absent = not checked. */
  providerChecks: Record<string, ProviderCheck>
  /** Server clock minus this browser's clock, from the last snapshot. */
  clockOffset: number
  /** Latest interrupt-and-correct record per conversation id. */
  corrections: Map<string, CorrectionRecord>
  /** Account quotas and balances (null until the first load). */
  accountUsage: UsageReport | null
}

export type Action =
  | { type: 'sync'; frame: SyncFrame }
  | { type: 'sequenced'; event: SequencedEvent }
  | { type: 'state'; state: AppState }
  | { type: 'event'; event: ServerEvent }
  | { type: 'connected'; connected: boolean }
  | { type: 'accountUsage'; report: UsageReport }

const emptyTotals = { messages: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 }

export const initialState: UiState = {
  cursor: null,
  team: null,
  conversations: [],
  busy: new Set(),
  typing: new Map(),
  connected: false,
  usage: { byAgent: {}, byConversation: {}, byModel: {}, total: emptyTotals },
  account: { windows: {} },
  routines: [],
  approvals: [],
  projects: [],
  activity: new Map(),
  ledger: new Map(),
  providerChecks: {},
  clockOffset: 0,
  corrections: new Map(),
  accountUsage: null,
}

function patchConversation(state: UiState, id: string, fn: (c: Conversation) => Conversation): UiState {
  return { ...state, conversations: state.conversations.map((c) => (c.id === id ? fn(c) : c)) }
}

function upsert(messages: Message[], message: Message): Message[] {
  const i = messages.findIndex((m) => m.id === message.id)
  if (i === -1) return [...messages, message]
  const next = messages.slice()
  next[i] = message
  return next
}

export function reducer(state: UiState, action: Action): UiState {
  switch (action.type) {
    case 'sync':
      return reducer({ ...state, cursor: { epoch: action.frame.epoch, seq: action.frame.seq } }, { type: 'state', state: action.frame.state })
    case 'sequenced':
      if (!state.cursor || action.event.seq <= state.cursor.seq) return state
      return reducer({ ...state, cursor: { ...state.cursor, seq: action.event.seq } }, { type: 'event', event: action.event })
    case 'connected':
      return { ...state, connected: action.connected }
    case 'accountUsage':
      return { ...state, accountUsage: action.report }
    case 'state':
      return {
        ...state,
        team: action.state.team,
        conversations: action.state.conversations,
        busy: new Set(action.state.busy),
        typing: new Map(Object.entries(action.state.typing ?? {}).map(([id, agents]) => [id, new Set(agents)])),
        usage: action.state.usage,
        account: action.state.account,
        routines: action.state.routines ?? [],
        approvals: action.state.approvals ?? [],
        projects: action.state.projects ?? [],
        // A snapshot replaces everything: after a reconnect, nothing stale survives.
        activity: new Map((action.state.activity ?? []).map((a) => [a.agentId, a])),
        ledger: new Map((action.state.ledger ?? []).map((d) => [d.agentId, d])),
        providerChecks: action.state.providerChecks ?? {},
        clockOffset: typeof action.state.serverNow === 'number' ? action.state.serverNow - Date.now() : 0,
        // Records are oldest first, so the latest per conversation wins.
        corrections: new Map((action.state.corrections ?? []).map((c) => [c.conversationId, c])),
      }
    case 'event': {
      const ev = action.event
      switch (ev.type) {
        case 'message:start':
        case 'message:done':
          return patchConversation(state, ev.message.conversationId, (c) => ({ ...c, messages: upsert(c.messages, ev.message) }))
        case 'message:delta':
          return patchConversation(state, ev.conversationId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === ev.messageId ? { ...m, text: m.text + ev.delta } : m)),
          }))
        case 'message:activity':
          return patchConversation(state, ev.conversationId, (c) => ({
            ...c,
            messages: c.messages.map((m) => (m.id === ev.messageId ? { ...m, activity: [...(m.activity ?? []), ev.line] } : m)),
          }))
        case 'message:remove':
          return patchConversation(state, ev.conversationId, (c) => ({ ...c, messages: c.messages.filter((m) => m.id !== ev.messageId) }))
        case 'typing': {
          const typing = new Map(state.typing)
          const set = new Set(typing.get(ev.conversationId) ?? [])
          if (ev.on) set.add(ev.agentId)
          else set.delete(ev.agentId)
          typing.set(ev.conversationId, set)
          return { ...state, typing }
        }
        case 'round': {
          const busy = new Set(state.busy)
          if (ev.running) busy.add(ev.conversationId)
          else busy.delete(ev.conversationId)
          const typing = new Map(state.typing)
          if (!ev.running) typing.set(ev.conversationId, new Set())
          return { ...state, busy, typing }
        }
        case 'usage':
          return { ...state, usage: ev.usage }
        case 'account':
          return { ...state, account: ev.account }
        case 'team':
          return { ...state, team: ev.team, conversations: ev.conversations }
        case 'approval:request':
          return { ...state, approvals: [...state.approvals.filter((a) => a.id !== ev.request.id), ev.request] }
        case 'approval:resolved':
          return { ...state, approvals: state.approvals.filter((a) => a.id !== ev.id) }
        case 'routines':
          return { ...state, routines: ev.routines }
        case 'project': {
          const exists = state.projects.some((p) => p.id === ev.project.id)
          return { ...state, projects: exists ? state.projects.map((p) => (p.id === ev.project.id ? ev.project : p)) : [...state.projects, ev.project] }
        }
        case 'activity': {
          const activity = new Map(state.activity)
          activity.set(ev.activity.agentId, ev.activity)
          if (!ev.ledger) return { ...state, activity }
          const ledger = new Map(state.ledger)
          ledger.set(ev.ledger.agentId, ev.ledger)
          return { ...state, activity, ledger }
        }
        case 'providers':
          return { ...state, providerChecks: ev.checks }
        case 'usage:account':
          return { ...state, accountUsage: ev.report }
        case 'correction': {
          const corrections = new Map(state.corrections)
          corrections.set(ev.correction.conversationId, ev.correction)
          return { ...state, corrections }
        }
        default:
          return state
      }
    }
    default:
      return state
  }
}
