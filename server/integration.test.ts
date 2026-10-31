import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { Account } from './account.js'
import { ActivityTracker, deriveIdleState } from './activity.js'
import { Approvals } from './approvals.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { ProjectStore } from './projects.js'
import { Store } from './store.js'
import { block, mixedTeam, tmp, twoTaskPlan } from './testkit.js'
import { projectContext, Workflow } from './workflow.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import type { AgentActivity, Project, ProviderKind } from '../shared/types.js'

interface Call {
  kind: ProviderKind
  agent: string
  cwd: string | undefined
  safe: boolean
  readOnly: boolean
  context: string
  sessionId: string | undefined
  note: string
  conversation: string
}

/**
 * Simulated provider adapters: one per provider kind, answering like a disciplined employee.
 * They exercise the same handler callbacks real adapters use (deltas, tool activity, sessions).
 */
function simulatedProviders(calls: Call[], concurrency: { now: number; peak: number }) {
  let reviews = 0
  return async (p: RunTurnParams): Promise<TurnResult> => {
    concurrency.now++
    concurrency.peak = Math.max(concurrency.peak, concurrency.now)
    try {
      await new Promise((r) => setTimeout(r, 2))
      const note = p.note ?? ''
      calls.push({ kind: p.provider.kind, agent: p.agent.id, cwd: p.cwd, safe: p.safe === true, readOnly: p.readOnly === true, context: p.context ?? '', sessionId: p.sessionId, note, conversation: p.conversation.id })
      if (p.provider.kind === 'claude' || p.provider.kind === 'codex') p.handlers.onSession(`${p.agent.id}-${p.provider.kind}-${calls.length}`)
      let text: string
      if (note.includes('Step: requirement analysis')) text = block('plan', twoTaskPlan)
      else if (note.includes('Step: independent plan critique')) text = block('critique', { verdict: 'approve', issues: [] })
      else if (/Task T-\d+:/.test(note)) {
        const id = /Task (T-\d+):/.exec(note)?.[1] ?? 'T-0'
        const file = id === 'T-1' ? 'todo.js' : 'README.md'
        p.handlers.onActivity(`Write ${file}`)
        writeFileSync(path.join(p.cwd ?? '.', file), `// ${id}\n`)
        // checks are read only for the verification task, which the workflow adds to this plan.
        text = block('handoff', { task: id, status: 'implemented', summary: `${id} done`, artifacts: [file], evidence: 'node --test: 2 passed', checks: [{ check: 'todo add/list', result: 'pass', detail: 'node todo.js add x; node todo.js list' }] })
      } else if (note.includes('Step: independent review of')) {
        const id = /review of (T-\d+)/.exec(note)?.[1] ?? 'T-0'
        text = ++reviews === 1 ? block('review', { task: id, verdict: 'reject', findings: ['missing input validation'], evidence: 'read todo.js' }) : block('review', { task: id, verdict: 'approve', findings: [], evidence: 'read the files' })
      } else if (note.includes('Step: final consistency review')) text = block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'all consistent' })
      else text = `ack from ${p.agent.name}`
      p.handlers.onDelta(text)
      return { text, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1, model: p.agent.model } }
    } finally {
      concurrency.now--
    }
  }
}

