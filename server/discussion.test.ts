import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDecision, parseObjections } from './handoff.js'
import { ProjectStore, recover } from './projects.js'
import { block, harness, member, type Script, twoTaskPlan } from './testkit.js'
import { discussionEnabled, projectContext } from './workflow.js'
import type { Project } from '../shared/types.js'

const objection = { claim: 'The data may be lost', reason: 'Concurrent writes replace the same file', basis: 'hypothesis', severity: 'blocking', citations: [], proposal: 'Use a transaction' }
const empty = block('objections', { items: [] })
function script(disposition = 'rejected'): Script {
  return (r) => {
    if (r.kind === 'plan') return block('plan', twoTaskPlan)
    if (r.kind === 'discuss') return r.agent.id === 'writer' ? block('objections', { items: [objection] }) : empty
    if (r.kind === 'critique') return block('critique', { verdict: 'approve', issues: [] })
    if (r.kind === 'decide') return block('decision', { decision: 'Proceed with recorded tradeoff', rationale: 'Single writer in this release', objections: r.project.objections?.filter((o) => o.status === 'open').map((o) => ({ id: o.id, disposition, reason: 'Single writer in this release' })) })
    if (r.kind === 'work') return block('handoff', { task: r.ref, status: 'implemented', summary: 'done', artifacts: [], evidence: 'checked', checks: [{ check: 'user flow', result: 'pass', detail: 'scripted fixture checked' }] })
    return block('review', { task: r.ref, verdict: 'approve', findings: [], evidence: 'checked' })
  }
}
async function planned(run = script()) {
  const h = harness(run)
  h.team.settings.planDiscussion = 'on'
  const p = h.newProject()
  h.wf.kickoff(p.id, 'Build it')
  await h.wf.settle(p.id)
  return { h, p }
}
function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { open, wait }
}
async function until(test: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (test()) return; await new Promise((r) => setTimeout(r, 2)) }
  throw new Error('Timed out waiting for scripted turn')
}

test('discussion parser preserves objections, labels unsupported evidence and reports invalid and excess items', () => {
  const out = parseObjections(block('objections', { items: [{ ...objection, claim: '  Exact words  ', basis: 'evidence' }, {}, ...Array.from({ length: 5 }, () => objection)] }))
  assert.equal(out.items[0]?.claim, 'Exact words')
  assert.equal(out.items[0]?.basis, 'hypothesis')
  assert.equal(out.invalid, 1)
  assert.equal(out.overflow, 2)
  assert.equal(parseObjections(empty).items.length, 0)
  assert.equal(parseObjections('ordinary prose').invalid, 1)
  assert.equal(parseObjections(block('objections', { items: [{ ...objection, claim: 'x'.repeat(2001) }] })).items[0]?.truncated, true)
})

test('decision parser requires every open objection exactly once with a reason', () => {
  const d = { decision: 'Proceed', rationale: 'why' }
  assert.equal(parseDecision(block('decision', d)).ok, true)
  assert.equal(parseDecision(block('decision', d), ['O-1']).ok, false)
  for (const objections of [[{ id: 'O-2', disposition: 'accepted', reason: 'yes' }], [{ id: 'O-1', disposition: 'rejected', reason: '' }], Array(2).fill({ id: 'O-1', disposition: 'accepted', reason: 'yes' })]) assert.equal(parseDecision(block('decision', { ...d, objections }), ['O-1']).ok, false)
  assert.equal(parseDecision(block('decision', { ...d, objections: [{ id: 'O-1', disposition: 'unresolved', reason: 'test later' }] }), ['O-1']).ok, true)
})

test('preset defaults are on, custom defaults unchanged, explicit settings win', async () => {
  const h = harness(script())
  assert.equal(discussionEnabled(h.team, h.team.agents), false)
  h.team.agents[0]!.templateSeat = 'company-gpt'
  assert.equal(discussionEnabled(h.team, h.team.agents), true)
  const p = h.newProject()
  h.wf.kickoff(p.id, 'Build it'); await h.wf.settle(p.id)
  assert.deepEqual(h.calls.map((c) => c.kind), ['plan', 'discuss', 'discuss', 'discuss', 'discuss', 'critique', 'decide'])
  assert.ok(h.calls.filter((c) => c.kind === 'discuss').every((c) => c.readOnly && c.sessionScope === 'review'))
  h.team.settings.planDiscussion = 'off'
  assert.equal(discussionEnabled(h.team, h.team.agents), false)
})

test('cross-role dissent and lead rejection remain verbatim in context during execution; permissions and review are preserved', async () => {
  const { h, p } = await planned()
  assert.equal(p.phase, 'plan-ready')
  assert.equal(p.objections?.[0]?.by, 'writer')
  assert.equal(p.objections?.[0]?.status, 'rejected')
  assert.match(h.calls.find((c) => c.kind === 'decide')!.note, /The data may be lost/)
  assert.match(projectContext(p, (id) => id), /writer: "The data may be lost"/)
  h.wf.start(p.id); await h.wf.settle(p.id)
  assert.equal(p.phase, 'done')
  assert.ok(h.calls.filter((c) => c.kind === 'work').every((c) => c.context.includes('Single writer in this release')))
  assert.ok(h.calls.every((c) => c.readOnly === (c.kind !== 'work')))
})

