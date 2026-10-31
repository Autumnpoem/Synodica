import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bubblesFor, menuTarget, nextFollow, parsePetSettings, PetBridge, petIds, PetSettingsStore, tierOf, workStatusFor, PET_MENU_OWNER } from './petbridge.js'
import { browserRoute, inspectPetPackage, NO_DOWNLOAD_MIRROR, petEnv, PetRuntime, PET_INSTALL_COMMAND, PET_PACKAGE, sameOriginWrite } from './petruntime.js'
import { tmp } from './testkit.js'
import type { ActivitySnapshot, AgentActivity } from '../shared/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = [path.join(here, '..'), path.join(here, '..', '..')].find((d) => existsSync(path.join(d, 'shared', 'i18n.ts'))) as string

/**
 * The real upstream package: an explicit OPENGROKBOT_PET_PACKAGE_DIR, this checkout's pet-runtime
 * install, or the read-only reference install prepared for this workspace (tests only; the app
 * itself never loads from .git).
 */
const upstream = [process.env.OPENGROKBOT_PET_PACKAGE_DIR, path.join(root, 'pet-runtime', 'node_modules', 'dsh-pet'), path.join(root, '.git', 'remote-claude', 'references', 'dsh-pet-runtime', 'node_modules', 'dsh-pet')].find((d): d is string => typeof d === 'string' && inspectPetPackage(d).ok)

function snap(activity: Partial<AgentActivity>[], extra: Partial<ActivitySnapshot> = {}): ActivitySnapshot {
  return {
    agents: [
      { id: 'ada', name: 'ADA', role: 'DEV', color: '#f00', shape: 'blob', provider: 'claude', model: 'm' },
      { id: 'bo', name: 'BO', role: 'QA', color: '#0f0', shape: 'round', provider: 'codex', model: 'm' },
    ],
    providers: {},
    projects: [{ id: 'p1', name: 'Shop', conversationId: 'c-p1', phase: 'executing', tasks: [{ id: 'T-1', title: 'Cart', state: 'running', ownerId: 'ada', reviewerId: 'bo' }] }],
    approvals: [],
    activity: activity.map((a) => ({ agentId: 'ada', state: 'idle', since: 0, ...a }) as AgentActivity),
    ledger: [],
    providerChecks: {},
    serverNow: 0,
    ...extra,
  }
}

test('the real activity to pet pose mapping: no celebration for replies, stops or errors; urgency wins', () => {
  assert.equal(tierOf('thinking'), 'thinking')
  assert.equal(tierOf('tool'), 'working')
  assert.equal(tierOf('waiting-approval'), 'waiting')
  assert.equal(tierOf('interrupted'), 'waiting', 'an aborted turn waits for you, it is not a success')
  assert.equal(tierOf('error'), 'error')
  assert.equal(tierOf('offline'), 'error')
  assert.equal(tierOf('replied'), 'result', 'a reply is not an accepted task')
  assert.equal(tierOf('done'), 'success', 'only an accepted task celebrates')
  assert.equal(tierOf('idle'), null)
  assert.equal(tierOf('queued'), null)
  const s = snap([{ agentId: 'ada', state: 'tool', taskRef: 'T-1', projectId: 'p1' }, { agentId: 'bo', state: 'waiting-approval', detail: 'Bash' }])
  assert.deepEqual(workStatusFor(s, { kind: 'team' }), { state: 'waiting', task: 'BO Bash', agentId: 'bo' })
  assert.deepEqual(workStatusFor(s, { kind: 'agent', id: 'ada' }), { state: 'working', task: 'ADA T-1', agentId: 'ada' })
  assert.deepEqual(workStatusFor(snap([]), { kind: 'team' }), { state: null, task: null })
  const long = workStatusFor(snap([{ agentId: 'ada', state: 'thinking', detail: 'x'.repeat(80) }]), { kind: 'team' })
  assert.ok([...(long.task ?? '')].length <= 40, 'task text respects the upstream limit')
})

