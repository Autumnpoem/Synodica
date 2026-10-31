import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { versionOf } from '../shared/sync.js'
import type { AppState, Project } from '../shared/types.js'
import { member, mixedTeam, tmp } from './testkit.js'

async function freePort(): Promise<number> {
  const s = createServer()
  s.listen(0, '127.0.0.1')
  await once(s, 'listening')
  const address = s.address()
  assert(address && typeof address !== 'string')
  await new Promise<void>((resolve) => s.close(() => resolve()))
  return address.port
}

async function waitFor(fn: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 80; i++) {
    if (await fn().catch(() => false)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('timed out waiting for office')
}

async function syncFrame(base: string, cookie: string): Promise<{ state: AppState; close: () => void }> {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: controller.signal })
  assert.equal(res.status, 200)
  const reader = res.body?.getReader()
  assert(reader)
  let text = ''
  const decoder = new TextDecoder()
  for (;;) {
    const chunk = await reader.read()
    assert.equal(chunk.done, false)
    text += decoder.decode(chunk.value)
    const end = text.indexOf('\n\n')
    if (end < 0) continue
    const lines = text.slice(0, end).split('\n')
    assert(lines.includes('event: sync'))
    const data = lines.find((line) => line.startsWith('data: '))
    assert(data)
    return { state: (JSON.parse(data.slice(6)) as { state: AppState }).state, close: () => controller.abort() }
  }
}

