// Explicit gates and isolation in the project workflow: adding tasks never starts work, the
// verification gate blocks completion, writer locks cover every writing turn (planning and review
// seats too, nested folders and symlink aliases), and the final reviewer is independent.
import assert from 'node:assert/strict'
import { mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { WorkspaceLocks } from './locks.js'
import { block, harness, member, tmp, type Script } from './testkit.js'
import { verificationStatus } from './workflow.js'
import type { Project, Task } from '../shared/types.js'

const passing = [{ check: 'npm test', result: 'pass', detail: 'npm test: 3 passed' }]
const handoff = (task: string) => block('handoff', { task, status: 'implemented', summary: `did ${task}`, artifacts: [], evidence: 'npm test: 3 passed', checks: passing })
const approve = (task: string) => block('review', { task, verdict: 'approve', findings: [], evidence: 'read the files and ran the checks' })
const finalOk = block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'docs match the code' })
const singleTask = (owner: string, reviewer: string) => block('plan', { summary: 's', architecture: 'a', tasks: [{ key: 'only', title: 'Only task', owner, reviewer, acceptance: ['it works'] }] })
/** Everything succeeds; planning yields one task for builder reviewed by critic, with no testing planned. */
const happy: Script = (req) => {
  if (req.kind === 'plan') return singleTask('builder', 'critic')
  if (req.kind === 'work') return handoff(req.ref)
  if (req.kind === 'review') return approve(req.ref)
  if (req.kind === 'final-review') return finalOk
  throw new Error(`unexpected turn ${req.kind} ${req.ref}`)
}
const get = (h: { store: { get: (id: string) => Project | undefined } }, id: string): Project => {
  const p = h.store.get(id)
  assert.ok(p)
  return p
}
const task = (p: Project, id: string): Task => {
  const t = p.tasks.find((x) => x.id === id)
  assert.ok(t, `task ${id} exists`)
  return t
}

async function waitFor(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const until = Date.now() + ms
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 2))
  }
}

test('adding a task to a new project does not start it; Start does, and supplies the verification task', async () => {
  const h = harness(happy)
  h.team.settings.autoStartExecution = false
  const p = h.newProject()
  const t1 = h.wf.createTask(p.id, { title: 'Manual task', ownerId: 'builder', acceptance: ['x works'] })
  await h.wf.settle(p.id)
  let cur = get(h, p.id)
  assert.equal(cur.phase, 'new', 'adding a task does not authorize execution')
  assert.equal(task(cur, t1.id).state, 'ready')
  assert.equal(task(cur, t1.id).attempts, 0)
  assert.equal(h.calls.length, 0, 'the owner was not dispatched')

  h.wf.start(p.id)
  await h.wf.settle(p.id)
  cur = get(h, p.id)
  const verify = cur.tasks.find((t) => t.kind === 'test')
  assert.ok(verify, 'Start added a verification task to the hand-filled board')
  assert.equal(verify.ownerId, 'qa')
  assert.deepEqual(verify.dependsOn, [t1.id])
  assert.deepEqual(h.calls.map((c) => `${c.kind}:${c.ref}`), [`work:${t1.id}`, `review:${t1.id}`, `work:${verify.id}`, `review:${verify.id}`, 'final-review:FINAL'])
  assert.equal(cur.phase, 'done')
  assert.equal(cur.verification?.state, 'passed')

  // After delivery, a new task is a new increment: it waits for Start and needs its own verification.
  const before = h.calls.length
  const t3 = h.wf.createTask(p.id, { title: 'Follow-up', ownerId: 'builder', acceptance: ['y works'] })
  await h.wf.settle(p.id)
  cur = get(h, p.id)
  assert.equal(cur.phase, 'done')
  assert.equal(cur.verification?.state, 'pending', 'the earlier verification does not cover new work')
  assert.equal(h.calls.length, before)
  h.wf.start(p.id)
  await h.wf.settle(p.id)
  cur = get(h, p.id)
  assert.equal(task(cur, t3.id).state, 'accepted')
  const verify2 = cur.tasks.filter((t) => t.kind === 'test').at(-1)
  assert.ok(verify2 && verify2.id !== verify.id && verify2.state === 'accepted', 'the new increment was verified again')
  assert.deepEqual(cur.verification?.taskIds, [verify2.id])
  assert.equal(cur.phase, 'done')
})