test('pet bubbles come only from real transitions; menu items open the real task, approval or office', () => {
  const before = snap([])
  const after = snap([], {
    projects: [{ id: 'p1', name: 'Shop', conversationId: 'c-p1', phase: 'executing', tasks: [{ id: 'T-1', title: 'Cart', state: 'accepted', ownerId: 'ada', reviewerId: 'bo' }] }],
    approvals: [{ id: 'ap-1', conversationId: 'c-p1', agentId: 'bo', tool: 'Bash', createdAt: 1 }],
  })
  assert.deepEqual(bubblesFor(undefined, after, { kind: 'team' }, 'en'), [], 'no bubbles on the first snapshot')
  assert.deepEqual(bubblesFor(before, after, { kind: 'team' }, 'en'), ['T-1 was accepted', 'BO needs your approval'])
  assert.deepEqual(bubblesFor(after, after, { kind: 'team' }, 'en'), [], 'nothing changed, nothing said')
  assert.equal(menuTarget('pet.menu.openApprovals', after, { kind: 'team' }), '#/approval/ap-1')
  assert.equal(menuTarget('pet.menu.openOffice', after, { kind: 'project', id: 'p1' }), '#/office/p1')
  assert.equal(menuTarget('pet.menu.openTask', snap([{ agentId: 'ada', state: 'tool', conversationId: 'c-p1' }]), { kind: 'team' }), '#/chat/c-p1')
  assert.deepEqual(nextFollow(after, { kind: 'team' }), { kind: 'project', id: 'p1' })
  assert.deepEqual(nextFollow(after, { kind: 'project', id: 'p1' }), { kind: 'agent', id: 'ada' })
  assert.deepEqual(nextFollow(after, { kind: 'agent', id: 'bo' }), { kind: 'team' })
  const opened: string[] = []
  let follow: ReturnType<typeof parsePetSettings>['follow'] = { kind: 'team' }
  const bridge = new PetBridge({ runtime: { isRunning: () => false, call: async () => ({ status: 0, json: null }) }, snapshot: () => after, settings: () => parsePetSettings({ follow }), setFollow: (f) => (follow = f), navigate: (h) => opened.push(h) })
  assert.deepEqual(bridge.handleClicks({ 'Open approvals': 'main', 'Open office': null }), ['#/approval/ap-1'])
  bridge.handleClicks({ 'Follow next': 'main' })
  assert.deepEqual(follow, { kind: 'project', id: 'p1' })
  assert.deepEqual(petIds({ main: { pets: [{ id: 'main', display: 'both' }, { id: 'pet-2', display: 'none' }] }, pack: { pets: [{ id: 'fish' }] } }), ['main', 'fish'])
})

test('pet settings persist and malformed follow ids are rejected', () => {
  const dir = tmp()
  const store = new PetSettingsStore(dir)
  assert.equal(store.get().enabled, false, 'nothing starts by default')
  store.update({ follow: { kind: 'project', id: 'p1' }, bubbles: false, locale: 'zh-CN' })
  store.update({ follow: { kind: 'agent', id: '../../etc' } })
  store.update({ follow: { kind: 'agent', id: 'a'.repeat(200) } })
  const again = new PetSettingsStore(dir).get()
  assert.deepEqual(again.follow, { kind: 'project', id: 'p1' })
  assert.equal(again.bubbles, false)
  assert.equal(again.locale, 'zh-CN')
  assert.equal(parsePetSettings({ locale: 'xx', enabled: 'yes' }).locale, 'en')
  assert.equal(parsePetSettings({ enabled: 'yes' }).enabled, false)
})

test('browser pet routes: only the upstream renderer and settings routes pass; traversal, host-only and paid routes do not', () => {
  assert.equal(browserRoute('GET', '/dsh-pet-7340/config').ok, true)
  assert.equal(browserRoute('PUT', '/dsh-pet-7340/config').ok, true)
  assert.equal(browserRoute('GET', '/dsh-pet-7340/state?since=3&timeout=1000').ok, true)
  assert.equal(browserRoute('GET', `/dsh-pet-7340/thumb/main/${encodeURIComponent('clip name')}.webm`).ok, true)
  assert.equal(browserRoute('POST', '/dsh-pet-7340/menu/click').ok, true)
  for (const bad of ['/dsh-pet-7340/thumb/main/..%2F..%2Fpackage.json', '/dsh-pet-7340/thumb/%2e%2e/x.webm', '/dsh-pet-7340/thumb/main/a%5Cb.webm', '/dsh-pet-7340/thumb/main/a%00.webm', '/dsh-pet-7340/thumb//x.webm', '/dsh-pet-7340/thumb/main/%E0%A4%A.webm']) {
    const d = browserRoute('GET', bad)
    assert.equal(d.ok, false, bad)
    assert.equal(d.ok ? 0 : d.status, 400, bad)
  }
  const hostOnly = browserRoute('POST', '/dsh-pet-7340/work-status')
  assert.equal(hostOnly.ok ? 0 : hostOnly.status, 403, 'pages cannot fake work progress')
  assert.equal(browserRoute('POST', '/dsh-pet-7340/broadcast?pet=main').ok, false)
  assert.equal(browserRoute('POST', '/dsh-pet-7340/menu/item').ok, false)
  const whisper = browserRoute('POST', '/dsh-pet-7340/whisper?pet=main')
  assert.equal(whisper.ok, false)
  assert.equal(whisper.ok ? '' : (whisper.body as { reason?: string }).reason, 'not-configured', 'chatter is truthfully off, not faked')
  assert.equal(browserRoute('POST', '/dsh-pet-7340/balance').ok, false)
  const unknown = browserRoute('GET', '/dsh-pet-7340/standalone-ai/settings')
  assert.equal(unknown.ok ? 0 : unknown.status, 404)
  const method = browserRoute('DELETE', '/dsh-pet-7340/config')
  assert.equal(method.ok ? 0 : method.status, 405)
  assert.equal(browserRoute('GET', '/other').ok, false)
})

