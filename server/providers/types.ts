import path from 'node:path'
import type { RateLimitReport } from '../account.js'
import { PROVIDER_CAPABILITIES } from '../../shared/catalog.js'
import type { Agent, Conversation, MessageUsage, ProviderDef, ProviderKind, Team } from '../../shared/types.js'

export interface TurnHandlers {
  onDelta: (text: string) => void
  onActivity: (line: string) => void
  onSession: (sessionId: string) => void
  onInit?: (authSource: string, version: string) => void
  onRateLimit?: (info: RateLimitReport) => void
  /** Ask the owner whether a tool call may run. Absent = everything allowed. */
  onToolPermission?: (tool: string, input: Record<string, unknown>) => Promise<boolean>
}

export interface TurnResult {
  text: string
  sessionId?: string
  error?: string
  usage?: MessageUsage
}

export interface RunTurnParams {
  team: Team
  conversation: Conversation
  agent: Agent
  provider: ProviderDef
  sessionId: string | undefined
  signal: AbortSignal
  handlers: TurnHandlers
  /** Optional dispatcher instruction appended to this turn (e.g. "build it now"). */
  note?: string
  /** The employee's long-term notes, injected into the system prompt. */
  notes?: string
  /** Working folder for this turn (a project workspace). Overrides the employee's own folder. */
  cwd?: string
  /** Shared project context appended to the system prompt. */
  context?: string
  /**
   * Workflow turns: never use permission-bypass modes or flags (Claude bypassPermissions, Codex
   * --dangerously-bypass-approvals-and-sandbox, Gemini yolo, API tools outside the folder),
   * whatever the profile says. The employee's other permission choices still apply.
   */
  safe?: boolean
  /**
   * Review and planning steps: no write, edit or shell tools. Claude gets only read tools and no
   * MCP servers, Codex runs in its read-only OS sandbox, API employees get only read tools. The
   * Gemini CLI cannot be held to this (see enforcesReadOnly); the workflow never relies on it there.
   */
  readOnly?: boolean
}

/** Tools that only read. Everything else (Edit, Write, Bash, NotebookEdit, Task, MCP) can change files. */
export const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']

/** Whether the adapter itself enforces a read-only turn (tool removal or an OS sandbox), rather than only asking the model. */
export function enforcesReadOnly(kind: ProviderKind): boolean {
  return PROVIDER_CAPABILITIES[kind]?.readOnlyReview === true
}

export type ProviderRunner = (params: RunTurnParams) => Promise<TurnResult>

/** Where this turn's tools run: the turn's folder, else the employee's (relative to the workspace), else the workspace. */
export function turnCwd(params: Pick<RunTurnParams, 'cwd' | 'team' | 'agent'>): string {
  if (params.cwd) return params.cwd
  return agentCwd(params.team.workspace, params.agent)
}

export function agentCwd(workspace: string, agent: Agent): string {
  return agent.cwd ? path.resolve(workspace, agent.cwd) : workspace
}

/** Whether this turn may skip permission checks: only outside the workflow, and only if the profile says so. */
export function mayBypass(params: Pick<RunTurnParams, 'safe' | 'agent'>): boolean {
  return !params.safe && (params.agent.autoApproveTools || params.agent.permissionMode === 'bypassPermissions')
}

export function emptyUsage(model: string): MessageUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, numTurns: 1, model }
}