test('caps, muted people and unsupported read-only providers are visibly omitted', async () => {
  const h = harness(script())
  h.team.settings.planDiscussion = 'on'; h.team.settings.maxDiscussionParticipants = 1
  h.team.agents.find((a) => a.id === 'junior')!.muted = true
  h.team.agents.find((a) => a.id === 'qa')!.provider = 'gemini'
  const p = h.newProject(); h.wf.kickoff(p.id, 'Build it'); await h.wf.settle(p.id)
  assert.deepEqual(h.calls.filter((c) => c.kind === 'discuss').map((c) => c.agent.id), ['builder'])
  assert.match(p.discussions?.[0]?.participants.find((a) => a.agentId === 'qa')?.reason ?? '', /read-only/)
  assert.match(p.discussions?.[0]?.participants.find((a) => a.agentId === 'writer')?.reason ?? '', /limit/)
  assert.ok(h.notes.some((n) => n.includes('WRITER: omitted')))
})

test('skip, empty, malformed and failed replies cost one turn each and never imply consensus', async () => {
  const base = script()
  const { h, p } = await planned((r, n) => r.kind !== 'discuss' ? base(r, n) : r.agent.id === 'builder' ? '' : r.agent.id === 'junior' ? empty : r.agent.id === 'qa' ? 'I cannot support this' : { text: '', error: 'offline', activity: [] })
  assert.deepEqual(p.discussions?.[0]?.participants.map((a) => a.status), ['skipped', 'no-objection', 'invalid', 'failed'])
  assert.equal(h.calls.filter((r) => r.kind === 'discuss').length, 4)
  assert.match(h.calls.find((r) => r.kind === 'decide')!.note, /I cannot support this/)
  assert.equal(p.phase, 'plan-ready')
  assert.ok(!p.decisions.some((d) => /consensus|everyone agreed/i.test(d.rationale)))
})

test('missing dispositions fail after one correction turn and do not materialize tasks', async () => {
  const base = script()
  const { h, p } = await planned((r, n) => r.kind === 'decide' ? block('decision', { decision: 'Ignore dissent', rationale: 'wrong' }) : base(r, n))
  assert.equal(h.calls.filter((r) => r.kind === 'decide').length, 2)
  assert.equal(p.phase, 'needs-attention')
  assert.equal(p.tasks.length, 0)
  assert.equal(p.objections?.[0]?.status, 'open')
})

test('needs-user prevents auto execution, requires user reason and then explicit Start; unresolved remains in context', async () => {
  const h = harness(script('needs-user')); h.team.settings.planDiscussion = 'on'; h.team.settings.autoStartExecution = true
  const p = h.newProject(); h.wf.kickoff(p.id, 'Build it'); await h.wf.settle(p.id)
  assert.equal(p.phase, 'plan-ready')
  assert.throws(() => h.wf.start(p.id), /Resolve the objections/)
  assert.throws(() => h.wf.resolveObjection(p.id, 'O-1', 'unresolved', ''), /Explain/)
  h.wf.resolveObjection(p.id, 'O-1', 'unresolved', 'Proceed and monitor')
  assert.match(projectContext(p, (id) => id), /Proceed and monitor/)
  assert.equal(h.calls.some((r) => r.kind === 'work'), false)
  h.wf.start(p.id); await h.wf.settle(p.id); assert.equal(p.phase, 'done')
})

test('Resume after a replan correction still requires the pending user decision', async () => {
  const { h, p } = await planned(script('needs-user'))
  h.wf.beginCorrection(p.id, { id: 'scope-fix', text: 'Also include the migration', mode: 'replan' })
  await h.wf.quiesce(p.id)
  h.wf.finishCorrection(p.id, 'scope-fix')
  assert.equal(p.phase, 'needs-attention')
  assert.throws(() => h.wf.resume(p.id), (error: unknown) => (error as { status?: number }).status === 409)
  await h.wf.settle(p.id)
  assert.equal(h.calls.some((r) => r.kind === 'work'), false)
  h.wf.resolveObjection(p.id, 'O-1', 'accepted', 'Approved the required scope')
  h.wf.resume(p.id); await h.wf.settle(p.id)
  assert.equal(p.phase, 'done')
})

test('task override and continue correction cannot dispatch work past a pending user decision', async () => {
  const { h, p } = await planned(script('needs-user'))
  h.wf.beginCorrection(p.id, { id: 'scope-fix', text: 'Also include the migration', mode: 'replan' })
  await h.wf.quiesce(p.id); h.wf.finishCorrection(p.id, 'scope-fix')
  h.wf.overrideTask(p.id, p.tasks[0]!.id, 'accept', 'This task is already done')
  h.wf.beginCorrection(p.id, { id: 'continue-fix', text: 'Keep the existing implementation', mode: 'continue' })
  await h.wf.quiesce(p.id); h.wf.finishCorrection(p.id, 'continue-fix')
  await h.wf.settle(p.id)
  assert.equal(h.calls.some((r) => r.kind === 'work' || r.kind === 'final-review'), false)
  assert.equal(p.phase, 'needs-attention')
  h.wf.resolveObjection(p.id, 'O-1', 'accepted', 'Approved the required scope')
  h.wf.resume(p.id); await h.wf.settle(p.id)
  assert.equal(p.phase, 'done')
})

