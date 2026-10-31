import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Account } from './account.js'
import { Approvals } from './approvals.js'
import { CorrectionLog, Corrector, type CorrectorDeps } from './correction.js'
import { subscribe } from './events.js'
import { WorkspaceLocks } from './locks.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { ProjectStore } from './projects.js'
import { Store } from './store.js'
import { block, harness, member, tmp, twoTaskPlan, type Script } from './testkit.js'
import { projectContext } from './workflow.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import type { CorrectionRecord, Message, Project, Team } from '../shared/types.js'

async function waitFor(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

const passing = [{ check: 'npm test', result: 'pass', detail: 'ok' }]
const handoff = (task: string) => block('handoff', { task, status: 'implemented', summary: `did ${task}`, artifacts: [], evidence: 'npm test: ok', checks: passing })
const approve = (task: string) => block('review', { task, verdict: 'approve', findings: [], evidence: 'checked' })

/** A gate the test opens by hand: the fake provider below ignores the abort signal until then. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {}
  const wait = new Promise<void>((r) => {
    open = r
  })
  return { wait, open }
}

/** Corrector over a real workflow with a stub chat side (no chat round runs in these projects). */
function workflowCorrector(h: ReturnType<typeof harness>, approvals = new Approvals(), dataDir = h.dataDir) {
  const events: CorrectionRecord[] = []
  const timers: (() => void)[] = []
  const log = new CorrectionLog(dataDir)
  const orchestrator: CorrectorDeps['orchestrator'] = {
    record: (conversationId, text, opts) => ({ id: `m-${Math.random()}`, conversationId, authorId: 'user', text, createdAt: Date.now(), status: 'done', ...(opts?.correctionId ? { correctionId: opts.correctionId } : {}) }) as Message,
    postNote: () => undefined,
    interrupt: () => ({ wasRunning: false }),
    isBusy: () => false,
    waitForIdle: async () => {},
    replyTo: () => {},
  }
  const corrector = new Corrector({ log, orchestrator, workflow: h.wf, projects: h.store, approvals, emit: (r) => events.push({ ...r }), setTimer: (fn) => timers.push(fn), clearTimer: () => {} })
  return { corrector, log, events, timers }
}

async function planned(script: Script, locks = new WorkspaceLocks()) {
  const h = harness(script, { locks })
  const p = h.newProject()
  h.wf.kickoff(p.id, 'Build a todo CLI with docs')
  await h.wf.settle(p.id)
  return { h, p, locks }
}

test('correction mid-task: the old run is aborted, nothing old is dispatched, a late result cannot advance the task, and the lock is free before the corrected run', async () => {
  const slow = gate()
  let oldFinished = false
  let correctedSawOldFinished: boolean | undefined
  let correctedLocks = -1
  const workRevisions: number[] = []
  let locks!: WorkspaceLocks
  const script: Script = async (req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    if (req.kind === 'work') workRevisions.push(req.project.revision ?? 0)
    if (req.kind === 'work' && req.ref === 'T-1' && (req.project.revision ?? 0) === 0) {
      // A provider that does not honor the abort: it finishes with a complete, valid handoff.
      await slow.wait
      oldFinished = true
      return handoff('T-1')
    }
    if (req.kind === 'work' && req.ref === 'T-1') {
      correctedSawOldFinished = oldFinished
      correctedLocks = locks.list().length
      assert.match(req.note, /use SQLite instead of JSON/, 'the correction is a requirement of the corrected run')
      assert.match(req.context, /Corrections from the boss[\s\S]*use SQLite instead of JSON/, 'and part of the project context')
      return handoff('T-1')
    }
    if (req.kind === 'review') return approve(req.ref)
    if (req.kind === 'work') return handoff(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  }
  const setup = await planned(script)
  const { h, p } = setup
  locks = setup.locks
  const { corrector, events, timers } = workflowCorrector(h)
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === 'T-1', 'T-1 running')
  assert.equal(locks.list().length, 1, 'the old run holds the writer lock')

  const ack = corrector.correct(p.conversationId, 'use SQLite instead of JSON')
  assert.equal(ack.status, 'stopping', 'not claimed stopped while the provider still runs')
  assert.equal(ack.interrupted, 'T-1')
  const mid = h.store.get(p.id) as Project
  assert.equal(mid.revision, 1, 'the instruction revision is bumped at once')
  assert.equal(mid.corrections?.[0]?.text, 'use SQLite instead of JSON', 'persisted before the old run stopped')
  // The provider has not returned: the record says so truthfully.
  await waitFor(() => timers.length > 0, 'stall notice scheduled')
  for (const fn of timers) fn()
  assert.match(events[events.length - 1]?.detail ?? '', /has not confirmed cancellation/)
  assert.equal(events[events.length - 1]?.status, 'stopping')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(h.calls.filter((c) => c.kind !== 'plan' && c.kind !== 'critique').length, 1, 'no further old dispatch while stopping')

  slow.open()
  const done = await corrector.done(ack.id)
  assert.equal(done?.status, 'applied')
  assert.ok(events.some((e) => e.status === 'stopped'), 'Stopped is reported once the old run returned')
  await h.wf.settle(p.id)
  const cur = h.store.get(p.id) as Project
  const run0 = cur.runs.find((r) => r.ref === 'T-1' && r.revision === 0)
  assert.equal(run0?.status, 'superseded', 'the late complete reply was recorded as superseded')
  assert.equal(correctedSawOldFinished, true, 'the corrected run started only after the old one returned')
  assert.equal(correctedLocks, 1, 'and after its lock was released (only the corrected run holds one)')
  assert.deepEqual(workRevisions.slice(0, 2), [0, 1], 'the only old dispatch is the interrupted one; everything after runs under the correction')
  assert.ok(workRevisions.slice(1).every((r) => r === 1))
  const t1 = cur.tasks.find((t) => t.id === 'T-1')
  assert.deepEqual(t1?.corrections?.map((c) => c.text), ['use SQLite instead of JSON'])
  assert.equal(t1?.state, 'accepted', 'accepted only through the corrected run and its review')
  assert.ok(t1?.history.some((e) => e.text === 'Correction: use SQLite instead of JSON'))
})

test('a late completion of a superseded review cannot accept the task', async () => {
  const slow = gate()
  let reviews = 0
  const script: Script = async (req) => {
    if (req.kind === 'plan') return block('plan', { summary: 's', architecture: 'a', tasks: [{ key: 'only', title: 'Only', owner: 'builder', reviewer: 'qa', acceptance: ['works'] }] })
    if (req.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review' && req.ref === 'T-1' && reviews++ === 0) {
      await slow.wait
      return approve('T-1')
    }
    return new Promise(() => {}) // the corrected work is not finished in this test
  }
  const { h, p } = await planned(script)
  const { corrector } = workflowCorrector(h)
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === 'T-1' && h.calls.some((c) => c.kind === 'review'), 'T-1 under review')
  const ack = corrector.correct(p.conversationId, 'the CLI must also support --json')
  slow.open()
  await waitFor(() => (h.store.get(p.id) as Project).corrections?.[0]?.status === 'applied', 'applied')
  const cur = h.store.get(p.id) as Project
  const t1 = cur.tasks.find((t) => t.id === 'T-1')
  assert.notEqual(t1?.state, 'accepted', 'the stale approval did not accept the corrected task')
  assert.equal(t1?.reviews.length, 0, 'and was not recorded as a review')
  assert.equal(cur.runs.find((r) => r.kind === 'review')?.status, 'superseded')
  assert.equal(ack.interrupted, 'T-1')
})