test('adding tasks while planning, plan-ready, paused or needs-attention never dispatches the owner', async () => {
  let release: () => void = () => {}
  const planGate = new Promise<void>((r) => (release = r))
  const h = harness(async (req) => {
    if (req.kind === 'plan') {
      await planGate
      return singleTask('builder', 'critic')
    }
    return happy(req, 0)
  })
  h.team.settings.autoStartExecution = false
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  h.wf.kickoff(p.id, 'todo app')
  assert.equal(get(h, p.id).phase, 'planning')
  assert.throws(() => h.wf.createTask(p.id, { title: 'during planning', ownerId: 'builder', acceptance: ['x'] }), /plan is being made/)
  release()
  await h.wf.settle(p.id)
  assert.equal(get(h, p.id).phase, 'plan-ready')
  h.wf.createTask(p.id, { title: 'extra', ownerId: 'junior', acceptance: ['x'] })
  await h.wf.settle(p.id)
  assert.equal(get(h, p.id).phase, 'plan-ready')
  assert.deepEqual(h.calls.map((c) => c.kind), ['plan'], 'nothing ran before Start')

  // Paused: Start then Pause before anything is dispatched; new tasks wait for Resume.
  const q = h.newProject('Paused')
  h.wf.createTask(q.id, { title: 'one', ownerId: 'builder', acceptance: ['x'] })
  h.wf.start(q.id)
  h.wf.pause(q.id)
  h.wf.createTask(q.id, { title: 'two', ownerId: 'builder', acceptance: ['x'] })
  await h.wf.settle(q.id)
  assert.equal(get(h, q.id).phase, 'executing')
  assert.equal(h.calls.filter((c) => c.project.id === q.id).length, 0, 'a paused project starts nothing')
  h.wf.resume(q.id)
  await h.wf.settle(q.id)
  assert.equal(get(h, q.id).phase, 'done')
})

test('verification gate: the model plans no testing and nobody can test → done is blocked until a verification task passes or you record a reason', async () => {
  const h = harness(happy)
  h.team.settings.autoStartExecution = true
  h.team.settings.maxCritiqueRounds = 0
  // No tester and nobody with a shell: the workflow cannot add its own verification task.
  const a = h.newProject('A')
  h.members.set(a.conversationId, ['lead', 'critic', 'builder'])
  h.wf.kickoff(a.id, 'todo app')
  await h.wf.settle(a.id)
  let cur = get(h, a.id)
  assert.equal(task(cur, 'T-1').state, 'accepted', 'the implementation was reviewed and accepted')
  assert.ok(!cur.tasks.some((t) => t.kind === 'test'))
  assert.equal(cur.phase, 'needs-attention', 'not done')
  assert.equal(cur.pendingStep, 'verification')
  assert.match(cur.reason ?? '', /no verification \(test\) task/)
  assert.ok(!h.calls.some((c) => c.kind === 'final-review' && c.project.id === a.id), 'the final review did not run')

  // Adding a verification task does not resume by itself; Resume does, and its passing checks satisfy the gate.
  const vt = h.wf.createTask(a.id, { title: 'Verify the CLI', ownerId: 'critic', reviewerId: 'lead', kind: 'test', acceptance: ['add/list/done flows pass'] })
  await h.wf.settle(a.id)
  assert.equal(get(h, a.id).phase, 'needs-attention')
  h.wf.resume(a.id)
  await h.wf.settle(a.id)
  cur = get(h, a.id)
  assert.equal(task(cur, vt.id).state, 'accepted')
  assert.equal(cur.verification?.state, 'passed')
  assert.deepEqual(cur.verification?.taskIds, [vt.id])
  assert.match(cur.verification?.evidence ?? '', /npm test: pass/)
  assert.equal(cur.phase, 'done')

  // The other way out: your recorded decision, which needs a reason.
  const b = h.newProject('B')
  h.members.set(b.conversationId, ['lead', 'critic', 'builder'])
  h.wf.kickoff(b.id, 'research note')
  await h.wf.settle(b.id)
  assert.equal(get(h, b.id).pendingStep, 'verification')
  assert.throws(() => h.wf.setVerification(b.id, 'not-applicable', '  '), /needs a reason/)
  h.wf.setVerification(b.id, 'not-applicable', 'a written report; nothing to execute')
  await h.wf.settle(b.id)
  cur = get(h, b.id)
  assert.equal(cur.phase, 'done')
  assert.equal(cur.verification?.state, 'not-applicable')
  assert.equal(cur.verification?.reason, 'a written report; nothing to execute')
  assert.ok(cur.decisions.some((d) => d.by === 'user' && d.rationale === 'a written report; nothing to execute'))
})

