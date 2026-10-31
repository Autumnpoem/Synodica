// Presentation logic shared by the office view, the browser pet and the native overlay.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classifyToolLine, DEFAULT_PET_PREFS, linkToHash, parseAppLink, parseFollow, petFocus, presenceOf, providerLine, sanitizePetPrefs, type FocusInput } from '../shared/presence.js'
import type { AgentActivity, AgentActivityState } from '../shared/types.js'

const NOW = 1_000_000_000
const act = (agentId: string, state: AgentActivityState, extra: Partial<AgentActivity> = {}): AgentActivity => ({ agentId, state, since: NOW - 60_000, ...extra })

test('every reported state has a readable, distinct label; unknown and connection loss are never idle', () => {
  const states: AgentActivityState[] = ['idle', 'queued', 'thinking', 'tool', 'waiting-approval', 'waiting-dependency', 'waiting-user', 'error', 'interrupted', 'offline', 'replied', 'done']
  const labels = new Set<string>()
  for (const s of states) {
    const v = presenceOf(act('a', s, s === 'tool' ? { toolKind: 'command', lastEventAt: NOW } : { lastEventAt: NOW }), NOW)
    assert.ok(v.label.length > 3, `${s} has a label`)
    labels.add(v.label)
  }
  assert.equal(labels.size, states.length, 'labels are distinct')
  assert.equal(presenceOf(undefined, NOW).presence, 'unknown')
  const lost = presenceOf(act('a', 'thinking'), NOW, { connected: false })
  assert.equal(lost.presence, 'unknown')
  assert.match(lost.detail ?? '', /Last known: Thinking/)
  assert.equal(presenceOf(act('a', 'error', { detail: 'HTTP 500' }), NOW).presence, 'failed')
  assert.equal(presenceOf(act('a', 'idle', { detail: 'ignored' }), NOW).detail, undefined)
})

test('tool lines from every adapter are classified', () => {
  assert.equal(classifyToolLine('Write /w/a.ts'), 'file')
  assert.equal(classifyToolLine('Edit a.ts'), 'file')
  assert.equal(classifyToolLine('Edited 3 file(s)'), 'file', 'Codex file_change')
  assert.equal(classifyToolLine('Bash npm test'), 'command')
  assert.equal(classifyToolLine('Grep TODO'), 'read')
  assert.equal(classifyToolLine('Fetching https://example.com'), 'web')
  assert.equal(classifyToolLine('Searching the web: x'), 'web')
  assert.equal(classifyToolLine('github → create_issue'), 'other')
  assert.equal(classifyToolLine('Thinking…'), null)
  // A tool state reported without a kind still uses its line.
  assert.equal(presenceOf(act('a', 'tool', { detail: 'Bash ls', lastEventAt: NOW }), NOW).presence, 'command')
})

test('stall detection uses the last provider event, with a configurable threshold', () => {
  const a = act('a', 'tool', { toolKind: 'file', lastEventAt: NOW - 4 * 60_000 })
  assert.equal(presenceOf(a, NOW).presence, 'coding')
  assert.equal(presenceOf(a, NOW, { stallMs: 3 * 60_000 }).presence, 'stalled')
  assert.equal(presenceOf(act('a', 'thinking', { lastEventAt: NOW - 10 * 60_000 }), NOW).label, 'No recent activity for 10m')
})

test('provider status is unknown until probed', () => {
  assert.equal(providerLine(undefined, NOW).state, 'unknown')
  assert.equal(providerLine({ ok: false, detail: 'not logged in', at: NOW - 120_000 }, NOW).text, 'Unavailable: not logged in (checked 2m ago)')
  assert.equal(providerLine({ ok: true, detail: 'x', at: NOW }, NOW).state, 'ok')
})

test('deep links: only allow-listed views with plain ids; everything else is refused', () => {
  assert.deepEqual(parseAppLink('#/chat/c-123'), { view: 'chat', conversationId: 'c-123' })
  assert.deepEqual(parseAppLink('#/office'), { view: 'office' })
  assert.deepEqual(parseAppLink('#/office/p_1'), { view: 'office', projectId: 'p_1' })
  assert.deepEqual(parseAppLink({ view: 'approval', conversationId: 'group' }), { view: 'approval', conversationId: 'group' })
  for (const bad of [
    'https://evil.example/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    '#/chat',
    '#/chat/../../etc',
    '#/chat/a b',
    '#/chat/a?token=x',
    '#/settings/providers',
    '#/office/<script>',
    `#/chat/${'a'.repeat(200)}`,
    { view: 'chat', conversationId: 'x', url: 'https://evil' },
    { view: 'chat', conversationId: '../x' },
    { view: 'open', path: '/etc/passwd' },
    { view: 'office', projectId: 7 },
    ['#/office'],
    null,
    42,
  ]) {
    assert.equal(parseAppLink(bad), null, `refused: ${JSON.stringify(bad)}`)
  }
  assert.equal(linkToHash({ view: 'chat', conversationId: 'c1' }), '#/chat/c1')
  assert.deepEqual(parseAppLink(linkToHash({ view: 'office', projectId: 'p1' })), { view: 'office', projectId: 'p1' })
})