test('pending approvals in the conversation become stale on a correction', async () => {
  const approvals = new Approvals()
  const h = harness(() => '')
  const p = h.newProject()
  const { corrector } = workflowCorrector(h, approvals)
  const signal = new AbortController().signal
  const asked = approvals.ask(p.conversationId, 'builder', 'Bash', { command: 'rm -rf build' }, signal)
  const other = approvals.ask('another-chat', 'builder', 'Bash', { command: 'ls' }, signal)
  const [pending] = approvals.list()
  assert.ok(pending)
  corrector.correct(p.conversationId, 'do not delete the build folder')
  assert.equal(await asked, false, 'the waiting tool call is denied')
  assert.equal(approvals.resolve(pending.id, true), undefined, 'a late Allow finds nothing to run')
  assert.match(approvals.staleReason(pending.id) ?? '', /correction superseded/)
  assert.equal(approvals.list().length, 1, 'approvals in other conversations stay pending')
  approvals.resolve(approvals.list()[0]?.id ?? '', false)
  assert.equal(await other, false)
})

test('repeated corrections apply in order; the newest resumes and carries the earlier one', async () => {
  const slow = gate()
  const notes: string[] = []
  const script: Script = async (req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    if (req.kind === 'work' && req.ref === 'T-1' && (req.project.revision ?? 0) === 0) {
      await slow.wait
      return { text: '', error: 'Stopped.', activity: [] }
    }
    if (req.kind === 'work') {
      notes.push(req.note)
      return new Promise(() => {})
    }
    return ''
  }
  const { h, p } = await planned(script)
  const { corrector } = workflowCorrector(h)
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === 'T-1', 'T-1 running')
  const a = corrector.correct(p.conversationId, 'first: rename the command to todo')
  const b = corrector.correct(p.conversationId, 'second: and keep the old name as an alias')
  assert.equal(b.interrupted, 'T-1', 'the second correction targets the same interrupted task')
  slow.open()
  assert.equal((await corrector.done(a.id))?.status, 'superseded')
  assert.equal((await corrector.done(b.id))?.status, 'applied')
  await waitFor(() => notes.length === 1, 'one corrected dispatch')
  const cur = h.store.get(p.id) as Project
  assert.deepEqual(cur.corrections?.map((c) => [c.revision, c.status]), [[1, 'superseded'], [2, 'applied']])
  assert.deepEqual(cur.tasks.find((t) => t.id === 'T-1')?.corrections?.map((c) => c.text), ['first: rename the command to todo', 'second: and keep the old name as an alias'])
  assert.match(notes[0] ?? '', /first: rename[\s\S]*second: and keep/, 'both, in order, reach the corrected run')
})

