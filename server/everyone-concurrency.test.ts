import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Account } from './account.js'
import { Approvals } from './approvals.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { Store } from './store.js'
import { tmp } from './testkit.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import type { Agent, Team } from '../shared/types.js'

function member(id: string, tools: string[] = []): Agent {
  return { id, name: id.toUpperCase(), role: 'specialist', color: '#fff', model: 'fake', effort: 'low', personality: 'test', tools, permissionMode: 'dontAsk', shape: 'blob', mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, provider: 'claude', muted: false, approvals: 'auto' }
}

function setup(agents: Agent[], runner: (p: RunTurnParams) => Promise<TurnResult>) {
  const dir = tmp()
  const team: Team = { company: 'Test', owner: { id: 'user', name: 'Boss', title: 'Owner' }, workspace: dir, agents, mcpServers: {}, providers: { claude: { kind: 'claude', label: 'fake' } }, skills: {}, settings: { maxMessagesPerRound: 3, maxTurnsPerAgentPerRound: 1, maxTurnsPerReply: 3, groupMode: 'smart', language: 'en', notifications: false, autoReview: [], router: { mode: 'deterministic' }, memory: { mode: 'off' } } }
  const store = new Store(dir)
  store.seed(team)
  const orchestrator = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), new Approvals(), new Memory(dir), () => false, { runner })
  return { orchestrator, store, team }
}

test('@everyone starts two chat-only agents before either completes', async () => {
  const calls: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let first!: () => void
  const started = new Promise<void>((resolve) => { first = resolve })
  const h = setup([member('a'), member('b')], async (p) => {
    calls.push(p.agent.id)
    if (p.agent.id === 'a') { first(); await held }
    return { text: `reply from ${p.agent.id}` }
  })
  try {
    h.orchestrator.post('group', '@everyone share your view')
    await started
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['a', 'b'])
  } finally {
    release()
    await h.orchestrator.waitForIdle('group')
  }
})

test('configured all-members mode starts both chat-only agents together', async () => {
  const calls: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let first!: () => void
  const started = new Promise<void>((resolve) => { first = resolve })
  const h = setup([member('a'), member('b')], async (p) => {
    calls.push(p.agent.id)
    if (p.agent.id === 'a') { first(); await held }
    return { text: `reply from ${p.agent.id}` }
  })
  h.team.settings.groupMode = 'everyone'
  try {
    h.orchestrator.post('group', 'What do you think?')
    await started
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['a', 'b'])
  } finally {
    release()
    await h.orchestrator.waitForIdle('group')
  }
})

test('configured all-members mode caps opening turns at twelve', async () => {
  const calls: string[] = []
  const agents = Array.from({ length: 14 }, (_, i) => member(`person${i + 1}`))
  const h = setup(agents, async (p) => { calls.push(p.agent.id); return { text: `reply ${p.agent.id}` } })
  h.team.settings.groupMode = 'everyone'
  h.team.settings.maxMessagesPerRound = 30
  h.orchestrator.post('group', 'Please give an update')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, agents.slice(0, 12).map((a) => a.id))
  assert.ok(h.store.get('group')!.messages.some((m) => m.authorId === 'workflow' && m.text.includes('PERSON13') && m.text.includes('PERSON14')))
})

test('parallel, queued and corrected chat rounds carry their own input message id', async () => {
  const calls: { agent: string; inputMessageId: string | undefined }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let both!: () => void
  const started = new Promise<void>((resolve) => { both = resolve })
  const h = setup([member('a'), member('b')], async (p) => {
    calls.push({ agent: p.agent.id, inputMessageId: (p as RunTurnParams & { inputMessageId?: string }).inputMessageId })
    if (calls.length === 2) both()
    if (calls.length <= 2) await held
    return { text: `reply ${p.agent.id}` }
  })
  const oldImage = h.orchestrator.record('group', '@A old image', { attachments: [{ name: 'old.png', path: '/tmp/old.png', mime: 'image/png', size: 1 }] })
  const opening = h.orchestrator.post('group', '@everyone new request')
  await started
  const queued = h.orchestrator.post('group', '@A second request')
  release()
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, [
    { agent: 'a', inputMessageId: opening.id },
    { agent: 'b', inputMessageId: opening.id },
    { agent: 'a', inputMessageId: queued.id },
  ])
  assert.notEqual(opening.id, oldImage.id)

  const corrected = h.orchestrator.record('group', '@B corrected request', { correctionId: 'c1' })
  h.orchestrator.replyTo('group', corrected)
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.at(-1), { agent: 'b', inputMessageId: corrected.id })

  h.orchestrator.post('group', 'routine instruction', { authorId: 'routine', forced: [h.team.agents[0]!] })
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.at(-1), { agent: 'a', inputMessageId: undefined })
})