test('bridge publication: disabling clears the old pose once, a restart resends unchanged state, a stopped host and failed writes are not remembered', async () => {
  let running = true
  let instance = 'host-1'
  let failNext = false
  const sent: string[] = []
  const runtime = {
    isRunning: () => running,
    instance: () => (running ? instance : undefined),
    call: async (method: string, p: string, body?: unknown): Promise<{ status: number; json: unknown }> => {
      if (p.endsWith('/menu/item')) return { status: 200, json: { ok: true } }
      if (p.includes('/menu/events')) return { status: 200, json: { ok: false } }
      if (p.endsWith('/work-status')) {
        sent.push(`${method}${body ? ` ${(body as { state: string }).state}` : ''}`)
        if (failNext) {
          failNext = false
          return { status: 500, json: null }
        }
      }
      return { status: 200, json: { ok: true } }
    },
  }
  let settings = parsePetSettings({ enabled: true, bubbles: false })
  const working = snap([{ agentId: 'ada', state: 'tool', taskRef: 'T-1', projectId: 'p1' }])
  const bridge = new PetBridge({ runtime, snapshot: () => working, settings: () => settings, setFollow: () => {}, navigate: () => {} })
  await bridge.sync()
  await bridge.sync()
  assert.deepEqual(sent, ['POST working'], 'published once; an unchanged state is not resent to the same host')
  settings = parsePetSettings({ enabled: true, bubbles: false, bridge: false })
  await bridge.sync()
  await bridge.sync()
  assert.deepEqual(sent.slice(1), ['DELETE'], 'turning the bridge off clears the earlier pose exactly once')
  settings = parsePetSettings({ enabled: true, bubbles: false })
  await bridge.sync()
  assert.deepEqual(sent.slice(2), ['POST working'], 'turning it back on publishes the current state again')
  // Restart: a new host instance with the very same activity still gets it.
  instance = 'host-2'
  await bridge.sync()
  assert.deepEqual(sent.slice(3), ['POST working'])
  // Stopped host: nothing is sent and the cache is dropped, so the next host (even one reporting the
  // same id) is published to from scratch.
  running = false
  await bridge.sync()
  assert.equal(sent.length, 4)
  running = true
  await bridge.sync()
  assert.deepEqual(sent.slice(4), ['POST working'])
  // Explicit invalidation (the stop route) has the same effect.
  bridge.invalidate()
  await bridge.sync()
  assert.deepEqual(sent.slice(5), ['POST working'])
  // A write the host refused is retried on the next sync instead of being remembered.
  bridge.invalidate()
  failNext = true
  await bridge.sync()
  await bridge.sync()
  assert.deepEqual(sent.slice(6), ['POST working', 'POST working'])
  await bridge.sync()
  assert.equal(sent.length, 8)
  bridge.stop()
})