test('a scope-changing correction waits for Resume or Kickoff and re-plan keeps started work as cancelled', async () => {
  const slow = gate()
  const script: Script = async (req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    if (req.kind === 'work' && (req.project.revision ?? 0) === 0) {
      await slow.wait
      return { text: '', error: 'Stopped.', activity: [] }
    }
    return new Promise(() => {})
  }
  const { h, p } = await planned(script)
  const { corrector } = workflowCorrector(h)
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === 'T-1', 'T-1 running')
  const r = corrector.correct(p.conversationId, 'make it a web app instead of a CLI', { mode: 'replan' })
  slow.open()
  assert.equal((await corrector.done(r.id))?.status, 'applied')
  await h.wf.settle(p.id)
  let cur = h.store.get(p.id) as Project
  assert.equal(cur.phase, 'needs-attention')
  assert.equal(cur.paused, true, 'nothing continues by itself after a scope change')
  assert.equal(h.calls.filter((c) => c.kind === 'work').length, 1)
  h.wf.kickoff(p.id, '')
  await waitFor(() => h.calls.filter((c) => c.kind === 'plan').length === 2, 're-plan')
  cur = h.store.get(p.id) as Project
  const t1 = cur.tasks.find((t) => t.id === 'T-1')
  assert.equal(t1?.state, 'cancelled', 'the started task is kept on the board, cancelled with a reason')
  assert.match(t1?.reason ?? '', /Superseded by a re-plan/)
  assert.match(projectContext(cur, (id) => id), /make it a web app instead of a CLI/)
})