test('parallel invitees see the same opening transcript and stop aborts both in-flight turns', async () => {
  const calls: { id: string; signal: AbortSignal; texts: string[] }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let both!: () => void
  const started = new Promise<void>((resolve) => { both = resolve })
  const h = setup([member('a'), member('b')], async (p) => {
    calls.push({ id: p.agent.id, signal: p.signal, texts: p.conversation.messages.map((m) => m.text) })
    p.handlers.onDelta('working')
    if (calls.length === 2) both()
    await held // deliberately ignore abort, like a late provider reply
    return { text: '@A old answer' }
  })
  h.orchestrator.post('group', '@everyone discuss')
  await started
  h.orchestrator.stop('group')
  assert.ok(calls.every((c) => c.signal.aborted))
  assert.deepEqual(calls.map((c) => c.texts), [['@everyone discuss'], ['@everyone discuss']])
  release()
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls.map((c) => c.id), ['a', 'b'])
  assert.deepEqual(h.store.get('group')!.messages.filter((m) => m.authorId !== 'user').map((m) => m.status), ['superseded', 'superseded'])
})

test('a correction waits for all old parallel turns to settle before starting its new round', async () => {
  const calls: { id: string; corrected: boolean }[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let both!: () => void
  const started = new Promise<void>((resolve) => { both = resolve })
  const h = setup([member('a'), member('b')], async (p) => {
    const corrected = p.conversation.messages.some((m) => m.correctionId === 'correction-1')
    calls.push({ id: p.agent.id, corrected })
    if (!corrected) {
      p.handlers.onDelta('old work')
      if (calls.length === 2) both()
      await held
    }
    return { text: corrected ? 'new answer' : 'old answer' }
  })
  h.orchestrator.post('group', '@everyone old instruction')
  await started
  h.orchestrator.interrupt('group')
  const correction = h.orchestrator.record('group', 'new instruction', { correctionId: 'correction-1' })
  h.orchestrator.replyTo('group', correction)
  assert.deepEqual(calls, [{ id: 'a', corrected: false }, { id: 'b', corrected: false }])
  release()
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(calls, [{ id: 'a', corrected: false }, { id: 'b', corrected: false }, { id: 'a', corrected: true }])
  assert.deepEqual(h.store.get('group')!.messages.filter((m) => m.text === 'old answer').map((m) => m.status), ['superseded', 'superseded'])
})

test('chat readers start together while overlapping workspace writers take turns', async () => {
  const calls: string[] = []
  let release!: () => void
  const firstWriterHeld = new Promise<void>((resolve) => { release = resolve })
  let first!: () => void
  const firstWriterStarted = new Promise<void>((resolve) => { first = resolve })
  const h = setup([member('a', ['Write']), member('b', ['Write']), member('c')], async (p) => {
    calls.push(p.agent.id)
    if (p.agent.id === 'a') { first(); await firstWriterHeld }
    return { text: `reply ${p.agent.id}` }
  })
  try {
    h.orchestrator.post('group', '@everyone discuss')
    await firstWriterStarted
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.deepEqual(calls, ['c', 'a'])
  } finally {
    release()
    await h.orchestrator.waitForIdle('group')
  }
  assert.deepEqual(calls, ['c', 'a', 'b'])
  assert.equal(h.store.get('group')!.messages.some((m) => m.status === 'error'), false)
})
