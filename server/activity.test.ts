// V2 activity seam: real transitions only, the transient "done" state, delta throttling, provider
// probes, overlapping employees and projects, and today's ledger with a fake clock and restarts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { Account } from './account.js'
import { activitySnapshot, ActivityTracker, DELTA_REPORT_MS, streamEventFor } from './activity.js'
import { Approvals } from './approvals.js'
import { ActivityLedger } from './ledger.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import { block, fakeClock, mixedTeam, tmp } from './testkit.js'
import type { TurnResult } from './providers/types.js'
import { ledgerTotals, petFocus, presenceOf } from '../shared/presence.js'
import type { ActivitySnapshot, Agent, AgentActivity, AgentLedgerDay, Project, Task } from '../shared/types.js'

function setup(opts: { doneMs?: number; projects?: Project[]; ledgerFile?: string; clock?: ReturnType<typeof fakeClock> } = {}) {
  const clock = opts.clock ?? fakeClock()
  const team = mixedTeam(tmp('ogb-ws-'))
  const projects = opts.projects ?? []
  const events: { a: AgentActivity; day?: AgentLedgerDay }[] = []
  const ledger = new ActivityLedger(opts.ledgerFile, clock)
  const tracker = new ActivityTracker(
    () => team,
    () => projects,
    (a, day) => events.push({ a, ...(day ? { day } : {}) }),
    { clock, ledger, ...(opts.doneMs !== undefined ? { doneMs: opts.doneMs } : {}) },
  )
  const last = (id: string) => [...events].reverse().find((e) => e.a.agentId === id)?.a
  return { clock, team, projects, events, ledger, tracker, last }
}

const task = (id: string, ownerId: string, state: Task['state'], extra: Partial<Task> = {}): Task =>
  ({ id, projectId: 'p1', title: `Task ${id}`, description: '', kind: 'implement', tier: 'standard', ownerId, state, dependsOn: [], acceptance: [], attempts: 0, maxAttempts: 3, artifacts: [], reviews: [], history: [], createdAt: 0, updatedAt: 0, ...extra }) as Task

const project = (id: string, tasks: Task[]): Project =>
  ({ id, name: id.toUpperCase(), workspace: '/tmp/x', conversationId: `c-${id}`, brief: '', phase: 'executing', critiques: [], decisions: [], tasks, runs: [], paused: false, finalReviews: 0, nextTaskNumber: tasks.length + 1, createdAt: 0, updatedAt: 0 }) as Project

test('tool lines map to detailed states; "Thinking…" is not a tool; approvals are waiting, not stalls', () => {
  const { tracker, last, clock } = setup()
  tracker.turnStart('builder', 'c1', 'p1', 'T-1')
  assert.equal(last('builder')?.state, 'thinking')
  tracker.tool('builder', 'Write src/app.ts')
  assert.equal(last('builder')?.toolKind, 'file')
  assert.equal(presenceOf(last('builder'), clock.now()).presence, 'coding')
  tracker.tool('builder', 'Bash npm test')
  assert.equal(presenceOf(last('builder'), clock.now()).presence, 'command')
  tracker.tool('builder', 'Read src/app.ts')
  assert.equal(presenceOf(last('builder'), clock.now()).presence, 'reading')
  tracker.tool('builder', 'Thinking…')
  assert.equal(last('builder')?.state, 'thinking', 'a reasoning marker is not a tool call')
  tracker.waitingApproval('builder', 'Bash')
  clock.advance(30 * 60_000)
  assert.equal(presenceOf(last('builder'), clock.now()).presence, 'waiting-approval', 'waiting for you is never called a stall')
  tracker.approvalResolved('builder')
  assert.equal(last('builder')?.state, 'thinking')
})

test('a quiet live turn is "no recent activity", never idle or stopped; deltas keep it fresh without flooding', () => {
  const { tracker, events, last, clock } = setup()
  tracker.turnStart('critic', 'c1')
  const before = events.length
  for (let i = 0; i < 50; i++) {
    clock.advance(1000)
    tracker.delta('critic')
  }
  const emitted = events.length - before
  assert.ok(emitted <= Math.ceil(50_000 / DELTA_REPORT_MS), `deltas are throttled (${emitted} events for 50 deltas)`)
  assert.equal(presenceOf(last('critic'), clock.now()).presence, 'thinking')
  clock.advance(6 * 60_000)
  const v = presenceOf(last('critic'), clock.now())
  assert.equal(v.presence, 'stalled')
  assert.match(v.label, /^No recent activity for 6m/)
  assert.ok(v.live, 'still a live turn')
  tracker.delta('critic')
  assert.equal(presenceOf(last('critic'), clock.now()).presence, 'thinking', 'new output clears the suspicion')
})

