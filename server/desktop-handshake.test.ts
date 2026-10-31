import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { waitForReady } from './desktopdata.js'
import { member, mixedTeam, tmp } from './testkit.js'

async function portFrom(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert(address && typeof address !== 'string')
  return address.port
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const gone = once(child, 'exit')
  child.kill('SIGTERM')
  await gone
}

test('real desktop server reports ready, suspends only its pet, restores its preference, and reports a bind failure', { timeout: 30_000 }, async () => {
  const fakeProvider = createServer((_req, res) => { res.writeHead(404); res.end() })
  const fakePort = await portFrom(fakeProvider)
  const dataDir = tmp('ogb-ipc-data-')
  const teamFile = path.join(dataDir, 'team.json')
  const team = mixedTeam(tmp('ogb-ipc-workspace-'))
  team.agents = [member('alpha', 'fake', []), member('beta', 'fake', [])]
  team.providers = { fake: { kind: 'openai', label: 'Fixture', baseUrl: `http://127.0.0.1:${fakePort}/v1`, apiKey: 'fixture' } }
  writeFileSync(teamFile, JSON.stringify(team))
  const reservation = createServer()
  const port = await portFrom(reservation)
  await new Promise<void>((resolve) => reservation.close(() => resolve()))
  const entry = fileURLToPath(new URL('./index.js', import.meta.url))
  const launch = (nonce: string) => fork(entry, [], {
    execArgv: [],
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), OPENGROKBOT_TEAM: teamFile, OPENGROKBOT_DATA: dataDir, OPENGROKBOT_INSTANCE_NONCE: nonce, OPENGROKBOT_PET_ELECTRON: path.join(dataDir, 'no-native-electron') },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  let first: ChildProcess | undefined
  let blocked: ChildProcess | undefined
  const blocker = createServer()
  try {
    first = launch('ready-fixture-nonce')
    const ready = await waitForReady(first, 'ready-fixture-nonce', 1500)
    assert.deepEqual(ready, { ok: true, port })
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200)
    const petControl = async (action: string, body = {}) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/pet/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}` }, body: JSON.stringify(body),
      })
      assert.equal(res.status, 200)
      return await res.json() as { status: { state: string; pid?: number }; settings: { enabled: boolean } }
    }
    const running = await petControl('start')
    assert.equal(running.status.state, 'running')
    assert.ok(running.status.pid)
    const suspended = await petControl('desktop', { active: false })
    assert.equal(suspended.status.state, 'stopped')
    assert.equal(suspended.settings.enabled, true)
    assert.throws(() => process.kill(running.status.pid as number, 0), /ESRCH/)
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz`)).status, 200, 'local server stays alive')
    assert.equal((await petControl('start')).status.state, 'stopped', 'suspension also applies to another local browser')
    const resumed = await petControl('desktop', { active: true })
    assert.equal(resumed.status.state, 'running')
    assert.notEqual(resumed.status.pid, running.status.pid)
    await petControl('stop')
    const disabled = await petControl('desktop', { active: true })
    assert.equal(disabled.status.state, 'stopped')
    assert.equal(disabled.settings.enabled, false, 'returning to local must not override an explicit stop')
    await stop(first)

    blocker.listen(port, '127.0.0.1')
    await once(blocker, 'listening')
    blocked = launch('failure-fixture-nonce')
    const failed = await waitForReady(blocked, 'failure-fixture-nonce', 1500)
    assert.equal(failed.ok, false)
    if (!failed.ok) assert.match(failed.reason, /EADDRINUSE|address already in use/i)
  } finally {
    if (first) await stop(first)
    if (blocked) await stop(blocked)
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    await new Promise<void>((resolve) => fakeProvider.close(() => resolve()))
  }
})
