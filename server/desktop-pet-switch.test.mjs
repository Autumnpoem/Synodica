import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const read = (name) => readFileSync(new URL('../' + name, import.meta.url), 'utf8')

// Exercise the real API handlers and Electron IPC handlers together, without opening native windows.
function fixture(enabled = true) {
  const routes = new Map(), handlers = new Map()
  let localVisible = enabled, remoteVisible = false, localWork = true, failWindow = false
  const settings = { enabled }
  const runtime = { status: () => ({ state: localVisible ? 'running' : 'stopped' }),
    start: async () => { localVisible = true; return runtime.status() },
    stop: async () => { localVisible = false; return runtime.status() } }
  const source = read('server/index.ts')
  const section = source.slice(source.indexOf('// ---- pet runtime control'), source.indexOf("app.put('/api/pet/settings'"))
  runInNewContext(ts.transpile(section, { target: ts.ScriptTarget.ES2022 }), {
    app: { get: (url, fn) => routes.set(url, fn), post: (url, fn) => routes.set(url, fn) },
    pet: runtime, petSettings: { get: () => settings, update: (patch) => Object.assign(settings, patch) },
    petBridge: { sync: async () => {}, invalidate() {} }, PET_PACKAGE: {}, INSTANCE_NONCE: 'fixture',
    balanceFromUsage: () => ({ ok: false, provider: 'Synodica' }), usage: { report: () => ({}) },
  })
  const localFetch = async (url, init) => {
    const fn = routes.get(new URL(url).pathname)
    let status = fn ? 200 : 404, body
    const res = { status: (code) => { status = code; return res }, json: (value) => { body = value } }
    if (fn) await fn({ body: init?.body ? JSON.parse(init.body) : {} }, res)
    return { ok: status < 400, status, json: async () => body }
  }
  const desktop = read('desktop/app.cjs')
  const context = { ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    fromOffice: () => true, fromConnection: () => false,
    core: { remoteOfficeOrigin: () => ({ ok: true, value: 'https://office.example/' }) },
    URL: 'http://127.0.0.1:4310/', officeUrl: 'http://127.0.0.1:4310/', serverReady: true,
    remoteSession: { fetch: async () => ({ ok: true, json: async () => ({ authenticated: true }) }), clearStorageData: async () => {} },
    session: { defaultSession: { fetch: localFetch } }, globalThis: { URL }, quota: { close() {} },
    selectedOffice: { mode: 'local' }, mainWin: { isDestroyed: () => false }, connectionWin: null,
    createWindow: async (url) => { if (failWindow) throw new Error('window failed'); context.officeUrl = url },
    ensureLocalServer: async () => {}, saveConnection() {},
    stopLocalServer: async () => { localWork = false },
    startRemotePet: () => { remoteVisible = true }, stopRemotePet: () => { remoteVisible = false },
  }
  const start = desktop.indexOf('async function setLocalPetActive(')
  if (start !== -1) runInNewContext(desktop.slice(start, desktop.indexOf('\nfunction registerIpc()', start)), context)
  runInNewContext(desktop.slice(desktop.indexOf('function registerIpc()'), desktop.indexOf('\n/** The menu talks')) + ';registerIpc()', context)
  return { settings, localFetch,
    connect: () => handlers.get('office:connect')({}, { url: 'https://office.example/', token: 'fixture' }),
    disconnect: () => handlers.get('office:disconnect')({}),
    failWindow: () => { failWindow = true },
    state: () => ({ localVisible, remoteVisible, localWork }),
  }
}

test('office switching shows only the selected pet, preserves its preference and keeps local work alive', async () => {
  const f = fixture()
  await f.connect()
  assert.deepEqual(f.state(), { localVisible: false, remoteVisible: true, localWork: true })
  assert.equal(f.settings.enabled, true, 'temporary suspension must not overwrite the saved preference')
  await f.disconnect()
  assert.deepEqual(f.state(), { localVisible: true, remoteVisible: false, localWork: true })
})

test('a disabled local pet stays disabled across remote and local office switches', async () => {
  const f = fixture(false)
  await f.connect(); await f.disconnect()
  assert.deepEqual(f.state(), { localVisible: false, remoteVisible: false, localWork: true })
  assert.equal(f.settings.enabled, false)
})

test('failed remote window loading restores the local pet without starting the remote pet', async () => {
  const f = fixture(); f.failWindow()
  await assert.rejects(f.connect(), /window failed/)
  assert.deepEqual(f.state(), { localVisible: true, remoteVisible: false, localWork: true })
  assert.equal(f.settings.enabled, true)
})

test('local pet controls while viewing a remote office respect suspension and the saved preference', async () => {
  const f = fixture()
  await f.connect()
  await f.localFetch('http://127.0.0.1:4310/api/pet/start', { method: 'POST' })
  assert.equal(f.state().localVisible, false, 'another local page must not create a second desktop pet')
  await f.localFetch('http://127.0.0.1:4310/api/pet/stop', { method: 'POST' })
  await f.disconnect()
  assert.equal(f.state().localVisible, false, 'an explicit stop while away must be preserved')
  assert.equal(f.settings.enabled, false)
})