test('a posted reply is "replied" (not a task completion), expires on its own; skip, error and Stop show no completion', () => {
  const { tracker, last, clock } = setup({ doneMs: 6000 })
  tracker.turnStart('qa', 'c1', 'p1', 'T-2')
  tracker.turnEnd('qa', { outcome: 'replied' })
  assert.equal(last('qa')?.state, 'replied')
  assert.equal(last('qa')?.detail, 'Replied on T-2')
  const v = presenceOf(last('qa'), clock.now())
  assert.equal(v.label, 'Replied')
  assert.notEqual(v.presence, 'done', 'a reply is not shown as a delivered task')
  assert.notEqual(v.tone, 'done', 'no success tone for a reply')
  clock.advance(5999)
  assert.equal(last('qa')?.state, 'replied')
  clock.advance(1)
  assert.equal(last('qa')?.state, 'idle', 'the transient state ends by itself')

  // A skipped turn returns to the derived state at once, with no transient state.
  tracker.turnStart('qa', 'c1', 'p1', 'T-2')
  tracker.turnEnd('qa', { outcome: 'skipped' })
  assert.equal(last('qa')?.state, 'idle')
  tracker.turnStart('qa', 'c1')
  tracker.turnEnd('qa')
  assert.equal(last('qa')?.state, 'idle', 'a turn end without an outcome is not a completion')

  tracker.turnStart('qa', 'c1')
  tracker.turnEnd('qa', 'HTTP 500 from provider')
  assert.equal(last('qa')?.state, 'error')
  tracker.turnStart('qa', 'c1')
  tracker.turnEnd('qa', 'Stopped.')
  assert.ok(!['done', 'replied', 'error'].includes(last('qa')?.state ?? ''), 'a stopped turn is neither a completion nor a failure')
  tracker.turnStart('qa', 'c1')
  tracker.turnEnd('qa', { outcome: 'stopped' })
  assert.equal(last('qa')?.state, 'idle')
  // A turn end without a turn start (a refused chat turn) is not a completion either.
  tracker.turnEnd('writer', { outcome: 'replied' })
  assert.ok(!['done', 'replied'].includes(last('writer')?.state ?? ''))
  tracker.dispose()
})

test('a task that moves to accepted celebrates its owner once; the initial load does not', () => {
  const t1 = task('T-1', 'builder', 'reviewing')
  const p = project('p1', [t1])
  const { tracker, last, clock } = setup({ doneMs: 6000, projects: [p] })
  tracker.refresh()
  assert.notEqual(last('builder')?.state, 'done')
  t1.state = 'accepted'
  tracker.refresh()
  assert.equal(last('builder')?.state, 'done')
  assert.equal(last('builder')?.detail, 'T-1 accepted')
  clock.advance(6000)
  tracker.refresh()
  assert.equal(last('builder')?.state, 'idle')
  // Already accepted on a fresh tracker (restart): no celebration.
  const fresh = setup({ doneMs: 6000, projects: [project('p1', [task('T-1', 'builder', 'accepted')])] })
  fresh.tracker.refresh()
  assert.equal(fresh.last('builder')?.state, 'idle')
})

