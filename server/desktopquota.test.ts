import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { QuotaWindowController, desktopPetConfig, remoteOfficeOrigin, savedOffice, type QuotaWindowLike } from '../shared/desktop.js'

test('remote office accepts only a plain HTTPS origin or loopback HTTP', () => {
  assert.deepEqual(remoteOfficeOrigin('https://office.example.com/'), { ok: true, value: 'https://office.example.com/' })
  assert.deepEqual(remoteOfficeOrigin('http://127.0.0.1:4310/'), { ok: true, value: 'http://127.0.0.1:4310/' })
  for (const raw of ['http://office.example.com/', 'https://user:secret@office.example.com/', 'https://office.example.com/?token=secret', 'https://office.example.com/#/chat', 'https://office.example.com/other', 'file:///etc/passwd', 'javascript:alert(1)', 'https://office.example.com.evil.invalid/path']) {
    assert.equal(remoteOfficeOrigin(raw).ok, false, raw)
  }
})

test('saved remote choice keeps startup remote; only URL and mode survive parsing', () => {
  assert.deepEqual(savedOffice(undefined), { mode: 'local' })
  assert.deepEqual(savedOffice({ mode: 'local', token: 'secret' }), { mode: 'local' })
  assert.deepEqual(savedOffice({ mode: 'remote', remoteUrl: 'https://office.example.com/', token: 'secret', credentials: { key: 'secret' } }), { mode: 'remote', remoteUrl: 'https://office.example.com/' })
  assert.deepEqual(savedOffice({ mode: 'remote', remoteUrl: 'http://public.example.com/' }), { mode: 'remote', remoteUrl: '', error: 'Saved remote office URL is invalid' })
})

test('remote native pet renders desktop and both configs without changing upstream config', () => {
  const source = { main: { pets: [
    { id: 'desktop', display: 'desktop' }, { id: 'both', display: 'both' },
    { id: 'web', display: 'web' }, { id: 'hidden', display: 'none' },
  ] }, extra: { pets: [{ id: 'addon', display: 'desktop' }] } }
  const result = desktopPetConfig(source) as typeof source
  assert.deepEqual(result.main.pets.map((p) => p.display), ['both', 'both', 'none', 'none'])
  assert.deepEqual(result.extra.pets.map((p) => p.display), ['both'])
  assert.equal(source.main.pets[0]?.display, 'desktop', 'the server-owned config is not mutated')
})

test('an old remote pet status cannot reopen a pet after switching to local', async () => {
  const source = readFileSync(new URL('../../desktop/app.cjs', import.meta.url), 'utf8')
  const match = source.match(/async function syncRemotePet\(\) \{[\s\S]*?\n\}\n\nfunction startRemotePet/)
  assert.ok(match, 'exercise the native syncRemotePet implementation')
  let answer!: (status: unknown) => void
  const pending = new Promise((resolve) => { answer = resolve })
  let opened = 0
  const context = {
    officeUrl: 'https://office.example.com/', URL: 'http://127.0.0.1:4310/',
    mainWin: { isDestroyed: () => false }, remotePetChecking: false, remotePetDismissed: false,
    petCall: () => pending, openRemotePet: () => { opened++ }, closeRemotePet: () => {},
  }
  const sync = runInNewContext(`${match[0].slice(0, -'\n\nfunction startRemotePet'.length)}; syncRemotePet`, context) as () => Promise<void>
  const inFlight = sync()
  context.officeUrl = context.URL // disconnect while the remote status request is pending
  answer({ settings: { enabled: true }, status: { state: 'running' } })
  await inFlight
  assert.equal(opened, 0, 'a response for the old office must not create a window for the local URL')
})

class FakeQuotaWindow implements QuotaWindowLike {
  closed = false
  shown = 0
  focused = 0
  pinned = false
  size: [number, number] = [340, 460]
  private handlers: (() => void)[] = []
  isDestroyed() { return this.closed }
  show() { this.shown++ }
  focus() { this.focused++ }
  close() { this.closed = true; this.handlers.forEach((h) => h()) }
  setAlwaysOnTop(v: boolean) { this.pinned = v }
  setSize(w: number, h: number) { this.size = [w, h] }
  onClosed(fn: () => void) { this.handlers.push(fn) }
}

test('quota window has one live instance; close and reopen do not affect other windows', () => {
  const created: FakeQuotaWindow[] = []
  const quota = new QuotaWindowController(() => {
    const win = new FakeQuotaWindow()
    created.push(win)
    return win
  })
  assert.deepEqual(quota.open(), { pinned: true, collapsed: false })
  quota.open()
  assert.equal(created.length, 1)
  assert.equal(created[0]?.shown, 2)
  assert.equal(created[0]?.pinned, true)
  assert.deepEqual(quota.toggleCollapse(), { pinned: true, collapsed: true })
  assert.deepEqual(created[0]?.size, [340, 64])
  assert.deepEqual(quota.togglePin(), { pinned: false, collapsed: true })
  assert.equal(created[0]?.pinned, false)
  quota.close()
  assert.equal(created[0]?.closed, true)
  quota.open()
  assert.equal(created.length, 2)
  assert.deepEqual(created[1]?.size, [340, 64])
  assert.equal(created[1]?.pinned, false)
  assert.deepEqual(quota.state(), { pinned: false, collapsed: true }, 'the renderer can query restored native state')
})
