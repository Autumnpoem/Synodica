// Electron-free logic for the native desktop pet: settings validation, IPC payload checks, window
// placement recovery and the single-overlay lifecycle. desktop/main.cjs imports the built copy
// (dist/shared/desktop.js); the server tests exercise it with fake windows and displays.
import { clampScale, followKey, parseAppLink, parseFollow, type AppLink } from './presence.js'

/** A remote office is an origin, never a path carrying credentials or a redirect target. */
export function remoteOfficeOrigin(raw: unknown): Checked<string> {
  if (typeof raw !== 'string' || raw.length > 2048) return { ok: false, error: 'enter an office URL' }
  try {
    const url = new URL(raw.trim())
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      return { ok: false, error: 'use an HTTPS office origin (HTTP is allowed only on loopback)' }
    }
    return { ok: true, value: `${url.origin}/` }
  } catch {
    return { ok: false, error: 'enter a valid office URL' }
  }
}

export interface OfficeConnection {
  mode: 'local' | 'remote'
  localUrl: string
  remoteUrl?: string
  connected?: boolean
  error?: string
}

export type SavedOffice = { mode: 'local' } | { mode: 'remote'; remoteUrl: string; error?: string }

/** A corrupt remote preference remains a remote choice so startup never silently opens local data. */
export function savedOffice(raw: unknown): SavedOffice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { mode: 'local' }
  const value = raw as Record<string, unknown>
  if (value.mode !== 'remote') return { mode: 'local' }
  const checked = remoteOfficeOrigin(value.remoteUrl)
  return checked.ok ? { mode: 'remote', remoteUrl: checked.value } : { mode: 'remote', remoteUrl: '', error: 'Saved remote office URL is invalid' }
}

/** Present the upstream web renderer as a desktop surface without changing its saved config. */
export function desktopPetConfig(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  return Object.fromEntries(Object.entries(raw as Record<string, unknown>).map(([entry, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [entry, value]
    const conf = value as Record<string, unknown>
    if (!Array.isArray(conf.pets)) return [entry, value]
    return [entry, { ...conf, pets: conf.pets.map((pet: unknown) => {
      if (!pet || typeof pet !== 'object' || Array.isArray(pet)) return pet
      const p = pet as Record<string, unknown>
      return { ...p, display: p.display === 'desktop' ? 'both' : p.display === 'web' ? 'none' : p.display }
    }) }]
  }))
}

export interface QuotaWindowLike {
  isDestroyed(): boolean
  show(): void
  focus(): void
  close(): void
  setAlwaysOnTop(value: boolean): void
  setSize(width: number, height: number): void
  onClosed(fn: () => void): void
}

/** One independently closable native quota window. Closing it never closes the main office. */
export class QuotaWindowController {
  private window: QuotaWindowLike | null = null
  private pinned = true
  private collapsed = false
  constructor(private readonly create: () => QuotaWindowLike) {}
  open(): { pinned: boolean; collapsed: boolean } {
    let win = this.window
    if (!win || win.isDestroyed()) {
      win = this.create()
      this.window = win
      const created = win
      win.onClosed(() => { if (this.window === created) this.window = null })
      win.setAlwaysOnTop(this.pinned)
      if (this.collapsed) win.setSize(340, 64)
    }
    win.show()
    win.focus()
    return this.state()
  }
  close(): void {
    const win = this.window
    this.window = null
    if (win && !win.isDestroyed()) win.close()
  }
  togglePin(): { pinned: boolean; collapsed: boolean } {
    this.pinned = !this.pinned
    if (this.window && !this.window.isDestroyed()) this.window.setAlwaysOnTop(this.pinned)
    return this.state()
  }
  toggleCollapse(): { pinned: boolean; collapsed: boolean } {
    this.collapsed = !this.collapsed
    if (this.window && !this.window.isDestroyed()) this.window.setSize(340, this.collapsed ? 64 : 460)
    return this.state()
  }
  state(): { pinned: boolean; collapsed: boolean } { return { pinned: this.pinned, collapsed: this.collapsed } }
}

export interface NativePetSettings {
  /** The overlay window exists and is shown. Off by default: nothing appears until you enable it. */
  visible: boolean
  scale: number
  alwaysOnTop: boolean
  /** Clicks pass through the pet to the windows below. Restore from the app menu or Settings. */
  clickThrough: boolean
  follow: string
  /** Animations off. */
  paused: boolean
  /** Last top-left position and the display it was on. */
  position?: { x: number; y: number; displayId?: number }
}

export const DEFAULT_NATIVE_PET: NativePetSettings = { visible: false, scale: 1, alwaysOnTop: true, clickThrough: false, follow: 'team', paused: false }

const COORD = 100_000

const coord = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= COORD ? Math.round(v) : undefined)

