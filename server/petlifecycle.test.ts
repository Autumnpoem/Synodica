import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PetRuntime, PET_PACKAGE, petHomeDir } from './petruntime.js'
import { tmp } from './testkit.js'

/**
 * A stand-in for the upstream standalone host with the same contract PetRuntime relies on: it listens
 * on --port, announces { pid, port, token } in DSH_HOME/dsh-pet/standalone-runtime.json after a
 * configurable delay, exits on POST /shutdown, and appends its pid to DSH_HOME/spawned.log so the
 * test can count every host ever spawned.
 */
const FAKE_STANDALONE = `
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
const home = process.env.DSH_HOME
fs.appendFileSync(path.join(home, 'spawned.log'), process.pid + '\\n')
const delay = Number(fs.readFileSync(path.join(__dirname, 'delay.txt'), 'utf8'))
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end('{"ok":true}')
  if (req.method === 'POST' && req.url === '/shutdown') setTimeout(() => process.exit(0), 10)
})
srv.listen(port, '127.0.0.1', () => {
  setTimeout(() => {
    fs.mkdirSync(path.join(home, 'dsh-pet'), { recursive: true })
    fs.writeFileSync(path.join(home, 'dsh-pet', 'standalone-runtime.json'), JSON.stringify({ pid: process.pid, port, token: 'a'.repeat(43) }))
  }, delay)
})
`

function fakePackage(delayMs: number): string {
  const dir = tmp('ogb-fakepet-')
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: PET_PACKAGE.name, version: PET_PACKAGE.version, license: PET_PACKAGE.license }))
  for (const rel of ['lib/client.js', 'lib/index.js', 'assets/config.jsonc', 'runtime/electron-helper/main.js', 'LICENSE', 'assets/webm/idle.webm']) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    writeFileSync(path.join(dir, rel), '')
  }
  writeFileSync(path.join(dir, 'lib', 'standalone.js'), FAKE_STANDALONE)
  writeFileSync(path.join(dir, 'lib', 'delay.txt'), String(delayMs))
  return dir
}

function runtime(delayMs: number, startTimeoutMs = 10000): { rt: PetRuntime; spawned: () => number[] } {
  const dataDir = tmp('ogb-petdata-')
  const rt = new PetRuntime({ appRoot: dataDir, dataDir, packageDir: fakePackage(delayMs), env: { PATH: process.env.PATH ?? '' }, startTimeoutMs, log: () => {} })
  const log = path.join(petHomeDir(dataDir), 'spawned.log')
  const spawned = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(Number) : [])
  return { rt, spawned }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test('pet lifecycle: concurrent starts share one host; stop leaves no orphan', async () => {
  const { rt, spawned } = runtime(150)
  const all = await Promise.all([rt.start(), rt.start(), rt.start()])
  assert.ok(all.every((s) => s.state === 'running'))
  assert.equal(new Set(all.map((s) => s.pid)).size, 1)
  assert.equal(spawned().length, 1)
  // A start while running is a no-op, not a second host.
  assert.equal((await rt.start()).pid, all[0]?.pid)
  assert.equal(spawned().length, 1)
  const stopped = await Promise.all([rt.stop(), rt.stop()])
  assert.ok(stopped.every((s) => s.state === 'stopped'))
  assert.equal(spawned().filter(alive).length, 0)
})

test('pet lifecycle: a stop during start cancels it and kills any host it spawned', async () => {
  const { rt, spawned } = runtime(400)
  const starting = rt.start()
  // Let the start spawn its child, then stop while it is still waiting for the announcement.
  await new Promise((r) => setTimeout(r, 150))
  const stopping = rt.stop()
  const [a, b] = await Promise.all([starting, stopping])
  assert.notEqual(a.state, 'running')
  assert.equal(b.state, 'stopped')
  assert.equal(rt.instance(), undefined)
  assert.ok(spawned().length <= 1)
  assert.equal(spawned().filter(alive).length, 0)
  // An immediate stop (before the port is even chosen) spawns nothing.
  const before = spawned().length
  const [c] = await Promise.all([rt.start(), rt.stop()])
  assert.notEqual(c.state, 'running')
  assert.equal(spawned().length, before)
  // The runtime is usable afterwards and still runs exactly one host.
  const s = await rt.start()
  assert.equal(s.state, 'running')
  assert.equal(spawned().filter(alive).length, 1)
  await rt.stop()
  assert.equal(spawned().filter(alive).length, 0)
})

test('pet lifecycle: start, stop, start interleaved ends with exactly one live host and a new instance', async () => {
  const { rt, spawned } = runtime(100)
  const first = await rt.start()
  const id1 = rt.instance()
  const [, , again] = await Promise.all([rt.stop(), rt.start(), rt.start()])
  assert.equal(again.state, 'running')
  assert.notEqual(again.pid, first.pid)
  assert.notEqual(rt.instance(), id1)
  assert.equal(spawned().filter(alive).length, 1)
  await rt.shutdown()
  assert.equal(spawned().filter(alive).length, 0)
  // After shutdown no start spawns anything.
  const n = spawned().length
  assert.notEqual((await rt.start()).state, 'running')
  assert.equal(spawned().length, n)
})

test('pet lifecycle: a host that never announces itself fails and is cleaned up', async () => {
  const { rt, spawned } = runtime(60000, 400)
  const s = await rt.start()
  assert.equal(s.state, 'failed')
  assert.match(s.reason ?? '', /did not start in time/)
  assert.equal(spawned().length, 1)
  assert.equal(spawned().filter(alive).length, 0)
  assert.equal((await rt.stop()).state, 'failed')
})