test('integration: workflow through the real orchestrator with simulated Claude, Codex and API adapters', async () => {
  const dataDir = tmp()
  const workspace = tmp('ogb-ws-')
  const team = mixedTeam(workspace)
  team.settings.maxCritiqueRounds = 1
  const store = new Store(dataDir)
  store.seed(team)
  const projects = new ProjectStore(dataDir)
  const events: AgentActivity[] = []
  const activity = new ActivityTracker(
    () => team,
    () => projects.list(),
    (a) => events.push(a),
  )
  const calls: Call[] = []
  const concurrency = { now: 0, peak: 0 }
  const names = (id: string): string => team.agents.find((a) => a.id === id)?.name ?? id
  let workflow: Workflow | undefined
  const orchestrator = new Orchestrator(() => team, store, new Account(path.join(dataDir, 'account.json')), new Approvals(), new Memory(dataDir), (p) => p.startsWith(workspace), {
    activity,
    runner: simulatedProviders(calls, concurrency),
    projectFor: (id) => {
      const p = projects.byConversation(id)
      return p ? { id: p.id, workspace: p.workspace, context: projectContext(p, names) } : undefined
    },
    onReply: (c, a, t) => workflow?.applyChatOps(c, a, t),
  })
  workflow = new Workflow({
    getTeam: () => team,
    projects,
    runTurn: (req) => orchestrator.runTaskTurn(req),
    members: (c) => store.get(c)?.memberIds.filter((m) => m !== 'user') ?? [],
    note: (c, text) => orchestrator.postNote(c, text),
    changed: () => activity.refresh(),
  })
  const conversation = store.createGroup('Todo', team.agents.map((a) => a.id))
  const project = workflow.create({ name: 'Todo', workspace, conversationId: conversation.id })
  store.linkProject(conversation.id, project.id)

  workflow.kickoff(project.id, 'Build a todo CLI with a README')
  await workflow.settle(project.id)
  assert.equal(projects.get(project.id)?.phase, 'plan-ready')
  workflow.start(project.id)
  // The owner chats while the team works: the chat round and workflow turns never overlap.
  await new Promise((r) => setTimeout(r, 3))
  orchestrator.post(conversation.id, '@QA how is it going?')
  await workflow.settle(project.id)
  await orchestrator.waitForIdle(conversation.id)

  const p = projects.get(project.id) as Project
  assert.equal(p.phase, 'done')
  assert.deepEqual(p.tasks.map((t) => `${t.id}:${t.state}:${t.attempts}`), ['T-1:accepted:2', 'T-2:accepted:1', 'T-3:accepted:1'])
  assert.equal(p.verification?.state, 'passed')
  assert.equal(concurrency.peak, 1, 'one provider turn at a time in a project chat')

  const kinds = new Set(calls.map((c) => c.kind))
  assert.ok(kinds.has('claude') && kinds.has('codex') && kinds.has('openai'), `providers used: ${[...kinds].join(', ')}`)
  const workflowCalls = calls.filter((c) => c.note.includes('workflow step'))
  assert.ok(workflowCalls.length >= 7)
  assert.ok(calls.every((c) => c.safe), 'project turns never use permission bypass')
  assert.ok(calls.filter((c) => /Step: (independent review|independent plan critique|requirement analysis|final consistency)/.test(c.note)).every((c) => c.readOnly), 'reviews and planning reach the adapter as read-only turns')
  assert.ok(calls.filter((c) => /Task T-\d+:/.test(c.note)).every((c) => !c.readOnly), 'implementation turns may write')
  assert.ok(calls.every((c) => c.cwd === workspace), 'project turns run in the project workspace')
  assert.ok(calls.every((c) => c.context.includes('Project "Todo"')), 'project turns carry the shared context')
  assert.ok(calls.some((c) => c.note === '' && c.agent === 'qa'), 'the owner question reached QA as a normal chat turn')

  const c = store.get(conversation.id)
  assert.ok(c)
  assert.ok(Object.keys(c.sessions).some((k) => k.endsWith('#review')), 'reviews keep their own provider session')
  assert.ok(Object.keys(c.sessions).some((k) => k === 'builder@codex'), 'work sessions are separate from review sessions')
  const refs = new Set(c.messages.map((m) => m.taskRef).filter(Boolean))
  for (const r of ['PLAN', 'CRITIQUE', 'T-1', 'T-2', 'FINAL']) assert.ok(refs.has(r), `chat shows ${r}`)
  const t1msg = c.messages.find((m) => m.taskRef === 'T-1' && m.authorId === 'builder')
  assert.deepEqual(t1msg?.attachments?.map((a) => a.path), [path.join(workspace, 'todo.js')], 'relative tool paths become attachments from the project folder')
  assert.ok(c.messages.some((m) => m.authorId === 'workflow' && m.text.includes('T-1 rejected by QA')), 'rejections are visible in chat')

  assert.ok(events.some((e) => e.agentId === 'builder' && e.state === 'thinking' && e.taskRef?.startsWith('T-')))
  assert.ok(events.some((e) => e.agentId === 'builder' && e.state === 'tool' && e.toolKind === 'file' && e.detail === 'Write'), 'the tool is shown, its input (the path) is not')
  assert.ok(events.some((e) => e.agentId === 'writer' && e.state === 'waiting-dependency'), 'docs owner waits for its prerequisite, not idle')
  assert.ok(activity.list().every((a) => a.state === 'idle'), 'everyone idle once the project is done')
})

test('activity: unassigned, waiting, failed and interrupted are distinct states', () => {
  const p = {
    id: 'p',
    archived: false,
    paused: false,
    tasks: [
      { id: 'T-1', ownerId: 'a', reviewerId: 'r', state: 'ready', dependsOn: [] },
      { id: 'T-2', ownerId: 'b', state: 'waiting', dependsOn: ['T-1'] },
      { id: 'T-3', ownerId: 'c', state: 'failed', reason: 'rejected 3 times', dependsOn: [] },
      { id: 'T-4', ownerId: 'd', state: 'interrupted', reason: 'restart', dependsOn: [] },
    ],
  } as unknown as Project
  assert.equal(deriveIdleState('a', [p]).state, 'queued')
  assert.equal(deriveIdleState('b', [p]).state, 'waiting-dependency')
  assert.equal(deriveIdleState('c', [p]).state, 'waiting-user')
  assert.equal(deriveIdleState('d', [p]).state, 'interrupted')
  assert.equal(deriveIdleState('z', [p]).state, 'idle')
})

test('memory is scoped per project; legacy notes stay where they were', async () => {
  const dataDir = tmp()
  const team = mixedTeam(tmp('ogb-ws-'))
  const seen: string[] = []
  const memory = new Memory(dataDir, async (provider, model, _system, prompt) => {
    seen.push(`${provider.label}/${model}`)
    return `notes from ${prompt.includes('ALPHA') ? 'alpha' : 'other'}`
  })
  const agent = team.agents[0]
  assert.ok(agent)
  memory.write(agent.id, 'legacy global notes')
  assert.equal(memory.file(agent.id), path.join(dataDir, 'memory', `${agent.id}.md`))
  const msg = (text: string) => [{ id: '1', conversationId: 'c', authorId: 'user', text, createdAt: 1, status: 'done' as const }]
  await memory.update(team, agent, msg('ALPHA plans'), 'p-alpha')
  assert.deepEqual(seen, [], 'memory helper off: no model call at all')
  team.settings.memory = { mode: 'model', provider: 'kimi', model: 'kimi-test' }
  await memory.update(team, agent, msg('ALPHA plans'), 'p-alpha')
  await memory.update(team, agent, msg('beta stuff'), 'p-beta')
  assert.deepEqual(seen, ['Kimi/kimi-test', 'Kimi/kimi-test'], 'the configured provider is used, not Claude')
  assert.equal(memory.read(agent.id, 'p-alpha'), 'notes from alpha')
  assert.equal(memory.read(agent.id, 'p-beta'), 'notes from other')
  assert.equal(memory.read(agent.id), 'legacy global notes')
})