/** Read a stored settings file. Every field is checked; anything malformed falls back to the default. */
export function sanitizeNativeSettings(raw: unknown): NativePetSettings {
  const o = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const bool = (k: keyof NativePetSettings): boolean => (typeof o[k] === 'boolean' ? (o[k] as boolean) : (DEFAULT_NATIVE_PET[k] as boolean))
  const out: NativePetSettings = {
    visible: bool('visible'),
    scale: clampScale(o.scale, DEFAULT_NATIVE_PET.scale),
    alwaysOnTop: bool('alwaysOnTop'),
    clickThrough: bool('clickThrough'),
    follow: followKey(parseFollow(o.follow)),
    paused: bool('paused'),
  }
  const pos = o.position as Record<string, unknown> | undefined
  if (pos && typeof pos === 'object') {
    const x = coord(pos.x)
    const y = coord(pos.y)
    const d = typeof pos.displayId === 'number' && Number.isInteger(pos.displayId) ? pos.displayId : undefined
    if (x !== undefined && y !== undefined) out.position = { x, y, ...(d !== undefined ? { displayId: d } : {}) }
  }
  return out
}

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

const PATCH_KEYS = new Set(['visible', 'scale', 'alwaysOnTop', 'clickThrough', 'follow', 'paused'])

/**
 * A settings change from the main window (IPC). Strict: an object of known keys with the right
 * types. Position is never settable this way; it only changes by dragging the pet.
 */
export function checkSettingsPatch(raw: unknown): Checked<Partial<Omit<NativePetSettings, 'position'>>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'settings must be an object' }
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 0 || keys.length > PATCH_KEYS.size) return { ok: false, error: 'no settings to change' }
  const patch: Partial<Omit<NativePetSettings, 'position'>> = {}
  for (const k of keys) {
    if (!PATCH_KEYS.has(k)) return { ok: false, error: `unknown setting ${k.slice(0, 40)}` }
    const v = o[k]
    if (k === 'scale') {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0.5 || v > 2) return { ok: false, error: 'scale must be a number from 0.5 to 2' }
      patch.scale = clampScale(v)
    } else if (k === 'follow') {
      if (typeof v !== 'string' || v.length > 100) return { ok: false, error: 'follow must be a short string' }
      const f = parseFollow(v)
      if (followKey(f) !== v) return { ok: false, error: 'follow must be "team", "agent:<id>" or "project:<id>"' }
      patch.follow = v
    } else {
      if (typeof v !== 'boolean') return { ok: false, error: `${k} must be true or false` }
      ;(patch as Record<string, boolean>)[k] = v
    }
  }
  return { ok: true, value: patch }
}

/** A drag step from the pet window: small integer deltas only. */
export function checkDrag(raw: unknown): Checked<{ dx: number; dy: number }> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'drag must be an object' }
  const o = raw as Record<string, unknown>
  if (Object.keys(o).some((k) => k !== 'dx' && k !== 'dy')) return { ok: false, error: 'unexpected drag field' }
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && Math.abs(v) <= 4000
  if (!ok(o.dx) || !ok(o.dy)) return { ok: false, error: 'dx and dy must be integers within ±4000' }
  return { ok: true, value: { dx: o.dx, dy: o.dy } }
}

