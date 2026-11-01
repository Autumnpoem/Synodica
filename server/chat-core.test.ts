import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Account } from './account.js'
import { Approvals } from './approvals.js'
import { CorrectionLog, Corrector } from './correction.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import { tmp } from './testkit.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import type { Agent, Team } from '../shared/types.js'

function setup(runner: (p: RunTurnParams) => Promise<TurnResult>, ids = ['gpt', 'dsh']) {
  const dir = tmp()
  const agents: Agent[] = ids.map((id) => ({ id, name: id.toUpperCase(), role: 'specialist', color: '#fff', model: 'fake', effort: 'low', personality: 'test', tools: [], permissionMode: 'dontAsk', shape: 'blob', mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, provider: 'claude', muted: false, approvals: 'auto' }))
  const team: Team = { company: 'Test', owner: { id: 'user', name: 'Boss', title: 'Owner' }, workspace: dir, agents, mcpServers: {}, providers: { claude: { kind: 'claude', label: 'fake' } }, skills: {}, settings: { maxMessagesPerRound: 6, maxTurnsPerAgentPerRound: 2, maxTurnsPerReply: 3, groupMode: 'smart', language: 'en', notifications: false, autoReview: [], router: { mode: 'deterministic' }, memory: { mode: 'off' } } }
  const store = new Store(dir)
  store.seed(team)
  const approvals = new Approvals()
  const orchestrator = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), approvals, new Memory(dir), () => false, { runner })
  return { dir, team, store, approvals, orchestrator }
}

test('explicit two-person debate follows up without generated mentions and stays bounded', async () => {
  const calls: { id: string; note: string | undefined; visible: string[] }[] = []
  const h = setup(async (p) => {
    calls.push({ id: p.agent.id, note: p.note, visible: p.conversation.messages.filter((m) => m.status === 'done').map((m) => m.text) })
    return { text: `${p.agent.id} position ${calls.filter((c) => c.id === p.agent.id).length}` }
  })
  h.orchestrator.post('group', '@everyone 你俩辩论一下')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.map((c) => c.id), ['gpt', 'dsh', 'gpt', 'dsh'])
  assert.match(calls[2]?.note ?? '', /argument|观点|论点/i)
  assert.ok(calls[2]?.visible.includes('dsh position 1'))
})

test('continue discussing in a two-person group invites both without a router or mentions', async () => {
  const calls: string[] = []
  const h = setup(async (p) => { calls.push(p.agent.id); return { text: `${p.agent.id} view` } })
  h.orchestrator.post('group', '继续讨论这个问题')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['gpt', 'dsh', 'gpt', 'dsh'])
})

test('a plain whole-team introduction does not schedule rebuttals', async () => {
  const calls: string[] = []
  const h = setup(async (p) => { calls.push(p.agent.id); return { text: `${p.agent.id} hello` } })
  h.orchestrator.post('group', '@everyone introduce yourselves')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['gpt', 'dsh'])
})

test('negative debate instruction gives one direct answer without rebuttals', async () => {
  for (const text of ['停止讨论，不要辩论，直接给我结论。', 'Do not debate; just give me the answer.']) {
    const calls: string[] = []
    const h = setup(async (p) => { calls.push(p.agent.id); return { text: 'answer' } })
    h.orchestrator.post('group', text)
    await h.orchestrator.waitForIdle('group')
    assert.deepEqual(calls, ['gpt'], text)
  }
})

test('unaddressed three-person discussion invites all members within the existing budget', async () => {
  const calls: string[] = []
  const h = setup(async (p) => { calls.push(p.agent.id); return { text: `${p.agent.id} position` } }, ['gpt', 'dsh', 'third'])
  h.team.settings.router = { mode: 'model', provider: 'missing-fixture', model: 'never-called' }
  h.orchestrator.post('group', '请你们讨论这个方案')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['gpt', 'dsh', 'third', 'gpt', 'dsh', 'third'])
})

test('reply to a named employee routes only to that employee', async () => {
  const calls: string[] = []
  const h = setup(async (p) => { calls.push(p.agent.id); return { text: 'answer' } })
  const prior = h.orchestrator.record('group', 'my point', { authorId: 'dsh' })
  h.orchestrator.post('group', '你的回复呢？', { replyTo: { messageId: prior.id, authorId: 'dsh', excerpt: 'my point' } })
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['dsh'])
})