test('a restart keeps the latest correction, applies it to the task requirements and replays nothing', async () => {
  const script: Script = async (req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    return new Promise(() => {}) // the provider never returns: the server "dies" mid-stop
  }
  const { h, p } = await planned(script)
  const { corrector } = workflowCorrector(h)
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === 'T-1', 'T-1 running')
  corrector.correct(p.conversationId, 'first correction')
  const latest = corrector.correct(p.conversationId, 'latest correction wins')
  // "Restart": new stores over the same data folder.
  const store = new ProjectStore(h.dataDir)
  const log = new CorrectionLog(h.dataDir)
  const cur = store.get(p.id) as Project
  assert.equal(cur.revision, 2)
  assert.equal(cur.corrections?.[cur.corrections.length - 1]?.text, 'latest correction wins')
  assert.ok(cur.corrections?.every((c) => c.status === 'pending-restart'))
  assert.equal(cur.paused, true, 'nothing continues automatically after the restart')
  const t1 = cur.tasks.find((t) => t.id === 'T-1')
  assert.equal(t1?.state, 'interrupted', 'the uncertain old run is not replayed')
  assert.deepEqual(t1?.corrections?.map((c) => c.text), ['first correction', 'latest correction wins'])
  assert.equal(log.get(latest.id)?.status, 'pending-restart')
  assert.equal(log.recovered.length, 2)
})

// ---------- ordinary chats share the same cancellation ----------

function chatTeam(workspace: string): Team {
  return {
    company: 'Co',
    owner: { id: 'user', name: 'Boss', title: 'CEO' },
    workspace,
    agents: [member('ana', 'claude', ['implementer']), member('ben', 'claude', ['implementer'])],
    providers: { claude: { kind: 'claude', label: 'Claude' } },
    mcpServers: {},
    skills: {},
    settings: { maxMessagesPerRound: 6, maxTurnsPerAgentPerRound: 1, maxTurnsPerReply: 5, groupMode: 'everyone', language: 'auto', notifications: false, autoReview: [], router: { mode: 'deterministic' }, memory: { mode: 'off' } },
  }
}

test('chat: a correction mid-stream aborts the turn, the next old speaker never runs, the lock is released, then a new round answers the correction', async () => {
  const dir = tmp()
  const team = chatTeam(tmp('ogb-ws-'))
  const store = new Store(dir)
  store.seed(team)
  const locks = new WorkspaceLocks()
  const calls: { agent: string; sawCorrection: boolean; locksAtStart: number }[] = []
  let streaming!: () => void
  const runner = (params: RunTurnParams): Promise<TurnResult> => {
    calls.push({ agent: params.agent.id, sawCorrection: params.conversation.messages.some((m) => m.correctionId !== undefined), locksAtStart: locks.list().length })
    if (calls.length === 1) {
      params.handlers.onDelta('Starting on the JSON store...')
      return new Promise((resolve) => {
        streaming = () => resolve({ text: '', error: 'Stopped.' })
        params.signal.addEventListener('abort', () => setTimeout(() => streaming(), 15), { once: true })
      })
    }
    return Promise.resolve({ text: `ok from ${params.agent.id}` })
  }
  const approvals = new Approvals()
  const orch = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), approvals, new Memory(dir), () => false, { runner, locks })
  const h = harness(() => '')
  const corrector = new Corrector({ log: new CorrectionLog(dir), orchestrator: orch, workflow: h.wf, projects: { byConversation: () => undefined }, approvals, emit: () => {}, setTimer: () => 0, clearTimer: () => {} })
  orch.post('group', 'build the store with JSON files')
  await waitFor(() => calls.length === 1 && locks.list().length === 1, 'ana streaming with the lock')
  const ack = corrector.correct('group', 'use SQLite, not JSON')
  assert.equal(ack.status, 'stopping')
  const done = await corrector.done(ack.id)
  assert.equal(done?.status, 'applied')
  await orch.waitForIdle('group')
  assert.deepEqual(calls.map((c) => [c.agent, c.sawCorrection]), [['ana', false], ['ana', true], ['ben', true]], 'ben never ran on the old instruction; the new round answers the correction')
  assert.equal(calls[1]?.locksAtStart, 1, 'the corrected turn started after the old lock was released (it holds only its own)')
  const messages = store.get('group')?.messages ?? []
  assert.ok(messages.some((m) => m.text === 'build the store with JSON files'), 'history is preserved')
  assert.ok(messages.some((m) => m.correctionId === ack.id && m.text === 'use SQLite, not JSON'), 'the original correction is recorded')
})