test('overlapping employees and projects keep separate state; offline comes only from probes', () => {
  const pa = project('pa', [task('T-1', 'builder', 'running'), task('T-2', 'writer', 'waiting', { dependsOn: ['T-1'] })])
  const pb = project('pb', [task('T-1', 'junior', 'ready')])
  const { tracker, last } = setup({ projects: [pa, pb] })
  tracker.turnStart('builder', 'c-pa', 'pa', 'T-1')
  tracker.turnStart('critic', 'c-pb', 'pb', 'REVIEW')
  tracker.refresh()
  assert.equal(last('builder')?.projectId, 'pa')
  assert.equal(last('critic')?.projectId, 'pb')
  assert.equal(last('writer')?.state, 'waiting-dependency')
  assert.equal(last('junior')?.state, 'queued')
  assert.equal(last('lead')?.state, 'idle')
  assert.deepEqual(tracker.providerChecks(), {}, 'nothing is assumed about providers before a probe')

  const checks = tracker.providerStatuses([
    { id: 'deepseek', kind: 'openai', ok: false, detail: 'HTTP 401' },
    { id: 'claude', kind: 'claude', ok: true, detail: 'v2 · subscription login' },
  ])
  assert.equal(checks.deepseek?.ok, false)
  assert.equal(last('junior')?.state, 'offline')
  assert.equal(last('junior')?.detail, 'HTTP 401')
  assert.equal(last('builder')?.state, 'thinking', 'a live turn is shown as live')
  tracker.turnStart('junior', 'c-pb', 'pb', 'T-1')
  tracker.turnEnd('junior')
  assert.equal(tracker.providerChecks().deepseek?.ok, true, 'a completed turn is a real reachability signal')
  assert.notEqual(last('junior')?.state, 'offline')
})

test('overlay snapshot and stream carry no credentials, messages or tool inputs', () => {
  const pa = project('pa', [task('T-1', 'builder', 'running', { description: 'SECRET-DESCRIPTION', evidence: 'SECRET-EVIDENCE' })])
  pa.brief = 'SECRET-BRIEF'
  const { tracker, team } = setup({ projects: [pa] })
  team.providers.deepseek = { kind: 'openai', label: 'DeepSeek', baseUrl: 'http://deepseek.invalid/v1', apiKey: 'sk-SECRET-KEY' }
  const approval = { id: 'a1', conversationId: 'c-pa', agentId: 'builder', tool: 'Bash', summary: 'SECRET-SUMMARY', input: { command: 'SECRET-COMMAND' }, createdAt: 1 }
  const snap = activitySnapshot(team, [pa], [approval], tracker, 123)
  const json = JSON.stringify(snap)
  for (const secret of ['SECRET-KEY', 'SECRET-BRIEF', 'SECRET-DESCRIPTION', 'SECRET-EVIDENCE', 'SECRET-SUMMARY', 'SECRET-COMMAND', 'deepseek.invalid', 'personality']) assert.ok(!json.includes(secret), `snapshot leaks ${secret}`)
  assert.equal(snap.projects[0]?.tasks[0]?.title, 'Task T-1')
  assert.deepEqual(snap.approvals[0], { id: 'a1', conversationId: 'c-pa', agentId: 'builder', tool: 'Bash', createdAt: 1 })
  assert.equal(snap.serverNow, 123)

  assert.equal(streamEventFor({ type: 'approval:request', request: approval })?.type, 'changed', 'approval details never reach the overlay stream')
  assert.equal(JSON.stringify(streamEventFor({ type: 'approval:request', request: approval })).includes('SECRET'), false)
  assert.equal(streamEventFor({ type: 'message:delta', conversationId: 'c', messageId: 'm', delta: 'SECRET' }), undefined, 'messages are not streamed')
  assert.equal(streamEventFor({ type: 'project', project: pa })?.type, 'changed')
  assert.equal(streamEventFor({ type: 'activity', activity: { agentId: 'x', state: 'idle', since: 1 } })?.type, 'activity')
})

/** What the pet derives from a snapshot, for every employee and for the whole team. */
function petViews(snap: ActivitySnapshot, now: number) {
  const input = {
    agents: snap.agents,
    activity: snap.activity,
    projects: snap.projects.map((p) => ({ id: p.id, name: p.name, conversationId: p.conversationId, tasks: p.tasks })),
    approvals: snap.approvals,
    now,
    connected: true,
  }
  return [petFocus({ ...input, target: { kind: 'team' } }), ...snap.agents.map((a) => petFocus({ ...input, target: { kind: 'agent', id: a.id } }))]
}