test('explicit single mention wins over a different reply target', async () => {
  const calls: string[] = []
  const h = setup(async (p) => { calls.push(p.agent.id); return { text: 'answer' } })
  const prior = h.orchestrator.record('group', 'my point', { authorId: 'dsh' })
  h.orchestrator.post('group', '@GPT answer this', { replyTo: { messageId: prior.id, authorId: 'dsh', excerpt: 'my point' } })
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['gpt'])
})

test('targeting an inactive employee does not abort the other active employee', async () => {
  const calls: { id: string; corrected: boolean; signal: AbortSignal }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const first = new Promise<void>((resolve) => { started = resolve })
  const h = setup(async (p) => {
    const corrected = p.conversation.messages.some((m) => m.correctionId)
    calls.push({ id: p.agent.id, corrected, signal: p.signal })
    if (!corrected) { started(); await held }
    return { text: corrected ? 'new dsh' : 'old gpt' }
  })
  const corrector = new Corrector({ log: new CorrectionLog(h.dir), orchestrator: h.orchestrator, workflow: {} as never, projects: { byConversation: () => undefined }, approvals: h.approvals, emit: () => {}, setTimer: () => 0, clearTimer: () => {} })
  h.orchestrator.post('group', '@GPT work on this')
  await first
  let ackId = ''
  try {
    const ack = corrector.correct('group', '@DSH give your answer', { targetAgentId: 'dsh' })
    ackId = ack.id
    assert.equal(ack.wasRunning, false)
    assert.equal(calls[0]?.signal.aborted, false)
  } finally { release() }
  await corrector.done(ackId)
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.map((c) => [c.id, c.corrected]), [['gpt', false], ['dsh', true]])
  assert.ok(h.store.get('group')!.messages.some((m) => m.authorId === 'gpt' && m.status === 'done'))
})

test('corrections for different employees do not supersede one another', async () => {
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const both = new Promise<void>((resolve) => { started = resolve })
  const calls: string[] = []
  const h = setup(async (p) => {
    calls.push(p.agent.id)
    if (calls.length === 2) started()
    if (calls.length <= 2) await held
    return { text: p.agent.id }
  })
  const corrector = new Corrector({ log: new CorrectionLog(h.dir), orchestrator: h.orchestrator, workflow: {} as never, projects: { byConversation: () => undefined }, approvals: h.approvals, emit: () => {}, setTimer: () => 0, clearTimer: () => {} })
  h.orchestrator.post('group', '@everyone share views')
  await both
  let firstId = ''; let secondId = ''
  try {
    firstId = corrector.correct('group', '@GPT revise', { targetAgentId: 'gpt' }).id
    secondId = corrector.correct('group', '@DSH revise', { targetAgentId: 'dsh' }).id
  } finally { release() }
  assert.equal((await corrector.done(firstId))?.status, 'applied')
  assert.equal((await corrector.done(secondId))?.status, 'applied')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, ['gpt', 'dsh', 'gpt', 'dsh'])
})

test('targeted approval invalidation leaves another employee approval pending', async () => {
  const approvals = new Approvals()
  const gpt = approvals.ask('group', 'gpt', 'Read', { file_path: 'a' }, new AbortController().signal)
  const dsh = approvals.ask('group', 'dsh', 'Read', { file_path: 'b' }, new AbortController().signal)
  const dshRequest = approvals.list().find((request) => request.agentId === 'dsh')
  assert.ok(dshRequest)
  const hit = approvals.invalidate('group', 'target corrected', 'gpt')
  assert.deepEqual(hit.map((request) => request.agentId), ['gpt'])
  assert.equal(await gpt, false)
  assert.deepEqual(approvals.list().map((request) => request.agentId), ['dsh'])
  approvals.resolve(dshRequest.id, true)
  assert.equal(await dsh, true)
})