test('verification gate: approval text without passing checks, a self-review or a pre-increment test never satisfies it', () => {
  const t = (over: Partial<Task>): Task =>
    ({ id: 'T-9', kind: 'test', state: 'accepted', ownerId: 'qa', createdAt: 10, reviews: [{ at: 11, reviewerId: 'critic', verdict: 'approve', findings: [], evidence: 'looks great, all tested' }], checks: [], ...over }) as unknown as Task
  const proj = (tasks: Task[], since?: number) => ({ tasks, verification: { state: 'pending', taskIds: [], ...(since ? { since } : {}) } }) as unknown as Project
  const name = (id: string) => id
  assert.equal(verificationStatus(proj([t({})]), name).ok, false, 'nonempty evidence but no checks')
  assert.equal(verificationStatus(proj([t({ checks: [{ check: 'npm test', result: 'fail', detail: '1 failed' }] })]), name).ok, false, 'failing checks')
  assert.equal(verificationStatus(proj([t({ checks: passing as Task['checks'], reviews: [{ at: 11, reviewerId: 'qa', verdict: 'approve', findings: [], evidence: 'mine' }] })]), name).ok, false, 'self-approval')
  assert.equal(verificationStatus(proj([t({ checks: passing as Task['checks'] })], 50), name).ok, false, 'a test from an earlier increment')
  assert.equal(verificationStatus(proj([t({ checks: passing as Task['checks'] })]), name).ok, true)
  assert.equal(verificationStatus(proj([]), name).ok, false)
})

test('writer locks: canonical roots, nested folders and symlink aliases conflict; refusals never displace the holder', () => {
  const base = realpathSync.native(tmp('ogb-locks-'))
  const ws = path.join(base, 'ws')
  mkdirSync(path.join(ws, 'src', 'deep'), { recursive: true })
  mkdirSync(path.join(base, 'other'))
  symlinkSync(ws, path.join(base, 'alias'), 'dir')
  const locks = new WorkspaceLocks()
  let releases = 0
  locks.onRelease(() => releases++)
  const a = locks.acquire(path.join(ws, 'src'), { owner: 'p1', label: 'T-1 in P1' })
  assert.ok(a.ok)
  assert.equal(a.root, path.join(ws, 'src'))
  for (const [folder, why] of [
    [ws, 'an ancestor'],
    [path.join(ws, 'src', 'deep'), 'a descendant'],
    [path.join(base, 'alias', 'src'), 'a symlink alias of the same folder'],
    [path.join(base, 'alias'), 'an alias of the ancestor'],
    [path.join(ws, 'src', 'not-yet', 'new'), 'a folder that does not exist yet under it'],
  ] as const) {
    const r = locks.acquire(folder, { owner: 'chat', label: 'chat' })
    assert.equal(r.ok, false, why)
    if (!r.ok) assert.equal(r.holder.label, 'T-1 in P1')
  }
  const sibling = locks.acquire(path.join(base, 'other'), { owner: 'p2', label: 'P2' })
  assert.ok(sibling.ok, 'unrelated folders run in parallel')
  assert.deepEqual(locks.list().map((l) => l.owner).sort(), ['p1', 'p2'], 'the holder is still there after the refusals')
  a.release()
  a.release()
  assert.equal(releases, 1, 'release is idempotent')
  assert.ok(locks.acquire(path.join(base, 'alias'), { owner: 'chat', label: 'chat' }).ok)
})

