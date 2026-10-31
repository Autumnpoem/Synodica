import assert from 'node:assert/strict'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { recover, ProjectStore } from './projects.js'
import { block, harness, twoTaskPlan, type Script } from './testkit.js'
import { canWrite, createsCycle, projectContext, refreshWaiting, resolveArtifacts, Workflow, WorkflowError } from './workflow.js'
import type { Project, Task } from '../shared/types.js'

async function waitFor(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

// Checks are only read for verification (kind "test") tasks; other handoffs ignore them.
const passing = [{ check: 'npm test', result: 'pass', detail: 'npm test: 3 passed' }]
const handoff = (task: string, artifacts: string[] = [], evidence = 'npm test: 3 passed') => block('handoff', { task, status: 'implemented', summary: `did ${task}`, artifacts, evidence, checks: passing })
const approve = (task: string) => block('review', { task, verdict: 'approve', findings: [], evidence: 'read the files and ran the checks' })
const reject = (task: string, finding: string) => block('review', { task, verdict: 'reject', findings: [finding], evidence: 'ran it' })
const task = (p: Project, id: string): Task => {
  const t = p.tasks.find((x) => x.id === id)
  assert.ok(t, `task ${id} exists`)
  return t
}
const singleTask = (owner: string, reviewer: string, extra: Record<string, unknown> = {}) => block('plan', { summary: 's', architecture: 'a', tasks: [{ key: 'only', title: 'Only task', owner, reviewer, acceptance: ['it works'], ...extra }] })

test('end to end: request → plan → critique → decision → implement → review rejection → repair → accepted → dependent docs → final review', async () => {
  let qaReviews = 0
  const script: Script = (req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'critique') return block('critique', { verdict: 'revise', issues: ['the README must also cover setup'] })
    if (req.kind === 'decide') {
      const revised = { ...twoTaskPlan, tasks: twoTaskPlan.tasks.map((t) => (t.key === 'docs' ? { ...t, acceptance: [...t.acceptance, 'README covers setup'] } : t)) }
      return `${block('plan', revised)}\n${block('decision', { decision: 'Docs cover setup too', rationale: 'the critic is right; scope unchanged otherwise' })}`
    }
    if (req.kind === 'work' && req.ref === 'T-1') {
      writeFileSync(path.join(req.cwd, 'todo.js'), 'console.log("todo")\n')
      return handoff('T-1', ['todo.js'])
    }
    if (req.kind === 'review' && req.ref === 'T-1') return ++qaReviews === 1 ? reject('T-1', 'done crashes on an unknown id') : approve('T-1')
    if (req.kind === 'work' && req.ref === 'T-2') {
      writeFileSync(path.join(req.cwd, 'README.md'), '# Todo\n')
      return handoff('T-2', ['README.md', 'missing.md'], 'checked every command against todo.js')
    }
    if (req.kind === 'review' && req.ref === 'T-2') return approve('T-2')
    if (req.kind === 'work' && req.ref === 'T-3') return handoff('T-3', [], 'walked through add/list/done')
    if (req.kind === 'review' && req.ref === 'T-3') return approve('T-3')
    if (req.kind === 'final-review') return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'docs match the CLI' })
    throw new Error(`unexpected turn ${req.kind} ${req.ref}`)
  }
  const h = harness(script)
  const p = h.newProject()
  assert.equal(p.decisionOwnerId, 'lead')
  assert.equal(p.criticId, 'critic')

  h.wf.kickoff(p.id, 'Build a todo CLI with docs')
  await h.wf.settle(p.id)
  let cur = h.store.get(p.id) as Project
  assert.equal(cur.phase, 'plan-ready', 'waits for Start after planning')
  assert.deepEqual(h.calls.map((c) => `${c.kind}:${c.agent.id}`), ['plan:lead', 'critique:critic', 'decide:lead'])
  assert.equal(cur.critiques[0]?.verdict, 'revise')
  assert.equal(cur.decisions[0]?.by, 'lead', 'the decision owner records the decision')
  assert.deepEqual(task(cur, 'T-2').acceptance, ['README documents every command', 'README covers setup'], 'revised plan adopted')
  assert.equal(task(cur, 'T-1').state, 'ready')
  assert.equal(task(cur, 'T-2').state, 'waiting')
  assert.deepEqual(task(cur, 'T-2').dependsOn, ['T-1'])
  const verify = task(cur, 'T-3')
  assert.equal(verify.kind, 'test', 'the plan had no verification task, so the workflow added one')
  assert.equal(verify.autoVerify, true)
  assert.equal(verify.ownerId, 'qa')
  assert.deepEqual(verify.dependsOn, ['T-1', 'T-2'])

  h.wf.start(p.id)
  await h.wf.settle(p.id)
  cur = h.store.get(p.id) as Project
  const seq = h.calls.slice(3).map((c) => `${c.kind}:${c.agent.id}:${c.ref}`)
  assert.deepEqual(seq, ['work:builder:T-1', 'review:qa:T-1', 'work:builder:T-1', 'review:qa:T-1', 'work:writer:T-2', 'review:critic:T-2', 'work:qa:T-3', 'review:critic:T-3', 'final-review:lead:FINAL'])
  assert.ok(h.calls.every((c) => c.readOnly === (c.kind !== 'work')), 'only work turns may write')
  assert.equal(cur.verification?.state, 'passed')
  assert.deepEqual(cur.verification?.taskIds, ['T-3'])
  const repair = h.calls[5]
  assert.ok(repair?.note.includes('done crashes on an unknown id'), 'repair attempt carries the review findings')
  assert.ok(h.calls.filter((c) => c.kind === 'review').every((c) => c.sessionScope === 'review'), 'reviews run in their own session scope')
  assert.ok(h.calls.every((c) => c.cwd === cur.workspace), 'every turn runs in the project workspace')
  assert.ok(h.calls.every((c) => c.context.includes(cur.workspace)), 'every turn gets the shared project context')

  const t1 = task(cur, 'T-1')
  assert.equal(t1.state, 'accepted')
  assert.equal(t1.attempts, 2)
  assert.deepEqual(t1.reviews.map((r) => `${r.reviewerId}:${r.verdict}`), ['qa:reject', 'qa:approve'])
  assert.notEqual(t1.reviews[0]?.reviewerId, t1.ownerId)
  assert.deepEqual(t1.artifacts, [path.join(cur.workspace, 'todo.js')])
  const t2 = task(cur, 'T-2')
  assert.equal(t2.state, 'accepted')
  assert.deepEqual(t2.artifacts, [path.join(cur.workspace, 'README.md')], 'missing artifacts are not recorded as delivered')
  assert.ok(t2.history.some((e) => e.text.includes('missing.md')), 'missing artifacts are reported')
  assert.equal(cur.phase, 'done')
  assert.ok(cur.decisions.some((d) => d.decision.startsWith('Delivery accepted')))
  assert.equal(cur.runs.filter((r) => r.status === 'running').length, 0)
  assert.ok(cur.runs.every((r) => r.status === 'ok'))
})