test('HTTP rejects unknown correction targets and forged reply quotes before any provider call', { timeout: 15_000 }, async () => {
  const h = setup(async () => { throw new Error('a model call was not expected') }, ['gpt', 'dsh', 'outside'])
  h.team.providers = { fixture: { kind: 'openai', label: 'Local fixture only', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture' } }
  for (const agent of h.team.agents) agent.provider = 'fixture'
  const dataDir = tmp()
  const teamFile = path.join(dataDir, 'team.json')
  writeFileSync(teamFile, JSON.stringify(h.team))
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const address = probe.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  const base = `http://127.0.0.1:${address.port}`
  const fromSource = import.meta.url.endsWith('.ts')
  const entry = fileURLToPath(new URL(fromSource ? './index.ts' : './index.js', import.meta.url))
  const child = spawn(process.execPath, fromSource ? ['--import', 'tsx', entry] : [entry], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(address.port), OPENGROKBOT_TOKEN: 'fixture-token', OPENGROKBOT_TEAM: teamFile, OPENGROKBOT_DATA: dataDir }, stdio: 'ignore' })
  try {
    let ready = false
    for (let i = 0; i < 80; i++) {
      if (await fetch(`${base}/readyz`).then((r) => r.ok).catch(() => false)) { ready = true; break }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.equal(ready, true)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'fixture-token' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    const headers = { origin: base, cookie, 'content-type': 'application/json' }
    const badTarget = await fetch(`${base}/api/conversations/group/correct`, { method: 'POST', headers, body: JSON.stringify({ text: 'fix this', targetAgentId: 'foreign' }) })
    assert.equal(badTarget.status, 400)
    const badQuote = await fetch(`${base}/api/conversations/group/messages`, { method: 'POST', headers, body: JSON.stringify({ text: 'answer', replyTo: { messageId: 'foreign', authorId: 'dsh', excerpt: 'forged' } }) })
    assert.equal(badQuote.status, 400)
    const created = await fetch(`${base}/api/conversations`, { method: 'POST', headers, body: JSON.stringify({ name: 'Limited', memberIds: ['gpt', 'dsh'] }) })
    assert.equal(created.status, 200)
    const limited = (await created.json() as { conversation: { id: string } }).conversation
    const mixedMentions = await fetch(`${base}/api/conversations/${limited.id}/correct`, { method: 'POST', headers, body: JSON.stringify({ text: '@GPT @OUTSIDE revise both views' }) })
    assert.equal(mixedMentions.status, 200)
    const correction = (await mixedMentions.json() as { correction: { targetAgentId?: string } }).correction
    assert.equal(correction.targetAgentId, undefined, 'mixed in-room and out-of-room mentions remain a global correction')
  } finally {
    if (child.exitCode === null) {
      const gone = once(child, 'exit')
      child.kill('SIGTERM')
      await gone
    }
  }
})

test('correcting one parallel employee leaves the other running and answers only as target', async () => {
  const calls: { id: string; corrected: boolean; signal: AbortSignal }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let started!: () => void
  const both = new Promise<void>((resolve) => { started = resolve })
  const h = setup(async (p) => {
    const corrected = p.conversation.messages.some((m) => m.correctionId)
    calls.push({ id: p.agent.id, corrected, signal: p.signal })
    if (!corrected) {
      p.handlers.onDelta('working')
      if (calls.length === 2) started()
      await held
      return { text: p.agent.id === 'dsh' ? '@GPT old followup' : 'old gpt' }
    }
    return { text: 'new gpt' }
  })
  const corrector = new Corrector({ log: new CorrectionLog(h.dir), orchestrator: h.orchestrator, workflow: {} as never, projects: { byConversation: () => undefined }, approvals: h.approvals, emit: () => {}, setTimer: () => 0, clearTimer: () => {} })
  h.orchestrator.post('group', '@everyone debate')
  await both
  let ackId = ''
  try {
    const ack = corrector.correct('group', '@GPT change your argument', { targetAgentId: 'gpt' })
    ackId = ack.id
    assert.equal(ack.targetAgentId, 'gpt')
    assert.equal(calls[0]?.signal.aborted, true)
    assert.equal(calls[1]?.signal.aborted, false)
  } finally {
    release()
  }
  await corrector.done(ackId)
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.map((c) => [c.id, c.corrected]), [['gpt', false], ['dsh', false], ['gpt', true]])
  assert.ok(h.store.get('group')!.messages.some((m) => m.authorId === 'dsh' && m.status === 'done'))
})
