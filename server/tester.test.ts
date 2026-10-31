// Automatic verification owners must really be able to run commands in a project turn. A tester
// role on an adapter without a project shell (API employees) is never handed the test task.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { block, harness, member, mixedTeam, tmp, type Script } from './testkit.js'
import { commandAccess } from './workflow.js'
import type { Project, ProviderKind, Team } from '../shared/types.js'

const passing = [{ check: 'npm test', result: 'pass', detail: 'npm test: 3 passed' }]
const script: Script = (req) => {
  if (req.kind === 'work') return block('handoff', { task: req.ref, status: 'implemented', summary: 'done', artifacts: [], evidence: 'npm test: 3 passed', checks: passing })
  if (req.kind === 'review') return block('review', { task: req.ref, verdict: 'approve', findings: [], evidence: 'read the change' })
  if (req.kind === 'final-review') return block('review', { task: 'FINAL', verdict: 'approve', findings: [], evidence: 'consistent' })
  throw new Error(`unexpected turn ${req.kind}`)
}
const get = (h: { store: { get: (id: string) => Project | undefined } }, id: string): Project => {
  const p = h.store.get(id)
  assert.ok(p)
  return p
}

test('command access per provider kind: Bash must be granted and the adapter must have a project shell', () => {
  const kinds: ProviderKind[] = ['claude', 'codex', 'gemini', 'openai']
  const expected: Record<ProviderKind, [withBash: boolean, withoutBash: boolean]> = {
    claude: [true, false],
    codex: [true, false],
    gemini: [true, false],
    openai: [false, false],
  }
  for (const kind of kinds) {
    const withBash = member('x', kind, ['tester'], { tools: ['Read', 'Bash'] })
    const without = member('y', kind, ['tester'], { tools: ['Read', 'Edit', 'Write'] })
    assert.equal(commandAccess(withBash, kind).ok, expected[kind][0], `${kind} with Bash`)
    assert.equal(commandAccess(without, kind).ok, expected[kind][1], `${kind} without Bash`)
  }
  const api = commandAccess(member('z', 'deepseek', ['tester'], { tools: ['Read', 'Bash'] }), 'openai')
  assert.ok(!api.ok && /API provider/.test(api.reason), 'the reason names the API limitation')
})

test('provider matrix: a tester on an API provider is never handed the automatic verification task', async () => {
  const team = mixedTeam(tmp('ogb-ws-'))
  // The only "tester" runs on DeepSeek (API) and even lists Bash; a Claude member with Bash is not a tester.
  team.agents = [
    member('lead', 'claude', ['lead', 'reviewer'], { tier: 'critical' }),
    member('builder', 'codex', ['implementer'], { tier: 'critical' }),
    member('apiqa', 'deepseek', ['tester', 'reviewer'], { tools: ['Read', 'Glob', 'Grep', 'Bash'] }),
    member('shell', 'claude', ['reviewer'], { tools: ['Read', 'Glob', 'Grep', 'Bash'] }),
  ]
  const h = harness(script, { team })
  const p = h.newProject()
  h.wf.createTask(p.id, { title: 'Build it', ownerId: 'builder', acceptance: ['works'] })
  h.wf.start(p.id)
  const verify = get(h, p.id).tasks.find((t) => t.kind === 'test')
  assert.ok(verify, 'a verification task was added')
  assert.equal(verify.ownerId, 'shell', 'the member who can run commands owns it, not the API tester')
  await h.wf.settle(p.id)
  assert.ok(!h.calls.some((c) => c.kind === 'work' && c.agent.id === 'apiqa'), 'the API tester never got a test turn')
  assert.equal(get(h, p.id).phase, 'done')
})

test('provider matrix: an API-only team blocks with an actionable reason, then honours your not-applicable decision', async () => {
  const team: Team = mixedTeam(tmp('ogb-ws-'))
  team.agents = [
    member('lead', 'deepseek', ['lead', 'reviewer'], { tier: 'critical' }),
    member('builder', 'kimi', ['implementer'], { tier: 'critical', tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash'] }),
    member('qa', 'deepseek', ['tester', 'reviewer'], { tools: ['Read', 'Glob', 'Grep', 'Bash'] }),
  ]
  const h = harness(script, { team })
  const p = h.newProject()
  h.wf.createTask(p.id, { title: 'Build it', ownerId: 'builder', reviewerId: 'qa', acceptance: ['works'] })
  h.wf.start(p.id)
  assert.ok(!get(h, p.id).tasks.some((t) => t.kind === 'test'), 'no impossible test task was assigned')
  assert.ok(h.notes.some((n) => /No verification task was added: Nobody on this project can run tests/.test(n) && /API provider/.test(n)), 'the chat says why')
  await h.wf.settle(p.id)
  let cur = get(h, p.id)
  assert.equal(cur.phase, 'needs-attention')
  assert.equal(cur.pendingStep, 'verification')
  assert.match(cur.reason ?? '', /Nobody on this project can run tests or a build/)
  assert.match(cur.reason ?? '', /not applicable/)
  assert.ok(!h.calls.some((c) => c.kind === 'final-review'), 'the gate was not bypassed')

  h.wf.setVerification(p.id, 'not-applicable', 'Static site checked by hand; no test runner')
  await h.wf.settle(p.id)
  cur = get(h, p.id)
  assert.equal(cur.verification?.state, 'not-applicable')
  assert.equal(cur.phase, 'done')
})