test('activity projection: secret-bearing tool input, URLs, errors and probe details never reach the snapshot, stream or pet', () => {
  const pa = project('pa', [task('T-1', 'builder', 'running'), task('T-2', 'qa', 'failed', { reason: 'Rejected: token=SECRET-REASON' })])
  const { tracker, team, events, clock, last } = setup({ projects: [pa] })
  const secrets = ['SECRET-VALUE', 'SECRET-FILE', 'SECRET-PATH', 'SECRET-QUERY', 'SECRET-FRAG', 'SECRET-USER', 'SECRET-BODY', 'SECRET-KEY', 'SECRET-REASON', 'SECRET-PROBE', 'SECRET-TOOL', 'SECRET-ARG', 'deepseek.invalid', 'kimi.invalid', 'npm test']
  const exposed: string[] = []
  const observe = () => {
    const snap = activitySnapshot(team, [pa], [], tracker, clock.now())
    exposed.push(JSON.stringify(snap), JSON.stringify(petViews(snap, clock.now())))
  }
  const builder = () => presenceOf(last('builder'), clock.now())

  tracker.turnStart('builder', 'c-pa', 'pa', 'T-1')
  tracker.tool('builder', 'Bash export API_TOKEN=SECRET-VALUE && curl -H "Authorization: Bearer SECRET-VALUE" https://api.example.com/x')
  assert.equal(builder().presence, 'command')
  assert.equal(last('builder')?.detail, 'Bash')
  observe()
  tracker.tool('builder', 'Bash npm test -- --token SECRET-ARG'.slice(0, 160))
  assert.equal(last('builder')?.detail, 'Bash')
  tracker.tool('builder', 'Write /home/u/.config/SECRET-FILE.env')
  assert.equal(builder().presence, 'coding')
  assert.equal(last('builder')?.detail, 'Write')
  observe()
  tracker.tool('builder', 'Fetching https://SECRET-USER:pw@docs.example.com:8443/SECRET-PATH?token=SECRET-QUERY#SECRET-FRAG')
  assert.equal(builder().presence, 'browsing')
  assert.equal(last('builder')?.detail, 'Fetching docs.example.com', 'only the host of a fetched URL is kept')
  observe()
  tracker.tool('builder', 'Searching the web: SECRET-QUERY')
  assert.equal(last('builder')?.detail, 'Searching the web')
  tracker.tool('builder', 'Grep SECRET-QUERY')
  assert.equal(builder().presence, 'reading')
  tracker.tool('builder', 'github → create_issue SECRET-TOOL')
  assert.equal(builder().presence, 'tool')
  observe()
  tracker.waitingApproval('builder', 'Bash SECRET-TOOL')
  assert.equal(builder().presence, 'waiting-approval')
  observe()
  tracker.approvalResolved('builder')

  tracker.turnStart('critic', 'c-pa', 'pa', 'REVIEW')
  tracker.turnEnd('critic', 'Could not reach http://deepseek.invalid/v1?key=SECRET-KEY: fetch failed')
  assert.equal(last('critic')?.state, 'error')
  assert.equal(last('critic')?.detail, 'Could not reach the provider')
  tracker.turnStart('lead', 'c1')
  tracker.turnEnd('lead', 'claude exited with code 1: {"error":"SECRET-BODY","cmd":"Bash export X=SECRET-VALUE"}')
  assert.equal(presenceOf(last('lead'), clock.now()).presence, 'failed', 'a failure is still a failure')
  assert.equal(last('lead')?.detail, 'The turn failed · details in the chat')
  tracker.turnStart('lead', 'c1')
  tracker.turnEnd('lead', { outcome: 'failed', error: 'Gemini returned HTTP 429: {"detail":"SECRET-BODY"}' })
  assert.equal(last('lead')?.detail, 'HTTP 429')
  assert.equal(last('qa')?.detail, 'T-2 failed · needs you', 'task reasons stay on the board')
  observe()

  const checks = tracker.providerStatuses([
    { id: 'deepseek', kind: 'openai', ok: false, detail: 'DeepSeek returned HTTP 401: {"message":"bad key sk-SECRET-KEY"}' },
    { id: 'kimi', kind: 'openai', ok: false, detail: 'Could not reach http://kimi.invalid/v1/models?api_key=SECRET-PROBE' },
    { id: 'claude', kind: 'claude', ok: true, detail: '2.1 · token SECRET-PROBE' },
  ])
  assert.equal(checks.deepseek?.detail, 'HTTP 401')
  assert.equal(checks.kimi?.detail, 'Could not reach the provider')
  assert.equal(checks.claude?.ok, true)
  assert.equal(last('junior')?.state, 'offline')
  exposed.push(JSON.stringify(streamEventFor({ type: 'providers', checks })))
  observe()

  // Everything the overlay stream would forward.
  for (const e of events) exposed.push(JSON.stringify(streamEventFor({ type: 'activity', activity: e.a, ...(e.day ? { ledger: e.day } : {}) })))
  assert.ok(events.length > 10)
  const all = exposed.join('\n')
  for (const s of secrets) assert.ok(!all.includes(s), `the activity projection leaks ${s}`)
  assert.ok(exposed.every((j) => !/[?#&]token=|Bearer|\/v1/.test(j)), 'no URL paths, queries or auth headers')
  // Timing is still real: the live turn keeps its start and last event.
  assert.ok((last('builder')?.lastEventAt ?? 0) > 0)
})

test('orchestrator turns: skip, error and Stop end without a completion; an unaccepted handoff only "replied"; acceptance celebrates', async () => {
  const dataDir = tmp()
  const workspace = tmp('ogb-ws-')
  const team = mixedTeam(workspace)
  const store = new Store(dataDir)
  store.seed(team)
  const conversation = store.createGroup('P', team.agents.map((a) => a.id))
  const p = project('p1', [task('T-1', 'builder', 'rework')])
  p.conversationId = conversation.id
  p.workspace = workspace
  const clock = fakeClock()
  const events: AgentActivity[] = []
  const tracker = new ActivityTracker(() => team, () => [p], (a) => events.push(a), { clock, doneMs: 6000 })
  let next: TurnResult = { text: '' }
  let abortDuringTurn: AbortController | undefined
  const orchestrator = new Orchestrator(() => team, store, new Account(path.join(dataDir, 'account.json')), new Approvals(), new Memory(dataDir), () => true, {
    activity: tracker,
    runner: async (params) => {
      params.handlers.onActivity('Bash echo SECRET-VALUE')
      abortDuringTurn?.abort()
      return next
    },
  })
  const found = team.agents.find((a) => a.id === 'builder')
  assert.ok(found)
  const builder: Agent = found
  const run = (signal: AbortSignal = new AbortController().signal) =>
    orchestrator.runTaskTurn({ project: p, agent: builder, ref: 'T-1', kind: 'work', note: 'Task T-1: build it', context: '', signal, sessionScope: 'work', cwd: workspace, readOnly: false })
  const mine = () => events.filter((e) => e.agentId === 'builder')
  const lastState = () => mine().at(-1)?.state
  const celebrated = (from: number) => mine().slice(from).some((e) => e.state === 'done' || e.state === 'replied')

  // Empty result: what a [skip] reply becomes after cleaning.
  let mark = mine().length
  await run()
  assert.ok(mine().slice(mark).some((e) => e.state === 'tool'), 'the turn really ran')
  assert.equal(celebrated(mark), false, 'a skipped turn is not a completion')
  assert.equal(lastState(), 'queued', 'back to the derived state: T-1 is rework, next in line')

  // Error.
  mark = mine().length
  next = { text: '', error: 'Codex returned HTTP 500: SECRET-BODY' }
  await run()
  assert.equal(celebrated(mark), false)
  assert.equal(lastState(), 'error')
  assert.equal(mine().at(-1)?.detail, 'HTTP 500')

  // Stopped mid-turn, even with partial text.
  mark = mine().length
  abortDuringTurn = new AbortController()
  next = { text: 'half an answer' }
  await run(abortDuringTurn.signal)
  abortDuringTurn = undefined
  assert.equal(celebrated(mark), false, 'a stopped turn is not a completion')
  assert.equal(lastState(), 'queued')
  mark = mine().length
  next = { text: '', error: 'Stopped.' }
  await run()
  assert.equal(celebrated(mark), false)
  assert.equal(lastState(), 'queued', 'Stop is not shown as a failure')

  // A nonempty handoff that nobody has reviewed yet: a reply, not a delivered task.
  mark = mine().length
  next = { text: block('handoff', { task: 'T-1', status: 'implemented', summary: 'built', artifacts: [], evidence: 'npm test: 3 passed' }) }
  p.tasks[0] = task('T-1', 'builder', 'implemented', { reviewerId: 'qa' })
  tracker.refresh() // what the workflow's "changed" hook does on every board change
  await run()
  assert.equal(lastState(), 'replied')
  assert.equal(mine().slice(mark).some((e) => e.state === 'done'), false, 'no task-completion state before acceptance')
  const replied = presenceOf(mine().at(-1), clock.now())
  assert.equal(replied.label, 'Replied')
  assert.notEqual(replied.presence, 'done')
  clock.advance(6000)
  assert.equal(lastState(), 'idle', 'the reply state expires into the derived state')

  // The reviewer accepts: now the owner's task really completed.
  p.tasks[0] = task('T-1', 'builder', 'accepted', { reviewerId: 'qa' })
  tracker.refresh()
  assert.equal(lastState(), 'done')
  assert.equal(mine().at(-1)?.detail, 'T-1 accepted')
  const accepted = presenceOf(mine().at(-1), clock.now())
  assert.equal(accepted.presence, 'done')
  assert.equal(accepted.label, 'Task accepted')
  assert.equal(accepted.tone, 'done')
  assert.ok(events.every((e) => !JSON.stringify(e).includes('SECRET')), 'tool input and error bodies stay in the chat')
  const c = store.get(conversation.id)
  assert.ok(c?.messages.some((m) => m.activity?.includes('Bash echo SECRET-VALUE')), 'the full tool line is still in the project chat')
  tracker.dispose()
})

test('ledger: today\'s working, waiting and idle time from timestamped transitions (fake clock)', () => {
  const pa = project('pa', [task('T-1', 'builder', 'ready')])
  const { tracker, ledger, clock } = setup({ projects: [pa] })
  tracker.refresh() // builder queued at 09:00
  clock.advance(10 * 60_000)
  tracker.turnStart('builder', 'c-pa', 'pa', 'T-1') // working from 09:10
  clock.advance(30 * 60_000)
  pa.tasks[0] = task('T-1', 'builder', 'accepted')
  tracker.turnEnd('builder') // idle from 09:40
  clock.advance(20 * 60_000)
  const totals = ledgerTotals(ledger.get('builder'), clock.now())
  assert.equal(totals.waiting, 10 * 60_000)
  assert.equal(totals.working, 30 * 60_000)
  assert.equal(totals.idle, 20 * 60_000, 'the open idle segment counts up to now')
  assert.equal(totals.observed, 60 * 60_000)
  const day = ledger.get('builder')
  assert.deepEqual(day?.timeline.map((e) => e.state), ['queued', 'thinking', 'idle'])
})

test('ledger: bounded timeline, day rollover and restart leave a gap instead of inventing time', () => {
  const dir = tmp()
  const file = path.join(dir, 'activity-ledger.json')
  const clock = fakeClock(new Date(2026, 9, 25, 23, 0, 0).getTime())
  const ledger = new ActivityLedger(file, clock)
  for (let i = 0; i < 200; i++) {
    ledger.transition('a', i % 2 ? 'thinking' : 'idle')
    clock.advance(1000)
  }
  assert.ok((ledger.get('a')?.timeline.length ?? 0) <= 48, 'the timeline is bounded')
  ledger.transition('a', 'thinking')
  clock.advance(30 * 60_000)
  ledger.checkpoint()
  assert.ok(readFileSync(file, 'utf8').includes('"savedAt"'))
  // Midnight passes: the new day starts at 00:00 with the running segment carried over.
  clock.advance(60 * 60_000) // 00:3x next day
  const next = ledger.get('a')
  assert.equal(next?.day, '2026-10-26')
  assert.equal(ledgerTotals(next, clock.now()).working, clock.now() - new Date(2026, 9, 26).getTime())

  // Restart: the segment open at the last checkpoint ends there; downtime is not counted.
  ledger.checkpoint()
  const savedAt = clock.now()
  clock.advance(2 * 60 * 60_000) // the server was down for two hours
  const reloaded = new ActivityLedger(file, clock)
  const day = reloaded.get('a')
  assert.equal(day?.open, undefined, 'nothing is assumed to be running after a restart')
  assert.equal(day?.timeline.at(-1)?.state, 'unknown', 'the gap is marked')
  const t = ledgerTotals(day, clock.now())
  assert.equal(t.working, savedAt - new Date(2026, 9, 26).getTime(), 'working time stops at the last checkpoint')
  reloaded.transition('a', 'idle')
  clock.advance(60_000)
  assert.equal(ledgerTotals(reloaded.get('a'), clock.now()).idle, 60_000)
})