test('writer locks: a planning seat that cannot be held read-only waits for the folder; the refused step is not queued', async () => {
  const locks = new WorkspaceLocks()
  const h = harness(happy, { locks })
  h.team.settings.maxCritiqueRounds = 0
  // The decision owner runs on Gemini, whose turns Synodica cannot hold to read-only, and can write.
  const lead = h.team.agents.find((a) => a.id === 'lead')
  assert.ok(lead)
  lead.provider = 'gemini'
  lead.tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write']
  const p = h.newProject()
  // A chat turn writes in a symlink alias of a parent of the project folder.
  const alias = path.join(tmp('ogb-alias-'), 'link')
  symlinkSync(path.dirname(realpathSync(p.workspace)), alias, 'dir')
  const chat = locks.acquire(alias, { owner: 'conv-general', label: 'BUILDER in chat "general"' })
  assert.ok(chat.ok)

  h.wf.kickoff(p.id, 'todo app')
  await h.wf.settle(p.id)
  let cur = get(h, p.id)
  assert.equal(h.calls.length, 0, 'the planning turn did not run')
  assert.equal(cur.phase, 'needs-attention')
  assert.equal(cur.pendingStep, 'plan')
  assert.match(cur.reason ?? '', /BUILDER in chat "general" is writing in this folder/)
  assert.deepEqual(locks.list().map((l) => l.owner), ['conv-general'], 'the chat writer kept its lock')

  chat.release()
  await h.wf.settle(p.id)
  assert.equal(h.calls.length, 0, 'a refused step is not started automatically when the folder frees up')
  h.wf.resume(p.id)
  await h.wf.settle(p.id)
  cur = get(h, p.id)
  assert.equal(h.calls[0]?.kind, 'plan')
  assert.equal(h.calls[0]?.readOnly, true, 'the step is still requested read-only')
  assert.equal(cur.phase, 'plan-ready')
  assert.deepEqual(locks.list(), [], 'released after the step')
})

test('writer locks: work waits for a busy folder; enforced read-only reviews take no lock; locks are released after errors and cancels', async () => {
  const locks = new WorkspaceLocks()
  let failWork = true
  let locksDuringWork = -1
  let locksDuringReview = -1
  const h = harness(
    async (req) => {
      if (req.kind === 'work' && req.ref === 'T-1' && failWork) {
        failWork = false
        locksDuringWork = locks.list().length
        throw new Error('provider exploded')
      }
      if (req.kind === 'review' && req.ref === 'T-1') locksDuringReview = locks.list().length
      if (req.kind === 'work' && req.ref === 'T-3') {
        await new Promise<void>((resolve) => req.signal.addEventListener('abort', () => resolve(), { once: true }))
        return { text: '', activity: [] }
      }
      return happy(req, 0)
    },
    { locks },
  )
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  const t1 = h.wf.createTask(p.id, { title: 'one', ownerId: 'builder', reviewerId: 'qa', acceptance: ['x'] })
  h.wf.start(p.id)
  await h.wf.settle(p.id)
  assert.equal(task(get(h, p.id), t1.id).state, 'failed')
  assert.equal(locksDuringWork, 1, 'work held the writer lock while it ran')
  assert.deepEqual(locks.list(), [], 'released after a provider error')

  // Someone else writes in the folder: work waits without spending an attempt, a read-only review does not.
  const other = locks.acquire(path.join(p.workspace, 'sub'), { owner: 'conv-x', label: 'JUNIOR in chat "x"' })
  assert.ok(other.ok)
  h.wf.retryTask(p.id, t1.id)
  await h.wf.settle(p.id)
  assert.equal(task(get(h, p.id), t1.id).state, 'ready')
  assert.equal(task(get(h, p.id), t1.id).attempts, 1, 'the waiting attempt was not consumed')
  other.release()
  await waitFor(() => task(get(h, p.id), t1.id).state === 'accepted', 'T-1 accepted after the folder freed up')
  const review = h.calls.find((c) => c.kind === 'review' && c.ref === t1.id)
  assert.ok(review?.readOnly, 'reviews are read-only turns')
  assert.equal(locksDuringReview, 0, 'a review on an adapter that enforces read-only holds no writer lock')
  await h.wf.settle(p.id)
  assert.equal(get(h, p.id).phase, 'done')

  // Cancel a running task: its lock is released.
  const t3 = h.wf.createTask(p.id, { title: 'three', ownerId: 'builder', reviewerId: 'qa', acceptance: ['x'] })
  assert.equal(t3.id, 'T-3')
  h.wf.start(p.id)
  await waitFor(() => h.wf.activeRef(p.id) === t3.id, 'T-3 running')
  assert.equal(locks.list().length, 1)
  h.wf.cancelTask(p.id, t3.id, 'not needed')
  await waitFor(() => locks.list().length === 0, 'lock released after the cancel')
  await h.wf.settle(p.id)
  assert.equal(task(get(h, p.id), t3.id).state, 'cancelled')
  assert.deepEqual(locks.list(), [])
})