test('browser pet preferences are validated with safe defaults', () => {
  assert.deepEqual(sanitizePetPrefs(undefined), DEFAULT_PET_PREFS)
  assert.deepEqual(sanitizePetPrefs('{"visible":false}'), DEFAULT_PET_PREFS, 'a raw string is not trusted')
  const p = sanitizePetPrefs({ visible: false, scale: 9, follow: 'agent:qa', paused: true, x: -3, y: Number.NaN, extra: 'x' })
  assert.deepEqual(p, { visible: false, scale: 2, follow: 'agent:qa', paused: true, x: 0, y: DEFAULT_PET_PREFS.y })
  assert.equal(sanitizePetPrefs({ follow: 'agent:../x' }).follow, 'team')
  assert.equal(sanitizePetPrefs({ follow: 'project:p1' }).follow, 'project:p1')
  assert.equal(sanitizePetPrefs({ scale: 0.1 }).scale, 0.5)
  assert.deepEqual(parseFollow('nonsense'), { kind: 'team' })
})

function input(activity: AgentActivity[], extra: Partial<FocusInput> = {}): FocusInput {
  return {
    target: { kind: 'team' },
    agents: ['lead', 'builder', 'qa', 'writer'].map((id) => ({ id, name: id.toUpperCase(), role: 'r', color: '#888', shape: 'blob' })),
    activity,
    projects: [
      { id: 'pa', name: 'Alpha', conversationId: 'c-pa', tasks: [{ id: 'T-1', title: 'Build the API' }] },
      { id: 'pb', name: 'Beta', conversationId: 'c-pb', tasks: [{ id: 'T-1', title: 'Write docs' }] },
    ],
    approvals: [],
    now: NOW,
    connected: true,
    ...extra,
  }
}

test('pet focus: team view puts what needs you first, then the most recent worker; counts are honest', () => {
  const acts = [
    act('lead', 'idle'),
    act('builder', 'tool', { toolKind: 'file', detail: 'Write api.ts', projectId: 'pa', taskRef: 'T-1', conversationId: 'c-pa', lastEventAt: NOW - 1000 }),
    act('qa', 'thinking', { projectId: 'pb', taskRef: 'T-1', conversationId: 'c-pb', lastEventAt: NOW - 5000 }),
  ]
  let f = petFocus(input(acts))
  assert.equal(f.agent?.id, 'builder')
  assert.equal(f.view.presence, 'coding')
  assert.equal(f.task, 'T-1 · Build the API')
  assert.equal(f.projectName, 'Alpha')
  assert.deepEqual(f.link, { view: 'office' }, 'the team pet opens the office')
  assert.deepEqual(f.counts, { quiet: 1, working: 2, unknown: 1 }, 'writer never reported: unknown, not idle')

  // qa waits for your approval: it becomes the attention item and the click goes to the approval.
  f = petFocus(input([...acts.filter((a) => a.agentId !== 'qa'), act('qa', 'waiting-approval', { projectId: 'pb', conversationId: 'c-pb', lastEventAt: NOW })], { approvals: [{ conversationId: 'c-pb', agentId: 'qa', tool: 'Bash' }] }))
  assert.equal(f.agent?.id, 'qa')
  assert.deepEqual(f.attention?.link, { view: 'approval', conversationId: 'c-pb' })
  assert.deepEqual(f.link, { view: 'approval', conversationId: 'c-pb' })
})

test('pet focus: project and employee targets, unknown targets and disconnects', () => {
  const acts = [
    act('builder', 'tool', { toolKind: 'command', projectId: 'pa', taskRef: 'T-1', conversationId: 'c-pa', lastEventAt: NOW }),
    act('qa', 'error', { detail: 'HTTP 500', projectId: 'pb', conversationId: 'c-pb' }),
  ]
  let f = petFocus(input(acts, { target: { kind: 'project', id: 'pb' } }))
  assert.equal(f.agent?.id, 'qa')
  assert.equal(f.view.presence, 'failed')
  assert.match(f.attention?.text ?? '', /QA: Last turn failed · HTTP 500/)
  f = petFocus(input(acts, { target: { kind: 'agent', id: 'builder' } }))
  assert.equal(f.view.presence, 'command')
  assert.deepEqual(f.link, { view: 'chat', conversationId: 'c-pa' })
  assert.equal(petFocus(input(acts, { target: { kind: 'agent', id: 'ghost' } })).view.presence, 'unknown')
  assert.equal(petFocus(input(acts, { target: { kind: 'project', id: 'gone' } })).view.presence, 'unknown')
  f = petFocus(input(acts, { connected: false }))
  assert.equal(f.view.presence, 'unknown')
  assert.deepEqual(f.counts, { unknown: 4 })
})