/** Records what would be folded into each employee's memory instead of calling a model. */
class SpyMemory extends Memory {
  updates: { agentId: string; recent: Message[] }[] = []
  override update(_team: Team, agent: { id: string }, recent: Message[]): Promise<void> {
    this.updates.push({ agentId: agent.id, recent: recent.map((m) => ({ ...m })) })
    return Promise.resolve()
  }
}

test('chat: a provider that ignores the abort and returns a complete reply is kept as superseded, never a done reply, mention, or memory', async () => {
  const dir = tmp()
  const team = chatTeam(tmp('ogb-ws-'))
  const store = new Store(dir)
  store.seed(team)
  const late = gate()
  const calls: string[] = []
  const runner = async (params: RunTurnParams): Promise<TurnResult> => {
    calls.push(params.agent.id)
    if (calls.length === 1) {
      params.handlers.onDelta('Writing the JSON store')
      await late.wait // ignores params.signal entirely
      return { text: 'Done: the JSON store is written. @ben please review it.' }
    }
    return { text: `ok from ${params.agent.id}` }
  }
  const events: { id: string; status: string }[] = []
  const unsubscribe = subscribe((e) => {
    if (e.type === 'message:done') events.push({ id: e.message.id, status: e.message.status })
  })
  const memory = new SpyMemory(dir)
  const orch = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), new Approvals(), memory, () => false, { runner })
  try {
    orch.post('group', 'build the store with JSON files', { forced: [team.agents[0] as Team['agents'][number]] })
    await waitFor(() => calls.length === 1, 'ana streaming')
    orch.stop('group')
    late.open()
    await orch.waitForIdle('group')
    const stale = store.get('group')?.messages.find((m) => m.authorId === 'ana')
    assert.equal(stale?.status, 'superseded', 'kept for the record, marked superseded')
    assert.match(stale?.text ?? '', /JSON store is written/, 'the late text is preserved for audit')
    assert.deepEqual(events.filter((e) => e.id === stale?.id).map((e) => e.status), ['superseded'], 'never announced as a done reply (no notification or unread)')
    assert.deepEqual(calls, ['ana'], 'the @mention in the late reply dispatched nobody')
    assert.equal(memory.updates.length, 0, 'nobody "spoke" this round, so nothing is consolidated into memory')
  } finally {
    unsubscribe()
  }
})

test('workflow through the chat: a task turn whose provider ignores the abort yields no text, a superseded message and no memory', async () => {
  const dir = tmp()
  const team = chatTeam(tmp('ogb-ws-'))
  const store = new Store(dir)
  store.seed(team)
  const late = gate()
  const runner = async (params: RunTurnParams): Promise<TurnResult> => {
    params.handlers.onDelta('working')
    await late.wait
    return { text: handoff('T-1') }
  }
  const memory = new SpyMemory(dir)
  const orch = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), new Approvals(), memory, () => false, { runner })
  const abort = new AbortController()
  const project = { id: 'p1', conversationId: 'group' } as Project
  const agent = team.agents[0] as Team['agents'][number]
  const pending = orch.runTaskTurn({ project, agent, ref: 'T-1', kind: 'work', note: '', context: '', signal: abort.signal, sessionScope: 'work', cwd: team.workspace, readOnly: false })
  await waitFor(() => store.get('group')?.messages.some((m) => m.authorId === agent.id && m.status === 'streaming') === true, 'task turn streaming')
  abort.abort()
  late.open()
  const outcome = await pending
  assert.equal(outcome.text, '', 'the workflow receives no handoff text to parse')
  assert.equal(outcome.superseded, true)
  const msg = store.get('group')?.messages.find((m) => m.id === outcome.messageId)
  assert.equal(msg?.status, 'superseded')
  assert.match(msg?.text ?? '', /```team-handoff/, 'the late handoff is kept in the history, marked')
  assert.equal(memory.updates.length, 0)
})
