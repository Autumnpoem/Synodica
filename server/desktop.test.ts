// Native desktop pet logic without Electron: settings and IPC validation, sender checks, window
// placement recovery across displays, and the single-overlay lifecycle with fake windows.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkDrag, checkLink, checkSettingsPatch, DEFAULT_NATIVE_PET, externalAllowed, PetController, petWindowSize, recoverPosition, sanitizeNativeSettings, trustedSender, type DisplayInfo, type NativePetSettings, type PetWindowLike, type Rect } from '../shared/desktop.js'
import { fakeClock } from './testkit.js'

test('native settings: stored files are sanitised; defaults never show the pet unasked', () => {
  assert.deepEqual(sanitizeNativeSettings(null), DEFAULT_NATIVE_PET)
  assert.equal(DEFAULT_NATIVE_PET.visible, false)
  const s = sanitizeNativeSettings({ visible: 'yes', scale: 50, alwaysOnTop: false, clickThrough: true, follow: 'agent:qa', paused: 1, position: { x: 10.4, y: 1e9 } })
  assert.deepEqual(s, { visible: false, scale: 2, alwaysOnTop: false, clickThrough: true, follow: 'agent:qa', paused: false })
  assert.deepEqual(sanitizeNativeSettings({ position: { x: -50, y: 20, displayId: 3 } }).position, { x: -50, y: 20, displayId: 3 })
})

test('IPC settings patches are strict: known keys, right types, no position', () => {
  assert.deepEqual(checkSettingsPatch({ visible: true, scale: 1.5 }), { ok: true, value: { visible: true, scale: 1.5 } })
  assert.deepEqual(checkSettingsPatch({ follow: 'project:p1' }), { ok: true, value: { follow: 'project:p1' } })
  for (const bad of [null, [], 'visible', {}, { visible: 'true' }, { scale: 3 }, { scale: Number.NaN }, { follow: 'agent:../../x' }, { follow: 'team ' }, { position: { x: 1, y: 1 } }, { __proto__: { visible: true }, polluted: 1 }, { clickThrough: true, shell: 'rm -rf /' }]) {
    assert.equal(checkSettingsPatch(bad).ok, false, `refused: ${JSON.stringify(bad)}`)
  }
})

test('IPC drag and link payloads are validated; senders must be the app origin', () => {
  assert.deepEqual(checkDrag({ dx: 3, dy: -2 }), { ok: true, value: { dx: 3, dy: -2 } })
  for (const bad of [{ dx: 1.5, dy: 0 }, { dx: 99999, dy: 0 }, { dx: '1', dy: 0 }, { dx: 1 }, { dx: 1, dy: 1, x: 5 }, null]) assert.equal(checkDrag(bad).ok, false)
  assert.equal(checkLink('#/chat/c1').ok, true)
  assert.equal(checkLink({ view: 'office', projectId: 'p1' }).ok, true)
  for (const bad of ['https://evil.example', 'file:///etc/passwd', '#/chat/../x', { view: 'chat', conversationId: 'c', extra: 1 }]) assert.equal(checkLink(bad).ok, false)

  const origin = 'http://127.0.0.1:4310/'
  assert.ok(trustedSender('http://127.0.0.1:4310/#/pet', origin))
  assert.ok(trustedSender('http://127.0.0.1:4310/', origin))
  for (const bad of [undefined, '', 'http://127.0.0.1:4311/', 'http://localhost:4310/', 'https://127.0.0.1:4310/', 'file:///index.html', 'http://127.0.0.1.evil.example:4310/', 'not a url']) assert.equal(trustedSender(bad, origin), false, `untrusted: ${bad}`)
  assert.ok(externalAllowed('https://github.com/x'))
  for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'vscode://x', 'smb://host/share']) assert.equal(externalAllowed(bad), false)
})

const laptop: DisplayInfo = { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 875 } }
const external: DisplayInfo = { id: 2, workArea: { x: 1440, y: 0, width: 2560, height: 1415 } }

test('position recovery: kept on a connected display, clamped, or moved home when its display is gone', () => {
  const size = petWindowSize(1)
  assert.deepEqual(size, { width: 220, height: 230 })
  assert.deepEqual(petWindowSize(2), { width: 440, height: 460 })
  // No saved position: bottom-right of the primary display.
  assert.deepEqual(recoverPosition(undefined, size, [laptop, external], 1), { x: 1440 - 220 - 24, y: 25 + 875 - 230 - 24, displayId: 1 })
  // Saved on the external display, still connected: kept.
  assert.deepEqual(recoverPosition({ x: 3000, y: 600, displayId: 2 }, size, [laptop, external], 1), { x: 3000, y: 600, displayId: 2 })
  // Mostly visible but hanging off the edge: clamped fully on screen.
  assert.deepEqual(recoverPosition({ x: 1300, y: 800 }, size, [laptop], 1), { x: 1440 - 220, y: 25 + 875 - 230, displayId: 1 })
  // The external display was unplugged: back to the primary display.
  assert.deepEqual(recoverPosition({ x: 3000, y: 600, displayId: 2 }, size, [laptop], 1), { x: 1196, y: 646, displayId: 1 })
  // Far off-screen (a rearranged layout): back home, never invisible.
  assert.equal(recoverPosition({ x: -5000, y: -5000 }, size, [laptop, external], 1).displayId, 1)
  // A sliver on screen is not enough.
  assert.equal(recoverPosition({ x: 1430, y: 300 }, size, [laptop], 1).x, 1196)
})