/** A link the pet asks the main window to open. Only the app's allow-listed views. */
export function checkLink(raw: unknown): Checked<AppLink> {
  const link = parseAppLink(raw)
  return link ? { ok: true, value: link } : { ok: false, error: 'not an allowed app link' }
}

/**
 * Whether an IPC message comes from our own page: exactly the app's origin (scheme, host, port).
 * Anything else (a navigated-away frame, file:, another port, a look-alike host) is refused.
 */
export function trustedSender(senderUrl: string | undefined, appOrigin: string): boolean {
  if (!senderUrl) return false
  try {
    return new URL(senderUrl).origin === new URL(appOrigin).origin
  } catch {
    return false
  }
}

/** External links from the main window: web and mail only, never file:, javascript: or custom schemes. */
export function externalAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:'
  } catch {
    return false
  }
}

// ---------- placement ----------

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface DisplayInfo {
  id: number
  workArea: Rect
}

export const PET_BASE = { width: 220, height: 230 }
const MARGIN = 24

export function petWindowSize(scale: number): { width: number; height: number } {
  const s = clampScale(scale)
  return { width: Math.round(PET_BASE.width * s), height: Math.round(PET_BASE.height * s) }
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

function clampInto(x: number, y: number, size: { width: number; height: number }, area: Rect): { x: number; y: number } {
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - size.width))),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - size.height))),
  }
}

/**
 * Where to put the pet. A saved position is kept if enough of the window is still on a connected
 * display (then clamped fully onto it); a position on a disconnected or rearranged display, or
 * off-screen, falls back to the bottom-right corner of the primary display.
 */
export function recoverPosition(saved: NativePetSettings['position'], size: { width: number; height: number }, displays: DisplayInfo[], primaryId: number): { x: number; y: number; displayId: number } {
  const primary = displays.find((d) => d.id === primaryId) ?? displays[0]
  if (!primary) return { x: 0, y: 0, displayId: primaryId }
  if (saved) {
    const rect = { x: saved.x, y: saved.y, width: size.width, height: size.height }
    let best: DisplayInfo | undefined
    let bestArea = 0
    for (const d of displays) {
      const a = overlap(rect, d.workArea)
      if (a > bestArea) {
        best = d
        bestArea = a
      }
    }
    // At least a quarter of the pet must be visible to count as "still there".
    if (best && bestArea >= (size.width * size.height) / 4) return { ...clampInto(saved.x, saved.y, size, best.workArea), displayId: best.id }
  }
  const area = primary.workArea
  return { x: Math.round(area.x + area.width - size.width - MARGIN), y: Math.round(area.y + area.height - size.height - MARGIN), displayId: primary.id }
}

// ---------- lifecycle ----------

/** The parts of a BrowserWindow the controller uses (fakes in tests). */
export interface PetWindowLike {
  isDestroyed(): boolean
  destroy(): void
  showInactive(): void
  setAlwaysOnTop(on: boolean, level?: string): void
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward: boolean }): void
  setBounds(r: Rect): void
  getBounds(): Rect
  onClosed(fn: () => void): void
  /** Send current settings to the pet page. */
  sendSettings(s: NativePetSettings): void
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(h: unknown): void
}

export interface PetControllerDeps {
  create(bounds: Rect): PetWindowLike
  displays(): { list: DisplayInfo[]; primaryId: number; nearest(r: Rect): number }
  save(s: NativePetSettings): void
  timers?: Timers
}

/**
 * Owns at most one overlay window. Every change goes through `apply`, so showing twice, a closed
 * window, a server reconnect or a second "show" click can never create a second window or timer.
 */
export class PetController {
  private win: PetWindowLike | null = null
  private saveTimer: unknown = null
  private readonly timers: Timers

