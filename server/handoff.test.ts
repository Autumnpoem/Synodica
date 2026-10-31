import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findBlocks, parseCritique, parseHandoff, parsePlan, parseReview, parseTaskOps, resolveAgent } from './handoff.js'
import { parseCommand } from './projectio.js'
import { member } from './testkit.js'

const members = [member('lead', 'claude', ['lead']), member('builder', 'codex', ['implementer']), member('qa', 'claude', ['tester'])]

test('findBlocks returns every tagged block in order and ignores other code blocks', () => {
  const text = 'x\n```js\n{"a":1}\n```\n```team-review\n{"n":1}\n```\n``` team-review\n{"n":2}\n```'
  assert.deepEqual(findBlocks(text, 'review'), ['{"n":1}', '{"n":2}'])
  assert.deepEqual(findBlocks(text, 'plan'), [])
})

test('parsePlan validates owners, reviewers, acceptance, dependencies and cycles', () => {
  const ok = parsePlan('```team-plan\n{"summary":"s","tasks":[{"key":"a","title":"A","owner":"@BUILDER","reviewer":"qa","acceptance":["x"]},{"key":"b","title":"B","owner":"qa","dependsOn":["a"],"acceptance":"y","kind":"docs","tier":"routine"}]}\n```', members)
  assert.ok(ok.ok)
  if (ok.ok) {
    assert.equal(ok.value.tasks[0]?.owner, 'builder')
    assert.deepEqual(ok.value.tasks[1]?.acceptance, ['y'])
    assert.equal(ok.value.tasks[1]?.kind, 'docs')
    assert.equal(ok.value.tasks[0]?.tier, 'standard', 'default tier')
  }
  const bad = (body: string): string => {
    const r = parsePlan(`\`\`\`team-plan\n${body}\n\`\`\``, members)
    assert.equal(r.ok, false)
    return r.ok ? '' : r.error
  }
  assert.match(bad('{"tasks":[]}'), /no tasks/)
  assert.match(bad('{"tasks":[{"title":"A","owner":"ghost","acceptance":["x"]}]}'), /unknown owner "ghost"/)
  assert.match(bad('{"tasks":[{"title":"A","owner":"qa","reviewer":"qa","acceptance":["x"]}]}'), /reviewed by its own owner/)
  assert.match(bad('{"tasks":[{"title":"A","owner":"qa"}]}'), /no acceptance criteria/)
  assert.match(bad('{"tasks":[{"key":"a","title":"A","owner":"qa","dependsOn":["zz"],"acceptance":["x"]}]}'), /unknown key "zz"/)
  assert.match(bad('{"tasks":[{"key":"a","title":"A","owner":"qa","dependsOn":["b"],"acceptance":["x"]},{"key":"b","title":"B","owner":"qa","dependsOn":["a"],"acceptance":["x"]}]}'), /cycle/)
  assert.match(bad('not json'), /not valid JSON/)
  assert.match(bad('[1,2]'), /must be a JSON object/)
  const none = parsePlan('I will do it, trust me', members)
  assert.equal(none.ok, false)
})

test('parseHandoff requires evidence for implemented, a question for blocked, and the right task', () => {
  assert.equal(parseHandoff('```team-handoff\n{"task":"T-1","status":"implemented","summary":"x","evidence":"tests pass","artifacts":"a.ts"}\n```', 'T-1').ok, true)
  const noEvidence = parseHandoff('```team-handoff\n{"task":"T-1","status":"implemented"}\n```', 'T-1')
  assert.ok(!noEvidence.ok && /no evidence/.test(noEvidence.error))
  const wrong = parseHandoff('```team-handoff\n{"task":"T-9","status":"implemented","evidence":"x"}\n```', 'T-1')
  assert.ok(!wrong.ok && /for T-9/.test(wrong.error))
  const status = parseHandoff('```team-handoff\n{"status":"done","evidence":"x"}\n```', 'T-1')
  assert.ok(!status.ok && /status must be/.test(status.error))
  const blocked = parseHandoff('```team-handoff\n{"status":"blocked","question":"Which DB?"}\n```', 'T-1')
  assert.ok(blocked.ok && blocked.value.question === 'Which DB?')
  assert.equal(parseHandoff('```team-handoff\n{"status":"blocked"}\n```', 'T-1').ok, false)
  // The last block wins, so a model can correct itself in one message.
  const last = parseHandoff('```team-handoff\n{"status":"x"}\n```\n```team-handoff\n{"status":"implemented","evidence":"ok"}\n```', 'T-1')
  assert.equal(last.ok, true)
})

test('parseReview: rejections need findings, approvals need evidence', () => {
  assert.equal(parseReview('```team-review\n{"task":"T-1","verdict":"approve","evidence":"ran it"}\n```', 'T-1').ok, true)
  assert.equal(parseReview('```team-review\n{"verdict":"approve"}\n```', 'T-1').ok, false)
  assert.equal(parseReview('```team-review\n{"verdict":"reject","findings":[]}\n```', 'T-1').ok, false)
  assert.equal(parseReview('```team-review\n{"verdict":"maybe"}\n```', 'T-1').ok, false)
  assert.equal(parseReview('```team-review\n{"task":"FINAL","verdict":"reject","findings":["x"]}\n```', 'FINAL').ok, true)
  assert.equal(parseCritique('```team-critique\n{"verdict":"revise"}\n```').ok, false)
  assert.equal(parseCritique('```team-critique\n{"verdict":"approve"}\n```').ok, true)
})

test('parseTaskOps keeps valid ops and reports invalid ones', () => {
  const r = parseTaskOps('```team-task\n{"op":"update","task":"T-2","owner":"qa"}\n```\n```team-task\n{"op":"cancel","task":"T-3"}\n```\n```team-task\n{"op":"create","title":"x","owner":"nobody","acceptance":["a"]}\n```\n```team-task\n{"op":"explode"}\n```', members)
  assert.deepEqual(r.ops.map((o) => o.op), ['update', 'cancel'])
  assert.equal(r.errors.length, 2)
  assert.equal(resolveAgent('@Builder', members)?.id, 'builder')
})

test('project chat commands', () => {
  assert.deepEqual(parseCommand('/kickoff Build a CLI'), { name: 'kickoff', rest: 'Build a CLI' })
  assert.deepEqual(parseCommand('/continue'), { name: 'start', rest: '' })
  assert.equal(parseCommand('please /kickoff'), null)
  assert.equal(parseCommand('/kickoffs'), null)
})