class FakeWindow implements PetWindowLike {
  destroyed = false
  shown = 0
  top: boolean | undefined
  ignore: boolean | undefined
  sent: NativePetSettings[] = []
  private closed: (() => void)[] = []
  constructor(public bounds: Rect) {}
  isDestroyed() {
    return this.destroyed
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    for (const fn of this.closed) fn()
  }
  showInactive() {
    this.shown++
  }
  setAlwaysOnTop(on: boolean) {
    this.top = on
  }
  setIgnoreMouseEvents(ignore: boolean) {
    this.ignore = ignore
  }
  setBounds(r: Rect) {
    this.bounds = r
  }
  getBounds() {
    return this.bounds
  }
  onClosed(fn: () => void) {
    this.closed.push(fn)
  }
  sendSettings(s: NativePetSettings) {
    this.sent.push({ ...s })
  }
}

function controller(initial: Partial<NativePetSettings> = {}, displays: DisplayInfo[] = [laptop, external]) {
  const created: FakeWindow[] = []
  const saved: NativePetSettings[] = []
  const clock = fakeClock()
  const c = new PetController(
    { ...DEFAULT_NATIVE_PET, ...initial },
    {
      create: (b) => {
        const w = new FakeWindow(b)
        created.push(w)
        return w
      },
      displays: () => ({ list: displays, primaryId: 1, nearest: (r) => (r.x >= 1440 ? 2 : 1) }),
      save: (s) => saved.push(JSON.parse(JSON.stringify(s)) as NativePetSettings),
      timers: clock,
    },
  )
  return { c, created, saved, clock }
}

test('overlay lifecycle: one window at most, however often it is shown; hide destroys it; settings apply', () => {
  const { c, created, saved } = controller()
  c.apply()
  assert.equal(created.length, 0, 'disabled by default: no window')
  c.apply({ visible: true })
  c.apply({ visible: true })
  c.apply()
  assert.equal(created.length, 1, 'never a second window')
  const w = created[0]
  assert.ok(w)
  assert.equal(w.shown, 1)
  assert.equal(w.top, true)
  assert.equal(w.ignore, false)
  c.apply({ alwaysOnTop: false, clickThrough: true, scale: 1.5 })
  assert.equal(w.top, false)
  assert.equal(w.ignore, true)
  assert.deepEqual([w.bounds.width, w.bounds.height], [330, 345])
  assert.equal(w.sent.at(-1)?.clickThrough, true, 'the pet page learns the settings')
  c.apply({ clickThrough: false })
  assert.equal(w.ignore, false, 'click-through can always be turned off from the main window')
  c.apply({ visible: false })
  assert.ok(w.destroyed)
  assert.equal(c.window, null)
  assert.equal(saved.at(-1)?.visible, false)
  c.apply({ visible: true })
  assert.equal(created.length, 2, 'shown again: a fresh single window')
  c.dispose()
  assert.ok(created[1]?.destroyed)
})

test('overlay lifecycle: closed from outside → remembered as hidden; drag is clamped and saved once (debounced)', () => {
  const { c, created, saved, clock } = controller({ visible: true })
  c.apply()
  const w = created[0]
  assert.ok(w)
  w.destroy() // e.g. the OS closed it
  assert.equal(c.window, null)
  assert.equal(c.current.visible, false)
  assert.equal(saved.at(-1)?.visible, false)

  c.apply({ visible: true })
  const w2 = created[1]
  assert.ok(w2)
  const before = saved.length
  for (let i = 0; i < 20; i++) c.dragBy(-100, 0)
  assert.equal(saved.length, before, 'dragging does not write on every step')
  assert.equal(w2.bounds.x, 0, 'clamped to the display edge')
  clock.advance(500)
  assert.equal(saved.length, before + 1, 'one save after the drag settles')
  assert.equal(saved.at(-1)?.position?.x, 0)
  c.dragBy(5000, 0)
  c.dispose()
  assert.equal(saved.at(-1)?.position?.displayId, 2, 'a pending save is flushed on quit')
  assert.equal(clock.pending(), 0, 'no timers left behind')
})

test('overlay lifecycle: a saved position on an unplugged display is recovered on the next show', () => {
  const { c, created } = controller({ visible: true, position: { x: 3000, y: 600, displayId: 2 } }, [laptop])
  c.apply()
  assert.deepEqual([created[0]?.bounds.x, created[0]?.bounds.y], [1196, 646])
  assert.equal(c.current.position?.displayId, 1)
})

test('overlay lifecycle: unplugging the display under a shown pet brings it back; reset goes home', () => {
  const displays = [laptop, external]
  const { c, created, saved } = controller({ visible: true, position: { x: 3000, y: 600, displayId: 2 } }, displays)
  c.apply()
  const w = created[0]
  assert.ok(w)
  assert.equal(w.bounds.x, 3000)
  displays.pop() // the external display is gone
  c.recover()
  assert.deepEqual([w.bounds.x, w.bounds.y], [1196, 646])
  assert.equal(saved.at(-1)?.position?.displayId, 1)
  c.dragBy(-500, -300)
  c.resetPosition()
  assert.deepEqual([w.bounds.x, w.bounds.y], [1196, 646])
  assert.equal(created.length, 1, 'recovery never opens another window')
  c.dispose()
})