test('pet writes need our own origin; cross-site requests are refused', () => {
  assert.equal(sameOriginWrite('PUT', { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310' }), true)
  assert.equal(sameOriginWrite('PUT', { host: '127.0.0.1:4310', origin: 'http://evil.example' }), false)
  assert.equal(sameOriginWrite('POST', { host: '127.0.0.1:4310' }), false, 'a write without an origin is refused')
  assert.equal(sameOriginWrite('POST', { host: '127.0.0.1:4310', origin: 'http://127.0.0.1:4310', 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(sameOriginWrite('GET', { host: '127.0.0.1:4310' }), true)
  assert.equal(sameOriginWrite('GET', { host: '127.0.0.1:4310', 'sec-fetch-site': 'cross-site' }), false)
})

test('the pet host environment carries no secrets, uses its own home and never downloads Electron', () => {
  const base = { PATH: '/bin', HOME: '/home/u', OPENGROKBOT_TOKEN: 'secret', ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', DSH_HOME: '/home/u/.dsh' }
  const env = petEnv(base, '/data/pet-home', '/no/such/electron')
  assert.equal(env.OPENGROKBOT_TOKEN, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.DSH_HOME, '/data/pet-home', 'never the existing DSH profile of the user')
  assert.equal(env.DSH_PET_ELECTRON_MIRROR, NO_DOWNLOAD_MIRROR)
  assert.equal(env.DSH_PET_ELECTRON_PATH, undefined, 'only an Electron that exists is passed')
  assert.equal(petEnv(base, '/h', process.execPath).DSH_PET_ELECTRON_PATH, process.execPath)
})

test('a missing or wrong pet package gives an actionable message', () => {
  const missing = inspectPetPackage(path.join(tmp(), 'nope'))
  assert.equal(missing.ok, false)
  assert.equal(missing.ok ? '' : missing.command, PET_INSTALL_COMMAND)
  const fake = tmp()
  writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: '0.0.1', license: 'MIT' }))
  const wrong = inspectPetPackage(fake)
  assert.match(wrong.ok ? '' : wrong.reason, /0\.0\.1 is installed, 0\.3\.8 is pinned/)
  writeFileSync(path.join(fake, 'package.json'), JSON.stringify({ name: 'dsh-pet', version: PET_PACKAGE.version, license: 'MIT' }))
  assert.match((inspectPetPackage(fake) as { reason: string }).reason, /lib\/standalone\.js is missing/)
  const rt = new PetRuntime({ appRoot: tmp(), dataDir: tmp(), packageDir: path.join(tmp(), 'absent'), env: { PATH: process.env.PATH ?? '' } })
  assert.equal(rt.status().state, 'missing')
  assert.equal(rt.status().command, PET_INSTALL_COMMAND)
})

test('the ORIGINAL upstream dsh-pet host runs behind the proxy: packaged animations, real work status, settings and multiple pets persist', { skip: upstream ? false : 'dsh-pet 0.3.8 is not installed here (run npm run pet:install)' }, async () => {
  const pkg = upstream as string
  const check = inspectPetPackage(pkg)
  assert.ok(check.ok && check.webm > 50, 'the published package with its original webm animations')
  const dataDir = tmp()
  // No DISPLAY: the upstream host skips its desktop helper by itself (headless test).
  const rt = new PetRuntime({ appRoot: tmp(), dataDir, packageDir: pkg, env: { PATH: process.env.PATH ?? '' }, log: () => {} })
  const started = await rt.start()
  assert.equal(started.state, 'running', started.reason)
  const server = http.createServer((req, res) => {
    const d = browserRoute(req.method ?? 'GET', req.url ?? '/')
    if (!d.ok) {
      res.writeHead(d.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(d.body))
      return
    }
    if (!sameOriginWrite(req.method ?? 'GET', req.headers)) {
      res.writeHead(403)
      res.end()
      return
    }
    rt.forward(req, res, d)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    // It is the original module: the standalone host reports the package root it runs from.
    const health = await rt.call('GET', '/health')
    const info = health.json as { name?: string; plugin?: { root?: string; version?: string } }
    assert.equal(info.name, 'dsh-pet-standalone')
    assert.equal(realpathSync(info.plugin?.root ?? ''), realpathSync(pkg))
    assert.equal(info.plugin?.version, '0.3.8')

    const cfg = (await (await fetch(`${base}/dsh-pet-7340/config`)).json()) as Record<string, { pets?: { id: string }[] }>
    const firstPet = cfg.main?.pets?.[0]?.id
    assert.ok(firstPet, 'the upstream merged config has the main pet')

    // An original packaged animation resolves through the upstream /thumb route (VP9 WebM = EBML header).
    const clip = readdirSync(path.join(pkg, 'assets', 'webm')).find((f) => f.endsWith('.webm')) as string
    const asset = await fetch(`${base}/dsh-pet-7340/thumb/${encodeURIComponent(firstPet)}/${encodeURIComponent(clip)}`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /video\/webm/)
    const head = new Uint8Array(await asset.arrayBuffer()).slice(0, 4)
    assert.deepEqual([...head], [0x1a, 0x45, 0xdf, 0xa3])
    assert.equal(asset.headers.get('access-control-allow-origin'), null, 'no wildcard CORS reaches the page')

    // The page cannot fake progress; the bridge publishes real activity through the upstream API.
    assert.equal((await fetch(`${base}/dsh-pet-7340/work-status`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ state: 'success' }) })).status, 403)
    let activity = snap([{ agentId: 'ada', state: 'tool', taskRef: 'T-1', projectId: 'p1' }])
    const bridge = new PetBridge({ runtime: rt, snapshot: () => activity, settings: () => parsePetSettings({ enabled: true }), setFollow: () => {}, navigate: () => {} })
    await bridge.sync()
    let st = (await (await fetch(`${base}/dsh-pet-7340/state`)).json()) as { sections?: { workStatus?: { data?: { state?: string; task?: string } }; menu?: { data?: { items?: { owner: string }[] } } } }
    assert.equal(st.sections?.workStatus?.data?.state, 'working')
    assert.equal(st.sections?.workStatus?.data?.task, 'ADA T-1')
    assert.ok(st.sections?.menu?.data?.items?.some((i) => i.owner === PET_MENU_OWNER), 'our menu items are in the upstream right-click menu')
    // A provider error, then an abort (interrupted), never becomes a success pose.
    activity = snap([{ agentId: 'ada', state: 'error', detail: 'provider error' }])
    await bridge.sync()
    st = (await (await fetch(`${base}/dsh-pet-7340/state`)).json()) as typeof st
    assert.equal(st.sections?.workStatus?.data?.state, 'error')
    activity = snap([{ agentId: 'ada', state: 'interrupted' }])
    await bridge.sync()
    st = (await (await fetch(`${base}/dsh-pet-7340/state`)).json()) as typeof st
    assert.equal(st.sections?.workStatus?.data?.state, 'waiting')
    activity = snap([])
    await bridge.sync()
    st = (await (await fetch(`${base}/dsh-pet-7340/state`)).json()) as typeof st
    assert.equal(st.sections?.workStatus?.data?.state ?? null, null, 'idle clears the pose')
    bridge.stop()

    // Paid / host-only features are truthfully off.
    const whisper = (await (await fetch(`${base}/dsh-pet-7340/whisper?pet=main&surface=any`, { method: 'POST', headers: { origin: base } })).json()) as { reason?: string }
    assert.equal(whisper.reason, 'not-configured')

    // Upstream settings: two pet instances saved through the upstream settings API (same origin only).
    const pets = [
      { id: firstPet, name: 'One', size: 300, balanceEnabled: false, display: 'web', position: { corner: 'bottom-right', marginX: 20, marginY: 20 } },
      { id: 'pet-2', name: 'Two', size: 200, balanceEnabled: false, display: 'web', position: { corner: 'bottom-left', marginX: 30, marginY: 40 } },
    ]
    assert.equal((await fetch(`${base}/dsh-pet-7340/config`, { method: 'PUT', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ pets }) })).status, 403)
    const saved = await fetch(`${base}/dsh-pet-7340/config`, { method: 'PUT', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ pets }) })
    assert.equal(saved.status, 200)
    assert.ok(existsSync(path.join(dataDir, 'pet-home', 'dsh-pet', 'main-config.jsonc')), 'written to the dedicated pet home under app data')
  } finally {
    await rt.stop()
    await new Promise<void>((r) => server.close(() => r()))
  }
  assert.equal(rt.status().state, 'stopped')
  // Restart: the settings and both instances persist.
  const again = await rt.start()
  assert.equal(again.state, 'running', again.reason)
  try {
    const cfg = (await rt.call('GET', '/dsh-pet-7340/config')).json as Record<string, { pets?: { id: string; size: number; display: string }[] }>
    const ids = (cfg.main?.pets ?? []).map((p) => p.id)
    assert.equal(ids.length, 2)
    assert.ok(ids.includes('pet-2'))
    assert.equal(cfg.main?.pets?.find((p) => p.id === 'pet-2')?.size, 200)
    assert.equal(cfg.main?.pets?.find((p) => p.id === 'pet-2')?.display, 'web')
    const stored = readFileSync(path.join(dataDir, 'pet-home', 'dsh-pet', 'main-config.jsonc'), 'utf8')
    assert.match(stored, /pet-2/)
  } finally {
    await rt.stop()
  }
  mkdirSync(path.join(dataDir, 'x'), { recursive: true })
})