test('Stop during discussion discards late objections and Resume only reasks unanswered members', async () => {
  const slow = gate(); let calls = 0; const base = script()
  const h = harness(async (r, n) => { if (r.kind === 'discuss' && r.agent.id === 'junior' && ++calls === 1) { await slow.wait; return block('objections', { items: [objection] }) } return base(r, n) })
  h.team.settings.planDiscussion = 'on'; const p = h.newProject()
  h.wf.kickoff(p.id, 'Build it'); await until(() => calls === 1)
  h.wf.stop(p.id); slow.open(); await h.wf.settle(p.id)
  assert.equal(p.pendingStep, 'discussion'); assert.equal(p.phase, 'needs-attention')
  assert.equal(p.objections?.length ?? 0, 0)
  h.wf.resume(p.id); await h.wf.settle(p.id)
  assert.deepEqual(h.calls.filter((r) => r.kind === 'discuss').map((r) => r.agent.id), ['builder', 'junior', 'junior', 'qa', 'writer'])
  assert.equal(p.phase, 'plan-ready')
})

test('correction mid-discussion prevents the next old participant, ignores late result and begins a new revision', async () => {
  const slow = gate(); let reached = false; const revisions: number[] = []; const base = script()
  const h = harness(async (r, n) => { if (r.kind === 'discuss') revisions.push(r.project.revision ?? 0); if (r.kind === 'discuss' && r.agent.id === 'junior' && !reached) { reached = true; await slow.wait; return block('objections', { items: [objection] }) } return base(r, n) })
  h.team.settings.planDiscussion = 'on'; const p = h.newProject()
  h.wf.kickoff(p.id, 'Build it'); await until(() => reached)
  h.wf.beginCorrection(p.id, { id: 'fix', text: 'Use transactions', mode: 'continue' })
  slow.open(); await h.wf.quiesce(p.id)
  assert.deepEqual(revisions, [0, 0]); assert.equal(p.objections?.length ?? 0, 0)
  h.wf.finishCorrection(p.id, 'fix'); await h.wf.settle(p.id)
  assert.deepEqual(revisions, [0, 0, 1, 1, 1, 1])
  assert.equal(p.discussions?.[0]?.status, 'superseded')
  assert.ok(h.calls.filter((r) => r.kind === 'discuss').slice(2).every((r) => r.context.includes('Use transactions')))
  assert.ok(p.runs.some((r) => r.kind === 'discuss' && r.status === 'superseded'))
})

test('restart retains answered participants and resumes the pending discussion', async () => {
  const { h, p } = await planned()
  const round = p.discussions![0]!
  h.store.update(p.id, (x) => { x.phase = 'planning'; x.pendingStep = 'discussion'; x.tasks = []; round.status = 'running'; round.participants[3]!.status = 'pending'; x.objections = [] })
  const reloaded = new ProjectStore(h.dataDir).get(p.id)!
  assert.equal(reloaded.pendingStep, 'discussion'); assert.equal(reloaded.phase, 'needs-attention')
  assert.equal(reloaded.discussions![0]!.participants[3]!.status, 'stopped')
  const other = harness(script(), { team: h.team, dataDir: h.dataDir }); other.members.set(p.conversationId, h.team.agents.map((a) => a.id))
  other.wf.resume(p.id); await other.wf.settle(p.id)
  assert.deepEqual(other.calls.filter((r) => r.kind === 'discuss').map((r) => r.agent.id), ['writer'])
  assert.equal(other.store.get(p.id)?.phase, 'plan-ready')
})

test('tool-less unsupported adapter may reason and discussion task blocks do not alter the board', async () => {
  const base = script(); const h = harness((r, n) => r.kind === 'discuss' ? empty + block('task', { op: 'create', title: 'Unauthorized', owner: 'builder', acceptance: ['x'] }) : base(r, n))
  h.team.settings.planDiscussion = 'on'; h.team.agents.push(member('reader', 'gemini', [], { tools: [] }))
  const p = h.newProject(); h.wf.kickoff(p.id, 'Build it'); await h.wf.settle(p.id)
  assert.ok(h.calls.some((r) => r.kind === 'discuss' && r.agent.id === 'reader'))
  assert.ok(!p.tasks.some((t) => t.title === 'Unauthorized'))
})

test('old saved projects recover and build context with no discussion fields', () => {
  const h = harness(script()); const p = h.newProject()
  assert.equal(recover(p, Date.now()), false)
  assert.match(projectContext(new ProjectStore(h.dataDir).get(p.id) as Project, (id) => id), /Project "Demo"/)
})