test('reviewers who cannot be held read-only are refused; plan reviewers on such providers are replaced', async () => {
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('builder', 'gem')
    return happy(req, 0)
  })
  h.team.agents.push(member('gem', 'gemini', ['reviewer'], { tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'] }))
  h.team.settings.maxCritiqueRounds = 0
  const p = h.newProject()
  assert.throws(() => h.wf.createTask(p.id, { title: 'x', ownerId: 'builder', reviewerId: 'gem', acceptance: ['x'] }), /cannot hold to read-only/)
  h.wf.kickoff(p.id, 'todo app')
  await h.wf.settle(p.id)
  const t1 = task(get(h, p.id), 'T-1')
  assert.ok(t1.reviewerId && t1.reviewerId !== 'gem' && t1.reviewerId !== 'builder', `replaced reviewer: ${t1.reviewerId}`)
})

test('final review: never by an implementer; nobody independent = blocked with a reassignment, not a self-approval', async () => {
  const h = harness((req) => {
    if (req.kind === 'plan') return singleTask('lead', 'qa')
    return happy(req, 0)
  })
  h.team.settings.maxCritiqueRounds = 0
  h.team.settings.autoStartExecution = true
  const lead = h.team.agents.find((a) => a.id === 'lead')
  assert.ok(lead)
  lead.tools = ['Read', 'Glob', 'Grep', 'Edit', 'Write']

  // The decision owner implemented the only task, so someone else runs the final review.
  const a = h.newProject('A')
  h.wf.kickoff(a.id, 'x')
  await h.wf.settle(a.id)
  const fr = h.calls.find((c) => c.project.id === a.id && c.kind === 'final-review')
  assert.ok(fr)
  assert.notEqual(fr.agent.id, 'lead')
  assert.ok(!h.calls.some((c) => c.project.id === a.id && c.kind === 'work' && c.agent.id === fr.agent.id), 'the final reviewer implemented nothing')
  assert.equal(fr.readOnly, true)
  assert.equal(get(h, a.id).phase, 'done')

  // Only the implementer and the tester are in the chat: blocked, with a concrete reason.
  const b = h.newProject('B')
  h.members.set(b.conversationId, ['lead', 'qa'])
  h.wf.kickoff(b.id, 'y')
  await h.wf.settle(b.id)
  let cur = get(h, b.id)
  assert.equal(cur.phase, 'needs-attention')
  assert.equal(cur.pendingStep, 'final-review')
  assert.match(cur.reason ?? '', /No independent final reviewer/)
  assert.ok(!h.calls.some((c) => c.project.id === b.id && c.kind === 'final-review'), 'no self-approval')
  assert.throws(() => h.wf.update(b.id, { finalReviewerId: 'lead' }), /implemented tasks/)

  h.members.set(b.conversationId, ['lead', 'qa', 'critic'])
  h.wf.update(b.id, { finalReviewerId: 'critic' })
  h.wf.resume(b.id)
  await h.wf.settle(b.id)
  cur = get(h, b.id)
  assert.equal(h.calls.filter((c) => c.project.id === b.id && c.kind === 'final-review').at(-1)?.agent.id, 'critic')
  assert.equal(cur.phase, 'done')
})