test('two browsers share a fake-provider office, deduplicate writes, reject stale actions, and resync after restart', { timeout: 30_000 }, async () => {
  let calls = 0
  const fake: Server = createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        calls++
        const prompt = Buffer.concat(chunks).toString()
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        if (prompt.includes('Please request approval') && !prompt.includes('"role":"tool"')) {
          const tool = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] }, finish_reason: 'tool_calls' }] }
          res.end(`data: ${JSON.stringify(tool)}\n\ndata: [DONE]\n\n`)
        } else res.end('data: {"choices":[{"delta":{"content":"fixture reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      })
    } else { res.writeHead(404); res.end() }
  })
  fake.listen(0, '127.0.0.1')
  await once(fake, 'listening')
  const fakeAddress = fake.address()
  assert(fakeAddress && typeof fakeAddress !== 'string')
  const dataDir = tmp('ogb-shared-data-')
  const teamFile = path.join(dataDir, 'team.json')
  const team = mixedTeam(tmp('ogb-shared-workspace-'))
  team.agents = [member('alpha', 'fake', [], { tools: ['Read'], approvals: 'ask-all' }), member('beta', 'fake', [], { tools: [] })]
  team.providers = { fake: { kind: 'openai', label: 'Fixture', baseUrl: `http://127.0.0.1:${fakeAddress.port}/v1`, apiKey: 'fixture' } }
  team.settings.maxMessagesPerRound = 1
  writeFileSync(teamFile, JSON.stringify(team))
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const entry = fileURLToPath(new URL('./index.js', import.meta.url))
  let child: ChildProcess | undefined
  const start = async () => {
    child = spawn(process.execPath, [entry], { env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), OPENGROKBOT_TOKEN: 'fixture-access-token', OPENGROKBOT_TEAM: teamFile, OPENGROKBOT_DATA: dataDir, OPENGROKBOT_TRUST_PROXY: '0' }, stdio: 'ignore' })
    await waitFor(async () => (await fetch(`${base}/readyz`)).status === 200)
  }
  const stop = async () => {
    if (!child || child.exitCode !== null) return
    const gone = once(child, 'exit')
    child.kill('SIGTERM')
    await gone
  }
  try {
    await start()
    assert.equal((await fetch(`${base}/api/state`)).status, 401)
    const page = await fetch(base)
    assert.equal(page.status, 401)
    const html = await page.text()
    assert.match(html, /<form method="post" action="\/api\/session"/)
    assert.match(html, /background:#f5f5f7/)
    assert.doesNotMatch(html, /\?token=/)
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'wrong-token' }) })
    assert.equal(wrong.status, 401)
    assert.equal(wrong.headers.get('set-cookie'), null)
    const crossOrigin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: JSON.stringify({ token: 'fixture-access-token' }) })
    assert.equal(crossOrigin.status, 403)
    assert.equal(crossOrigin.headers.get('set-cookie'), null)
    const form = await fetch(`${base}/api/session`, { method: 'POST', headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: 'fixture-access-token' }), redirect: 'manual' })
    assert.equal(form.status, 303)
    assert.equal(form.headers.get('location'), '/')
    assert(form.headers.get('set-cookie')?.includes('HttpOnly'))
    const urlToken = await fetch(`${base}/?token=fixture-access-token`, { redirect: 'manual' })
    assert.equal(urlToken.status, 401)
    assert.equal(urlToken.headers.get('set-cookie'), null)
    const login = async () => {
      const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ token: 'fixture-access-token' }) })
      assert.equal(res.status, 200)
      const cookie = res.headers.get('set-cookie')
      assert(cookie && cookie.includes('HttpOnly'))
      return cookie.split(';')[0]!
    }
    const [a, b] = await Promise.all([login(), login()])
    assert.notEqual(a, b)
    const crossPort = await fetch(`${base}/api/conversations/group/stop`, { method: 'POST', headers: { cookie: a, origin: `http://127.0.0.1:${port + 1}`, 'sec-fetch-site': 'same-site' } })
    assert.equal(crossPort.status, 403)
    const [aSync, bSync] = await Promise.all([syncFrame(base, a), syncFrame(base, b)])
    assert.equal(aSync.state.conversations.length, bSync.state.conversations.length)
    const key = 'fixture-message-0001'
    const send = (cookie: string) => fetch(`${base}/api/conversations/group/messages`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ text: 'Hello from two browsers' }) })
    const [ra, rb] = await Promise.all([send(a), send(b)])
    assert.equal(ra.status, 200)
    assert.equal(rb.status, 200)
    assert.equal((await ra.json() as { message: { id: string } }).message.id, (await rb.json() as { message: { id: string } }).message.id)
    const mismatched = await fetch(`${base}/api/conversations/group/messages`, { method: 'POST', headers: { cookie: b, origin: base, 'content-type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({ text: 'Different text with reused id' }) })
    assert.equal(mismatched.status, 422)
    await waitFor(async () => {
      const s = await (await fetch(`${base}/api/state`, { headers: { cookie: a } })).json() as AppState
      return s.conversations.find((c) => c.id === 'group')?.messages.some((m) => m.text.includes('fixture reply')) ?? false
    })
    const liveA = await syncFrame(base, a)
    const liveB = await syncFrame(base, b)
    assert.equal(liveA.state.conversations.find((c) => c.id === 'group')?.messages.find((m) => m.text === 'Hello from two browsers')?.requestId, key, 'stream snapshots acknowledge the exact accepted send')
    const count = (s: AppState) => s.conversations.find((c) => c.id === 'group')?.messages.filter((m) => m.authorId === 'user' && m.text === 'Hello from two browsers').length
    assert.equal(count(liveA.state), 1)
    assert.equal(count(liveB.state), 1)
    assert.equal(calls, 1)
    const approvalMessage = await fetch(`${base}/api/conversations/dm-alpha/messages`, { method: 'POST', headers: { cookie: a, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Please request approval' }) })
    assert.equal(approvalMessage.status, 200)
    await waitFor(async () => (await (await fetch(`${base}/api/state`, { headers: { cookie: b } })).json() as AppState).approvals.length === 1)
    const pending = await (await fetch(`${base}/api/state`, { headers: { cookie: b } })).json() as AppState
    const approvalId = pending.approvals[0]?.id
    assert(approvalId)
    const decide = (cookie: string, allow: boolean) => fetch(`${base}/api/approvals/${approvalId}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ allow }) })
    assert.equal((await decide(a, false)).status, 200)
    const conflictingApproval = await decide(b, true)
    assert.equal(conflictingApproval.status, 409)
    assert.equal((await conflictingApproval.json() as { code: string }).code, 'conflict')
    const projectRes = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie: a, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Shared board', workspace: tmp('ogb-shared-project-'), memberIds: ['alpha', 'beta'], kickoff: false }) })
    assert.equal(projectRes.status, 200)
    const { project } = await projectRes.json() as { project: Project }
    const oldVersion = versionOf(project)
    const edit = (cookie: string, name: string) => fetch(`${base}/api/projects/${project.id}`, { method: 'PUT', headers: { cookie, origin: base, 'content-type': 'application/json', 'If-Match': oldVersion }, body: JSON.stringify({ name }) })
    const firstEdit = await edit(a, 'First browser edit')
    assert.equal(firstEdit.status, 200)
    const editedProject = (await firstEdit.json() as { project: Project }).project
    assert.equal((await edit(b, 'Stale second browser edit')).status, 409)
    const actionVersion = versionOf(editedProject)
    const action = (cookie: string, name: string) => fetch(`${base}/api/projects/${project.id}/${name}`, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json', 'If-Match': actionVersion }, body: '{}' })
    assert.equal((await action(a, 'pause')).status, 200)
    const stale = await action(b, 'resume')
    assert.equal(stale.status, 409)
    assert.equal((await stale.json() as { code: string }).code, 'conflict')
    assert.equal((await action(a, 'stop')).status, 200, 'stale Stop still interrupts the current work')
    assert.equal((await action(b, 'pause')).status, 200, 'stale Pause still stops new dispatches')
    const taskRes = await fetch(`${base}/api/projects/${project.id}/tasks`, { method: 'POST', headers: { cookie: a, origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Cancel fixture', kind: 'implement', ownerId: 'alpha', acceptance: ['can be cancelled'] }) })
    assert.equal(taskRes.status, 200)
    const task = (await taskRes.json() as { task: { id: string } }).task
    const cancel = await fetch(`${base}/api/projects/${project.id}/tasks/${task.id}/cancel`, { method: 'POST', headers: { cookie: b, origin: base, 'content-type': 'application/json', 'If-Match': 'stale-fixture' }, body: JSON.stringify({ reason: 'stop now' }) })
    assert.equal(cancel.status, 200, 'task cancellation does not depend on a stale UI revision')
    aSync.close(); bSync.close(); liveA.close(); liveB.close()
    await stop()
    await start()
    assert.equal((await fetch(`${base}/api/auth/status`, { headers: { cookie: b } }).then((r) => r.json()) as { authenticated: boolean }).authenticated, true)
    const after = await syncFrame(base, b)
    assert.equal(count(after.state), 1)
    assert.equal(after.state.projects.find((p) => p.id === project.id)?.paused, true)
    assert.deepEqual(after.state.typing ?? {}, {})
    after.close()
  } finally {
    await stop()
    await new Promise<void>((resolve) => fake.close(() => resolve()))
  }
})
