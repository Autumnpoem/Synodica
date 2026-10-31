// Fixtures shared by the *.test.ts files: a multi-provider team, workflow blocks, temp folders.
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Clock } from './ledger.js'
import type { WorkspaceLocks } from './locks.js'
import { ProjectStore } from './projects.js'
import { Workflow, type TurnOutcome, type TurnRequest } from './workflow.js'
import type { Agent, Project, Team, WorkflowRole } from '../shared/types.js'

/** A manual clock: time only moves when the test says so, and due timers fire in order. */
export function fakeClock(start = new Date(2026, 9, 25, 9, 0, 0).getTime()): Clock & { advance(ms: number): void; pending(): number } {
  let now = start
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout: (h) => {
      timers.delete(h as number)
    },
    advance(ms: number) {
      const until = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        timers.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = until
    },
    pending: () => timers.size,
  }
}

export function tmp(prefix = 'ogb-test-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function member(id: string, provider: string, roles: WorkflowRole[], opts: Partial<Agent> = {}): Agent {
  return {
    id,
    name: id.toUpperCase(),
    role: roles[0]?.toUpperCase() ?? 'MEMBER',
    color: '#888',
    shape: 'blob',
    provider,
    model: 'test-model',
    effort: 'low',
    personality: `You are ${id}.`,
    tools: roles.some((r) => r === 'implementer' || r === 'writer') ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep'],
    permissionMode: 'dontAsk',
    mcpServers: [],
    inheritClaudeSettings: false,
    autoApproveTools: false,
    muted: false,
    approvals: 'auto',
    workflowRoles: roles,
    ...opts,
  }
}

/** Six seats on four provider kinds / endpoints, like a real mixed team. */
export function mixedTeam(workspace: string): Team {
  return {
    company: 'TestCo',
    owner: { id: 'user', name: 'Owner', title: 'Owner' },
    workspace,
    agents: [
      member('lead', 'claude', ['lead', 'reviewer'], { tier: 'critical' }),
      member('critic', 'codex', ['critic', 'reviewer'], { tier: 'critical' }),
      member('builder', 'codex', ['implementer'], { tier: 'critical' }),
      member('junior', 'deepseek', ['implementer'], { tier: 'routine' }),
      // Like the template's PROBE seat: a tester needs a shell to run tests or a build.
      member('qa', 'claude', ['tester', 'reviewer'], { tier: 'standard', tools: ['Read', 'Glob', 'Grep', 'Bash'] }),
      member('writer', 'kimi', ['writer'], { tier: 'routine' }),
    ],
    providers: {
      claude: { kind: 'claude', label: 'Claude' },
      codex: { kind: 'codex', label: 'Codex' },
      gemini: { kind: 'gemini', label: 'Gemini' },
      deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'http://deepseek.invalid/v1' },
      kimi: { kind: 'openai', label: 'Kimi', baseUrl: 'http://kimi.invalid/v1' },
    },
    mcpServers: {},
    skills: {},
    settings: { maxMessagesPerRound: 6, maxTurnsPerAgentPerRound: 2, maxTurnsPerReply: 10, groupMode: 'smart', language: 'auto', notifications: false, autoReview: [], router: { mode: 'deterministic' }, memory: { mode: 'off' }, maxTaskAttempts: 3, maxCritiqueRounds: 1, autoStartExecution: false },
  }
}

export function block(kind: string, value: unknown): string {
  return `Done.\n\n\`\`\`team-${kind}\n${JSON.stringify(value)}\n\`\`\``
}

export type Script = (req: TurnRequest, n: number) => string | TurnOutcome | Promise<string | TurnOutcome>

export interface Harness {
  team: Team
  store: ProjectStore
  wf: Workflow
  calls: TurnRequest[]
  notes: string[]
  members: Map<string, string[]>
  dataDir: string
  /** Highest number of runs in flight at once (duplicate dispatch / overlapping writers). */
  maxConcurrent: () => number
  newProject: (name?: string, workspace?: string, conversationId?: string) => Project
}

/** A workflow on a real ProjectStore with a scripted turn runner instead of providers. */
export function harness(script: Script, opts: { team?: Team; dataDir?: string; locks?: WorkspaceLocks } = {}): Harness {
  const dataDir = opts.dataDir ?? tmp()
  const team = opts.team ?? mixedTeam(tmp('ogb-ws-'))
  const store = new ProjectStore(dataDir)
  const calls: TurnRequest[] = []
  const notes: string[] = []
  const members = new Map<string, string[]>()
  let inFlight = 0
  let peak = 0
  const wf = new Workflow({
    getTeam: () => team,
    projects: store,
    members: (c) => members.get(c) ?? [],
    note: (_c, text) => notes.push(text),
    changed: () => {},
    ...(opts.locks ? { locks: opts.locks } : {}),
    runTurn: async (req) => {
      calls.push(req)
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        const out = await script(req, calls.length)
        return typeof out === 'string' ? { text: out, activity: [] } : out
      } finally {
        inFlight--
      }
    },
  })
  let n = 0
  return {
    team,
    store,
    wf,
    calls,
    notes,
    members,
    dataDir,
    maxConcurrent: () => peak,
    newProject: (name = 'Demo', workspace = team.workspace, conversationId = `conv-${++n}`) => {
      members.set(conversationId, team.agents.map((a) => a.id))
      return wf.create({ name, workspace, conversationId })
    },
  }
}

export const twoTaskPlan = {
  summary: 'CLI todo app',
  architecture: 'Node CLI with a JSON file store',
  tasks: [
    { key: 'core', title: 'Implement the todo CLI', owner: 'builder', reviewer: 'qa', kind: 'implement', tier: 'standard', acceptance: ['add/list/done commands work', 'npm test passes'] },
    { key: 'docs', title: 'Write the README', owner: 'writer', reviewer: 'critic', kind: 'docs', tier: 'routine', dependsOn: ['core'], acceptance: ['README documents every command'] },
  ],
}