  constructor(
    private settings: NativePetSettings,
    private readonly deps: PetControllerDeps,
  ) {
    this.timers = deps.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  }

  get current(): NativePetSettings {
    return this.settings
  }

  get window(): PetWindowLike | null {
    return this.win && !this.win.isDestroyed() ? this.win : null
  }

  /** Apply a validated patch (or nothing, to re-sync) and persist it. */
  apply(patch: Partial<NativePetSettings> = {}): NativePetSettings {
    this.settings = { ...this.settings, ...patch }
    if (!this.settings.visible) {
      this.close()
    } else {
      const size = petWindowSize(this.settings.scale)
      let win = this.window
      if (!win) {
        const { list, primaryId } = this.deps.displays()
        const pos = recoverPosition(this.settings.position, size, list, primaryId)
        this.settings.position = { x: pos.x, y: pos.y, displayId: pos.displayId }
        win = this.deps.create({ x: pos.x, y: pos.y, ...size })
        this.win = win
        const created = win
        created.onClosed(() => {
          // Closed from outside (window menu, OS): forget it, and remember it is hidden.
          if (this.win === created) {
            this.win = null
            if (this.settings.visible) {
              this.settings = { ...this.settings, visible: false }
              this.persistNow()
            }
          }
        })
        win.showInactive()
      } else {
        const b = win.getBounds()
        if (b.width !== size.width || b.height !== size.height) win.setBounds({ x: b.x, y: b.y, ...size })
      }
      win.setAlwaysOnTop(this.settings.alwaysOnTop, 'floating')
      win.setIgnoreMouseEvents(this.settings.clickThrough, { forward: true })
      win.sendSettings(this.settings)
    }
    this.persistNow()
    return this.settings
  }

  /** Move by a drag step, keeping the pet on a display. */
  dragBy(dx: number, dy: number): void {
    const win = this.window
    if (!win) return
    const b = win.getBounds()
    const displays = this.deps.displays()
    const next = { x: b.x + dx, y: b.y + dy, width: b.width, height: b.height }
    const id = displays.nearest(next)
    const area = displays.list.find((d) => d.id === id)?.workArea
    const pos = area ? clampInto(next.x, next.y, b, area) : { x: next.x, y: next.y }
    win.setBounds({ ...pos, width: b.width, height: b.height })
    this.settings.position = { ...pos, displayId: id }
    this.persistSoon()
  }

  /** Displays changed (unplugged, rearranged): bring a shown pet back onto a connected display. */
  recover(): void {
    const win = this.window
    if (!win) return
    const b = win.getBounds()
    const { list, primaryId } = this.deps.displays()
    const pos = recoverPosition({ x: b.x, y: b.y }, b, list, primaryId)
    if (pos.x !== b.x || pos.y !== b.y) win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height })
    this.settings.position = pos
    this.persistNow()
  }

  /** Back to the default corner of the primary display. */
  resetPosition(): void {
    delete this.settings.position
    const win = this.window
    if (win) {
      const b = win.getBounds()
      const { list, primaryId } = this.deps.displays()
      const pos = recoverPosition(undefined, b, list, primaryId)
      win.setBounds({ x: pos.x, y: pos.y, width: b.width, height: b.height })
      this.settings.position = pos
    }
    this.persistNow()
  }

  /** Forget the window and pending saves (app quit, main window closed). */
  dispose(): void {
    this.close()
    if (this.saveTimer !== null) {
      this.timers.clearTimeout(this.saveTimer)
      this.saveTimer = null
      this.deps.save(this.settings)
    }
  }

  private close(): void {
    const win = this.window
    this.win = null
    if (win) win.destroy()
  }

  private persistSoon(): void {
    if (this.saveTimer !== null) this.timers.clearTimeout(this.saveTimer)
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = null
      this.deps.save(this.settings)
    }, 400)
  }

  private persistNow(): void {
    if (this.saveTimer !== null) {
      this.timers.clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.deps.save(this.settings)
  }
}
