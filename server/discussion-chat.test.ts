import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Account } from './account.js'
import { Approvals } from './approvals.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { deterministicRoute } from './router.js'
import { Store } from './store.js'
import { tmp } from './testkit.js'
import type { RunTurnParams, TurnResult } from './providers/types.js'
import type { Agent, Team } from '../shared/types.js'

function member(id: string): Agent {
  return { id, name: id.toUpperCase(), role: 'specialist', color: '#fff', model: 'fake', effort: 'low', personality: '', tools: [], permissionMode: 'dontAsk', shape: 'blob', mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false, provider: 'claude', muted: false, approvals: 'auto' }
}

function setup(count = 5, maxMessagesPerRound = 3, runner?: (p: RunTurnParams) => Promise<TurnResult>) {
  const dir = tmp()
  const team: Team = {
    company: 'Test', owner: { id: 'user', name: 'Boss', title: 'Owner' }, workspace: dir,
    agents: Array.from({ length: count }, (_, i) => member(`person${i + 1}`)),
    mcpServers: {}, providers: { claude: { kind: 'claude', label: 'fake' } }, skills: {},
    settings: { maxMessagesPerRound, maxTurnsPerAgentPerRound: 2, maxTurnsPerReply: 3, groupMode: 'smart', language: 'en', notifications: false, autoReview: [], router: { mode: 'deterministic' }, memory: { mode: 'off' } },
  }
  const store = new Store(dir)
  store.seed(team)
  const calls: string[] = []
  const fake = runner ?? (async (p: RunTurnParams) => { calls.push(p.agent.id); return { text: `reply from ${p.agent.name}` } })
  const orchestrator = new Orchestrator(() => team, store, new Account(`${dir}/account.json`), new Approvals(), new Memory(dir), () => false, { runner: fake })
  return { team, store, calls, orchestrator }
}

test('explicit single @ remains exclusive when the addressed member mentions another', async () => {
  const h = setup(3, 5, async (p) => { h.calls.push(p.agent.id); return { text: p.agent.id === 'person1' ? '@PERSON2 please weigh in' : 'other reply' } })
  h.orchestrator.post('group', '@PERSON1, what does everyone think?')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(h.calls, ['person1'])
})

test('DM remains exclusive when its member mentions someone outside the DM', async () => {
  const h = setup(3, 5, async (p) => { h.calls.push(p.agent.id); return { text: '@PERSON2 please weigh in' } })
  h.orchestrator.post('dm-person1', 'Thoughts?')
  await h.orchestrator.waitForIdle('dm-person1')
  assert.deepEqual(h.calls, ['person1'])
})

test('natural English and Chinese whole-team invitations route to all; incidental everyone does not', () => {
  const h = setup()
  const group = h.store.get('group')!
  for (const text of ['Everyone, please weigh in on this plan', 'What does everybody think about the plan?', '\u8bf7\u5927\u5bb6\u53d1\u8868\u610f\u89c1', '\u8ba9\u6240\u6709\u4eba\u8ba8\u8bba\u4e00\u4e0b']) {
    const route = deterministicRoute(h.team, group, text)
    assert.equal(route.everyone, true, text)
    assert.deepEqual(route.speakers.map((a) => a.id), h.team.agents.map((a) => a.id))
  }
  assert.equal(deterministicRoute(h.team, group, 'Everyone will use this plan').everyone, undefined)
})

test('five members all get an opening turn when explicitly invited despite ordinary budget three', async () => {
  const h = setup()
  h.orchestrator.post('group', 'Everyone, please weigh in on this plan')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(h.calls, h.team.agents.map((a) => a.id))
})

test('natural whole-team invitation overrides mentions-only mode', async () => {
  const h = setup()
  h.team.settings.groupMode = 'mentions-only'
  h.orchestrator.post('group', '\u8bf7\u5927\u5bb6\u53d1\u8868\u610f\u89c1')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(h.calls, h.team.agents.map((a) => a.id))
})

test('@everyone has bounded opening turns and names omitted members', async () => {
  const h = setup(14)
  h.orchestrator.post('group', '@everyone, please share a concern')
  await h.orchestrator.waitForIdle('group')
  assert.equal(h.calls.length, 12)
  const notes = h.store.get('group')!.messages.filter((m) => m.authorId === 'workflow')
  assert.ok(notes.some((m) => m.text.includes('PERSON13') && m.text.includes('PERSON14')))
})

test('ordinary round stays within configured budget and notes queued mentions', async () => {
  const h = setup(5, 1, async (p) => { h.calls.push(p.agent.id); return { text: '@PERSON2 please follow up' } })
  h.orchestrator.post('group', 'Hello')
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(h.calls, ['person1'])
  assert.ok(h.store.get('group')!.messages.some((m) => m.authorId === 'workflow' && m.text.includes('PERSON2')))
})

test('stopping a whole-team round dispatches no later member', async () => {
  let release!: () => void
  let started!: () => void
  const firstStarted = new Promise<void>((resolve) => { started = resolve })
  const h = setup(5, 3, async (p) => {
    h.calls.push(p.agent.id)
    if (h.calls.length === 1) {
      started()
      await new Promise<void>((resolve) => { release = resolve })
    }
    return { text: `reply from ${p.agent.id}` }
  })
  h.orchestrator.post('group', '@everyone weigh in')
  await firstStarted
  h.orchestrator.stop('group')
  release()
  await h.orchestrator.waitForIdle('group')
  assert.deepEqual(h.calls, ['person1'])
  assert.equal(h.store.get('group')!.messages.some((m) => m.authorId === 'workflow' && m.text.includes('Round limit')), false)
})