test('dependent tasks never start before their prerequisite is accepted', async () => {
  const order: string[] = []
  const h = harness((req) => {
    order.push(`${req.kind}:${req.ref}`)
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const p = h.newProject()
  h.wf.kickoff(p.id, 'todo app')
  await h.wf.settle(p.id)
  assert.ok(order.indexOf('work:T-2') > order.indexOf('review:T-1'), order.join(' '))
  assert.equal(h.store.get(p.id)?.phase, 'done')
})

test('bounded retries: a routine task escalates to a stronger implementer, then fails and waits for the user', async () => {
  let approveNow = false
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('junior', 'qa', { tier: 'routine' })
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approveNow ? approve(req.ref) : reject(req.ref, 'still wrong')
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  let t = task(h.store.get(p.id) as Project, 'T-1')
  assert.deepEqual(h.calls.filter((c) => c.kind === 'work').map((c) => c.agent.id), ['junior', 'junior', 'builder'], 'last attempt escalated to the critical-tier implementer')
  assert.equal(t.state, 'failed')
  assert.equal(t.attempts, 3)
  assert.match(t.reason ?? '', /Rejected after 3 of 3 attempts/)
  assert.ok(t.history.some((e) => e.text.startsWith('Escalated from JUNIOR to BUILDER')))
  const before = h.calls.length
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.calls.length, before, 'nothing runs after exhaustion without the user')

  approveNow = true
  h.wf.retryTask(p.id, 'T-1')
  await h.wf.settle(p.id)
  t = task(h.store.get(p.id) as Project, 'T-1')
  assert.equal(t.state, 'accepted')
  assert.equal(t.maxAttempts, 6, 'retry grants a new bounded budget')
})

test('malformed handoffs are retried with the error, then fail; free-text "done" never completes a task', async () => {
  const replies = ['All done!', '```team-handoff\n{"task":"T-1","status":"implemented",}\n```', block('handoff', { task: 'T-1', status: 'implemented', summary: 'x', artifacts: [] })]
  const h = harness((req, n) => {
    if (req.kind === 'plan') return singleTask('builder', 'qa')
    if (req.kind === 'work') return replies.shift() ?? `nothing ${n}`
    throw new Error('no review expected')
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  const t = task(h.store.get(p.id) as Project, 'T-1')
  assert.equal(t.state, 'failed')
  assert.equal(t.attempts, 3)
  assert.match(t.reason ?? '', /No valid handoff after 3 attempts/)
  assert.match(t.reason ?? '', /no evidence/, 'the last validation error is shown')
  assert.ok(t.history.some((e) => /no team-handoff block found/.test(e.text)))
  const repairs = h.calls.filter((c) => c.kind === 'work').slice(1)
  assert.ok(repairs.every((c) => c.note.includes('no valid completion report')), 'the owner is told why')
})

test('a malformed plan gets one correction turn; a second failure needs attention and Resume re-runs it', async () => {
  let bad = 3
  const h = harness((req) => {
    if (req.kind === 'plan') return bad-- > 0 ? block('plan', { tasks: [{ key: 'a', title: 'A', owner: 'nobody', acceptance: ['x'] }] }) : singleTask('builder', 'qa')
    throw new Error('unexpected')
  })
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  let cur = h.store.get(p.id) as Project
  assert.equal(h.calls.length, 2)
  assert.ok(h.calls[1]?.note.includes('unknown owner "nobody"'), 'correction names the error')
  assert.equal(cur.phase, 'needs-attention')
  assert.equal(cur.pendingStep, 'plan')
  assert.equal(cur.tasks.length, 0)
  h.wf.resume(p.id)
  await h.wf.settle(p.id)
  cur = h.store.get(p.id) as Project
  assert.equal(cur.phase, 'plan-ready')
  assert.deepEqual(cur.tasks.map((t) => `${t.id}:${t.kind}`), ['T-1:implement', 'T-2:test'], 'the planned task plus the workflow’s verification task')
})

test('cancelling a prerequisite blocks its dependents until the user edits them', async () => {
  const h = harness((req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  h.wf.cancelTask(p.id, 'T-1', 'out of scope')
  h.wf.start(p.id)
  await h.wf.settle(p.id)
  let cur = h.store.get(p.id) as Project
  assert.equal(task(cur, 'T-1').state, 'cancelled')
  assert.equal(task(cur, 'T-2').state, 'blocked')
  assert.equal(task(cur, 'T-2').blockedOn, 'dependency')
  assert.equal(h.calls.filter((c) => c.kind === 'work').length, 0)
  assert.throws(() => h.wf.retryTask(p.id, 'T-2'), WorkflowError)
  h.wf.updateTask(p.id, 'T-2', { dependsOn: [] })
  await h.wf.settle(p.id)
  cur = h.store.get(p.id) as Project
  assert.equal(task(cur, 'T-2').state, 'accepted')
  assert.equal(cur.phase, 'done')
})

test('Stop interrupts the running task without consuming the attempt; it never re-runs until Resume', async () => {
  let hang = true
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('builder', 'qa')
    if (req.kind === 'work' && hang) {
      return new Promise((resolve) => req.signal.addEventListener('abort', () => resolve({ text: '', error: 'Stopped.', activity: [] })))
    }
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await waitFor(() => h.calls.some((c) => c.kind === 'work'), 'work to start')
  assert.equal(task(h.store.get(p.id) as Project, 'T-1').state, 'running')
  assert.throws(() => h.wf.retryTask(p.id, 'T-1'), /already running/, 'no duplicate dispatch of a running task')
  h.wf.stop(p.id)
  await h.wf.settle(p.id)
  let cur = h.store.get(p.id) as Project
  let t = task(cur, 'T-1')
  assert.equal(t.state, 'interrupted')
  assert.equal(t.attempts, 0, 'a stopped attempt is refunded')
  assert.equal(cur.runs.at(-1)?.status, 'stopped')
  assert.equal(cur.paused, true)
  const n = h.calls.length
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(h.calls.length, n)

  hang = false
  h.wf.retryTask(p.id, 'T-1')
  await h.wf.settle(p.id)
  cur = h.store.get(p.id) as Project
  t = task(cur, 'T-1')
  assert.equal(t.state, 'accepted')
  assert.equal(t.attempts, 1)
})

test('restart: in-flight runs become interrupted, nothing is replayed automatically, Resume continues', async () => {
  const h = harness((req) => {
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  // Simulate a crash in the middle of T-1's review: persisted state says "reviewing", a run is "running".
  h.store.update(p.id, (x) => {
    x.phase = 'executing'
    const t = x.tasks.find((y) => y.id === 'T-1')
    if (t) {
      t.state = 'reviewing'
      t.attempts = 1
    }
    x.runs.push({ id: 'r-crash', kind: 'review', ref: 'T-1', agentId: 'qa', startedAt: Date.now(), status: 'running' })
  })

  const calls: string[] = []
  const store2 = new ProjectStore(h.dataDir)
  assert.deepEqual(store2.recovered, [p.id])
  const wf2 = new Workflow({
    getTeam: () => h.team,
    projects: store2,
    members: (c) => h.members.get(c) ?? [],
    note: () => {},
    changed: () => {},
    runTurn: async (req) => {
      calls.push(`${req.kind}:${req.ref}`)
      return { text: req.kind === 'review' ? approve(req.ref) : req.kind === 'work' ? handoff(req.ref) : block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' }), activity: [] }
    },
  })
  let cur = store2.get(p.id) as Project
  assert.equal(task(cur, 'T-1').state, 'interrupted')
  assert.equal(task(cur, 'T-1').resumeTo, 'implemented')
  assert.equal(cur.runs.find((r) => r.id === 'r-crash')?.status, 'interrupted')
  wf2.pumpAll()
  await wf2.settle(p.id)
  assert.deepEqual(calls, [], 'no automatic replay after restart')

  wf2.retryTask(p.id, 'T-1')
  await wf2.settle(p.id)
  cur = store2.get(p.id) as Project
  assert.equal(calls[0], 'review:T-1', 'resume continues with the review, not by redoing the work')
  assert.equal(task(cur, 'T-1').attempts, 1)
  assert.equal(cur.phase, 'done')
})

test('recover() also turns an interrupted planning step into needs-attention with a pending step', () => {
  const p = { phase: 'planning', runs: [], tasks: [], pendingStep: 'critique' } as unknown as Project
  assert.equal(recover(p, 1), true)
  assert.equal(p.phase, 'needs-attention')
  assert.equal(p.pendingStep, 'critique')
})

test('duplicate dispatch: a second kickoff while planning is refused and only one run is ever in flight', async () => {
  const h = harness(async (req) => {
    await new Promise((r) => setTimeout(r, 5))
    if (req.kind === 'plan') return block('plan', twoTaskPlan)
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  assert.throws(() => h.wf.kickoff(p.id, 'again'), (err: unknown) => err instanceof WorkflowError && err.status === 409)
  await h.wf.settle(p.id)
  h.wf.start(p.id)
  assert.throws(() => h.wf.start(p.id) && h.wf.kickoff(p.id, 'x'), WorkflowError)
  h.wf.pumpAll()
  h.wf.pumpAll()
  await h.wf.settle(p.id)
  assert.equal(h.maxConcurrent(), 1)
  assert.equal(h.calls.filter((c) => c.kind === 'work' && c.ref === 'T-1').length, 1)
})

test('two projects in the same workspace never run writers at the same time', async () => {
  let writers = 0
  let peak = 0
  const h = harness(async (req) => {
    if (req.kind === 'plan') return singleTask('builder', 'qa')
    // The verification owner (qa) has read-only tools and needs no writer lock; count real writers.
    if (req.kind === 'work' && canWrite(req.agent)) {
      writers++
      peak = Math.max(peak, writers)
      await new Promise((r) => setTimeout(r, 15))
      writers--
      return handoff(req.ref)
    }
    if (req.kind === 'review') return approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const a = h.newProject('A')
  const b = h.newProject('B')
  assert.equal(a.workspace, b.workspace)
  h.wf.kickoff(a.id, 'x')
  h.wf.kickoff(b.id, 'y')
  await waitFor(() => h.store.get(a.id)?.phase === 'done' && h.store.get(b.id)?.phase === 'done', 'both projects done')
  assert.equal(peak, 1)
})

test('override needs a reason and is recorded; blocked handoffs wait for the user', async () => {
  let blockedOnce = true
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('builder', 'qa')
    if (req.kind === 'work' && blockedOnce) {
      blockedOnce = false
      return block('handoff', { task: 'T-1', status: 'blocked', question: 'Which database?' })
    }
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return req.ref === 'T-1' ? reject(req.ref, 'style nit') : approve(req.ref)
    return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  h.team.settings.maxTaskAttempts = 1
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  let t = task(h.store.get(p.id) as Project, 'T-1')
  assert.equal(t.state, 'blocked')
  assert.equal(t.blockedOn, 'user')
  assert.equal(t.attempts, 0)
  assert.ok(h.notes.some((n) => n.includes('Which database?')))

  h.wf.retryTask(p.id, 'T-1')
  await h.wf.settle(p.id)
  t = task(h.store.get(p.id) as Project, 'T-1')
  assert.equal(t.state, 'failed')
  assert.throws(() => h.wf.overrideTask(p.id, 'T-1', 'accept', '  '), /needs a reason/)
  h.wf.overrideTask(p.id, 'T-1', 'accept', 'nit only; shipping')
  await h.wf.settle(p.id)
  const cur = h.store.get(p.id) as Project
  t = task(cur, 'T-1')
  assert.equal(t.state, 'accepted')
  assert.equal(t.reviews.at(-1)?.override, true)
  assert.equal(t.reviews.at(-1)?.reviewerId, 'user')
  assert.equal(cur.phase, 'done')
})

test('a rejected final review creates a fix task, which is reviewed before the next final review', async () => {
  let finals = 0
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('builder', 'qa')
    if (req.kind === 'work') return handoff(req.ref)
    if (req.kind === 'review') return approve(req.ref)
    return ++finals === 1 ? block('review', { task: 'FINAL', verdict: 'reject', findings: ['README missing'], evidence: 'x' }) : block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'ok' })
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const p = h.newProject()
  h.wf.kickoff(p.id, 'x')
  await h.wf.settle(p.id)
  const cur = h.store.get(p.id) as Project
  const fix = cur.tasks.find((t) => t.kind === 'fix')
  assert.ok(fix, 'a fix task was created')
  assert.equal(fix.id, 'T-3', 'after T-1 and the verification task T-2')
  assert.deepEqual(fix.acceptance, ['README missing'])
  assert.equal(fix.state, 'accepted')
  assert.notEqual(fix.reviewerId, fix.ownerId)
  assert.equal(cur.phase, 'done')
  assert.equal(finals, 2)
})

test('only the decision owner changes the board from chat; bad ops are reported', async () => {
  const h = harness(() => {
    throw new Error('no turns')
  })
  const p = h.newProject()
  const op = '```team-task\n{"op":"create","title":"Add CI","owner":"BUILDER","reviewer":"qa","acceptance":["CI runs npm test"]}\n```\n```team-task\n{"op":"create","title":"bad"}\n```'
  assert.match(h.wf.applyChatOps(p.conversationId, 'builder', op)[0] ?? '', /only the decision owner/)
  assert.equal(h.store.get(p.id)?.tasks.length, 0)
  const results = h.wf.applyChatOps(p.conversationId, 'lead', op)
  await h.wf.settle(p.id)
  assert.ok(results.some((r) => r.startsWith('Created T-1')))
  assert.ok(results.some((r) => r.startsWith('Not applied')))
  assert.equal(h.store.get(p.id)?.tasks[0]?.reviewerId, 'qa')
})

test('task edits are validated: own reviewer, self/cyclic dependencies, non-members', () => {
  const h = harness(() => '')
  const p = h.newProject()
  const t1 = h.wf.createTask(p.id, { title: 'a', ownerId: 'builder', acceptance: ['x'] })
  assert.ok(t1.reviewerId && t1.reviewerId !== 'builder', 'a reviewer other than the owner is picked')
  assert.notEqual(h.team.providers[h.team.agents.find((a) => a.id === t1.reviewerId)?.provider ?? '']?.kind, 'codex', 'prefers another provider kind than the owner')
  const t2 = h.wf.createTask(p.id, { title: 'b', ownerId: 'junior', dependsOn: [t1.id], acceptance: ['y'] })
  assert.throws(() => h.wf.updateTask(p.id, t1.id, { dependsOn: [t2.id] }), /cycle/)
  assert.throws(() => h.wf.updateTask(p.id, t1.id, { dependsOn: [t1.id] }), /itself/)
  assert.throws(() => h.wf.updateTask(p.id, t1.id, { reviewerId: 'builder' }), /someone other than the owner/)
  assert.throws(() => h.wf.createTask(p.id, { title: 'c', ownerId: 'ghost', acceptance: ['z'] }), /not a member/)
  assert.throws(() => h.wf.createTask(p.id, { title: 'c', ownerId: 'builder', acceptance: [] }), /acceptance/)
  assert.equal(createsCycle([t1, t2], t1.id, [t2.id]), true)
})

test('refreshWaiting and resolveArtifacts are pure and safe', () => {
  const ws = harness(() => '').team.workspace
  writeFileSync(path.join(ws, 'a.txt'), 'x')
  const r = resolveArtifacts(['a.txt', '../escape.txt', '/etc/passwd', 'nope.txt'], ws)
  assert.deepEqual(r.found, [path.join(ws, 'a.txt')])
  assert.deepEqual(r.missing, ['../escape.txt', '/etc/passwd', 'nope.txt'])
  const p = { tasks: [{ id: 'T-1', state: 'accepted', dependsOn: [] }, { id: 'T-2', state: 'waiting', dependsOn: ['T-1'] }] } as unknown as Project
  assert.equal(refreshWaiting(p), true)
  assert.equal(p.tasks[1]?.state, 'ready')
  assert.ok(existsSync(path.join(ws, 'a.txt')))
})

test('project context is per project: no brief, board or workspace leaks between projects', () => {
  const h = harness(() => '')
  const a = h.newProject('Alpha', h.team.workspace)
  const b = h.newProject('Beta', path.join(h.team.workspace, 'beta'))
  h.wf.update(a.id, { brief: 'ALPHA-SECRET payments service' })
  h.wf.update(b.id, { brief: 'beta landing page' })
  h.wf.createTask(a.id, { title: 'alpha task', ownerId: 'builder', acceptance: ['x'] })
  const name = (id: string) => id
  const ca = projectContext(h.store.get(a.id) as Project, name)
  const cb = projectContext(h.store.get(b.id) as Project, name)
  assert.ok(ca.includes('ALPHA-SECRET') && ca.includes('alpha task'))
  assert.ok(!cb.includes('ALPHA-SECRET') && !cb.includes('alpha task'))
  assert.ok(cb.includes(path.join(h.team.workspace, 'beta')))
})
