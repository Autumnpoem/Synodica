import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import net from 'node:net'
import path from 'node:path'

/**
 * The confirmed upstream pet: dsh-pet by PC2005-cloud (MIT). It is installed unmodified from the
 * npm registry into pet-runtime/ (see scripts/pet-install.mjs); nothing is vendored into this repo.
 */
export const PET_PACKAGE = {
  name: 'dsh-pet',
  version: '0.3.8',
  integrity: 'sha512-E1ymE0/a1k2MJco2JDcWeqwMttjWNZWt5yMEN+jjKwWD+H2XT5OMUDmazMLhNnN5grmL9+lbE94iyEQMn5p+JA==',
  tarball: 'https://registry.npmjs.org/dsh-pet/-/dsh-pet-0.3.8.tgz',
  license: 'MIT',
  copyright: 'Copyright 2026 PC2005-cloud',
  homepage: 'https://github.com/PC2005-cloud/dsh-pet',
} as const

/** The upstream plugin's route prefix (its own route table, served by its own standalone host). */
export const PET_ROUTE = '/dsh-pet-7340'
export const PET_INSTALL_COMMAND = 'npm run pet:install'

export type PetPackageCheck = { ok: true; dir: string; version: string; webm: number } | { ok: false; dir?: string; reason: string; command: string }

/** Where the pinned package may be: an explicit override, then the pet-runtime install of this checkout. */
export function petPackageCandidates(appRoot: string, override: string | undefined): string[] {
  const out: string[] = []
  if (override && override.trim()) out.push(path.resolve(override.trim()))
  out.push(path.join(appRoot, 'pet-runtime', 'node_modules', PET_PACKAGE.name))
  return out
}

/**
 * Check that a folder really is the pinned upstream package with its original runtime and packaged
 * animations, and say how to fix it when it is not.
 */
export function inspectPetPackage(dir: string): PetPackageCheck {
  const command = PET_INSTALL_COMMAND
  if (!existsSync(dir)) return { ok: false, dir, reason: `the dsh-pet package is not installed (${dir} does not exist)`, command }
  let manifest: { name?: unknown; version?: unknown; license?: unknown; bin?: Record<string, unknown> }
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as typeof manifest
  } catch {
    return { ok: false, dir, reason: 'package.json is missing or unreadable', command }
  }
  if (manifest.name !== PET_PACKAGE.name) return { ok: false, dir, reason: `package name is ${String(manifest.name)}, expected ${PET_PACKAGE.name}`, command }
  if (manifest.version !== PET_PACKAGE.version) return { ok: false, dir, reason: `version ${String(manifest.version)} is installed, ${PET_PACKAGE.version} is pinned`, command }
  if (manifest.license !== PET_PACKAGE.license) return { ok: false, dir, reason: 'the license field does not match the pinned MIT package', command }
  for (const rel of ['lib/standalone.js', 'lib/client.js', 'lib/index.js', 'assets/config.jsonc', 'runtime/electron-helper/main.js', 'LICENSE']) {
    if (!existsSync(path.join(dir, rel))) return { ok: false, dir, reason: `${rel} is missing; the install is incomplete`, command }
  }
  const webmDir = path.join(dir, 'assets', 'webm')
  const webm = existsSync(webmDir) ? readdirSync(webmDir).filter((f) => f.endsWith('.webm')).length : 0
  if (webm === 0) return { ok: false, dir, reason: 'the packaged animations (assets/webm) are missing', command }
  return { ok: true, dir, version: PET_PACKAGE.version, webm }
}

export function findPetPackage(appRoot: string, override: string | undefined): PetPackageCheck {
  let last: PetPackageCheck = { ok: false, reason: 'no candidate folder', command: PET_INSTALL_COMMAND }
  for (const dir of petPackageCandidates(appRoot, override)) {
    const c = inspectPetPackage(dir)
    if (c.ok) return c
    // An override that exists but is wrong is the most useful message; a missing default comes second.
    if (existsSync(dir) || !last.dir) last = c
  }
  return last
}

/** The pet's own home (its DSH_HOME): app data, never the user's existing ~/.dsh profile. */
export function petHomeDir(dataDir: string): string {
  return path.join(dataDir, 'pet-home')
}

/** The application name the upstream desktop helper gives itself (app.setName in runtime/electron-helper/main.js). */
export const HELPER_APP_NAME = 'dsh-pet-electron-helper'

/**
 * The OS home the pet host and its helper see (HOME / USERPROFILE). Upstream derives its displayed
 * storage paths from it, and Electron on Linux derives its profile from it, so neither reaches the
 * user's real home.
 */
export function petOsHome(home: string): string {
  return path.join(home, 'os-home')
}

/**
 * The desktop helper's Electron profile (its userData, Chromium caches and DPI cache). This is the
 * same per-platform rule upstream uses for its settings page (desktopUserDataDir), applied to the
 * pet's own OS home, so the page shows the folder that is really used.
 */
export function helperProfileDir(home: string, platform: NodeJS.Platform = process.platform): string {
  const osHome = petOsHome(home)
  const join = platform === 'win32' ? path.win32.join : path.posix.join
  if (platform === 'win32') return join(osHome, 'AppData', 'Roaming', HELPER_APP_NAME)
  if (platform === 'darwin') return join(osHome, 'Library', 'Application Support', HELPER_APP_NAME)
  return join(osHome, '.config', HELPER_APP_NAME)
}

/**
 * How the upstream host starts its desktop helper with our Electron. The helper always runs through
 * Synodica's own Electron entry (desktop/main.cjs, helper mode), which sets the documented
 * app.setPath('userData' / 'sessionData') to helperProfileDir() before upstream code runs; the
 * installed upstream files are never changed.
 * - app-executable: a packaged app; its executable runs our entry by itself.
 * - launcher: a development Electron; a small generated launcher passes our app folder first.
 */
export type HelperLaunch = { mode: 'app-executable' } | { mode: 'launcher'; appEntry: string }

/** The generated launcher (POSIX shell). It holds no paths or secrets; everything comes from the environment. */
export const HELPER_LAUNCHER_SCRIPT = [
  '#!/bin/sh',
  '# Generated by Synodica. Starts the dsh-pet desktop helper through Synodica\'s Electron entry,',
  '# which moves the helper\'s Electron profile into the dedicated pet home before upstream code runs.',
  'exec "$OPENGROKBOT_PET_REAL_ELECTRON" "$OPENGROKBOT_PET_APP_ENTRY" "$@"',
  '',
].join('\n')

export function helperLauncherPath(home: string): string {
  return path.join(home, 'bin', 'opengrokbot-pet-helper')
}

// ---------- route policy for the browser side ----------

type Methods = readonly string[]
/** Upstream routes the in-page pet and its settings use, proxied behind our access control. */
const BROWSER_EXACT: Record<string, Methods> = {
  config: ['GET', 'PUT', 'POST'],
  'config/meta': ['GET'],
  'pet-display': ['POST'],
  reload: ['POST'],
  models: ['GET'],
  state: ['GET'],
  lock: ['POST'],
  'lock/release': ['POST'],
  'bubble/clear': ['POST'],
  anim: ['POST'],
  position: ['POST'],
  throw: ['POST'],
  pose: ['GET'],
  'pose/report': ['POST'],
  'menu/click': ['POST'],
}
const BROWSER_PREFIX: Record<string, Methods> = { thumb: ['GET', 'HEAD'], font: ['GET', 'HEAD'], pic: ['GET', 'HEAD'], playback: ['GET', 'POST'] }
/** Written only by Synodica's bridge on the server (real activity, our menu items). */
export const HOST_ONLY = new Set(['work-status', 'broadcast', 'menu/item', 'menu/events'])
/** Need DSH host services Synodica does not provide to the pet: answered truthfully as not configured. */
export const NOT_PROVIDED = new Set(['balance', 'whisper', 'chat'])

export type RouteDecision = { ok: true; rest: string; search: string } | { ok: false; status: number; body: Record<string, unknown> }

/**
 * Decide whether a browser request under /dsh-pet-7340 may reach the upstream host. Paths are
 * decoded and checked segment by segment: no traversal, separators, NUL or control characters.
 */
export function browserRoute(method: string, rawUrl: string): RouteDecision {
  // Dot segments (plain or percent-encoded) are refused before URL parsing could normalize them away.
  const rawPath = rawUrl.split('?')[0] ?? ''
  if (/(^|\/)(\.|%2e){1,2}(\/|$)/i.test(rawPath)) return { ok: false, status: 400, body: { error: 'malformed pet path' } }
  let url: URL
  try {
    url = new URL(rawUrl, 'http://localhost')
  } catch {
    return { ok: false, status: 400, body: { error: 'invalid pet route' } }
  }
  if (url.pathname !== PET_ROUTE && !url.pathname.startsWith(`${PET_ROUTE}/`)) return { ok: false, status: 404, body: { error: 'not a pet route' } }
  const encoded = url.pathname.slice(PET_ROUTE.length + 1)
  const segments = encoded.split('/')
  const decoded: string[] = []
  for (const s of segments) {
    let d: string
    try {
      d = decodeURIComponent(s)
    } catch {
      return { ok: false, status: 400, body: { error: 'malformed pet path' } }
    }
    // eslint-disable-next-line no-control-regex
    if (d === '' || d === '.' || d === '..' || /[\\/\u0000-\u001f\u007f]/.test(d) || d.length > 200) return { ok: false, status: 400, body: { error: 'malformed pet path' } }
    decoded.push(d)
  }
  const rest = decoded.join('/')
  if (HOST_ONLY.has(rest)) return { ok: false, status: 403, body: { error: 'this pet route is written by Synodica from real team activity only' } }
  if (NOT_PROVIDED.has(rest)) return { ok: false, status: 200, body: { ok: false, reason: 'not-configured', message: 'Synodica does not provide balance, chatter, pet chat or notification services to the pet. It stays off; no model is called.' } }
  const exact = BROWSER_EXACT[rest]
  const allowed = exact ?? (decoded.length > 1 ? BROWSER_PREFIX[decoded[0] as string] : undefined)
  if (!allowed) return { ok: false, status: 404, body: { error: 'unknown pet route' } }
  if (!allowed.includes(method)) return { ok: false, status: 405, body: { error: 'method not allowed' } }
  if (url.search.length > 512) return { ok: false, status: 400, body: { error: 'query too long' } }
  return { ok: true, rest: encoded, search: url.search }
}

/**
 * CSRF guard for state-changing pet requests: the browser must send our own origin (fetch does for
 * POST/PUT/DELETE) and must not be a cross-site request.
 */
export function sameOriginWrite(method: string, headers: IncomingMessage['headers']): boolean {
  if (method === 'GET' || method === 'HEAD') return headers['sec-fetch-site'] !== 'cross-site'
  const origin = headers.origin
  const host = headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  return origin === `http://${host}` || origin === `https://${host}`
}

// ---------- the upstream standalone host as a child process ----------

export type PetState = 'missing' | 'invalid' | 'stopped' | 'starting' | 'running' | 'stopping' | 'failed'

export interface PetStatus {
  state: PetState
  version: string
  reason?: string
  command?: string
  /** Packaged original animations found. */
  animations?: number
  /** Desktop (Electron helper) availability, as far as the server can tell. */
  desktop: 'available' | 'no-electron' | 'no-display'
  pid?: number
  /** Where the desktop helper keeps its Electron profile, and whether it is inside our app data. */
  helperProfile?: { dir: string; isolated: boolean; reason?: string }
}

export interface PetRuntimeOptions {
  appRoot: string
  dataDir: string
  /** OPENGROKBOT_PET_PACKAGE_DIR, for a verified install elsewhere. */
  packageDir?: string
  /** Our existing Electron binary; the upstream helper reuses it instead of downloading its own. */
  electronPath?: string
  /** How that Electron runs Synodica's entry for the helper (profile isolation). */
  helper?: HelperLaunch
  /** Base environment (tests pass a minimal one). Only an allowlist of it reaches the child. */
  env?: NodeJS.ProcessEnv
  /** How long to wait for the child to publish its port and capability. */
  startTimeoutMs?: number
  log?: (line: string) => void
  platform?: NodeJS.Platform
}

const ENV_ALLOW = ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']
/** A closed loopback port: if the upstream helper ever tries to download Electron, it fails at once. */
export const NO_DOWNLOAD_MIRROR = 'http://127.0.0.1:9/'

export interface PetEnvOptions {
  helper?: HelperLaunch
  /** The verified package folder: Synodica's helper entry only starts that package's helper. */
  packageDir?: string
  platform?: NodeJS.Platform
}

/**
 * Where the helper's profile ends up for a launch mode. Only the Windows development launch (no
 * POSIX launcher, no packaged executable) cannot be routed through our entry.
 */
export function helperProfileFor(home: string, electronPath: string | undefined, opts: PetEnvOptions = {}): { dir: string; isolated: boolean; reason?: string } {
  const platform = opts.platform ?? process.platform
  const dir = helperProfileDir(home, platform)
  if (!electronPath) return { dir, isolated: true, reason: 'no Electron: the desktop helper does not start' }
  if (opts.helper?.mode === 'app-executable') return { dir, isolated: true }
  if (opts.helper?.mode === 'launcher' && platform !== 'win32') return { dir, isolated: true }
  if (platform === 'linux') return { dir, isolated: true, reason: 'isolated through the pet home only (HOME)' }
  return { dir, isolated: false, reason: 'this development launch cannot route the helper through Synodica; the packaged app does' }
}

/** Environment for the upstream host: no secrets of ours, its own home, our Electron, no downloads. */
export function petEnv(base: NodeJS.ProcessEnv, home: string, electronPath: string | undefined, opts: PetEnvOptions = {}): NodeJS.ProcessEnv {
  const platform = opts.platform ?? process.platform
  const env: NodeJS.ProcessEnv = {}
  for (const k of ENV_ALLOW) if (base[k] !== undefined) env[k] = base[k]
  env.DSH_HOME = home
  // The host's and the helper's OS home is inside the pet home: upstream's storage paths and
  // Electron's Linux profile follow it, and the user's real home (and any DSH install) stays untouched.
  env.HOME = petOsHome(home)
  if (platform === 'win32') env.USERPROFILE = petOsHome(home)
  env.DSH_PET_ELECTRON_MIRROR = NO_DOWNLOAD_MIRROR
  // Bounded restarts so a broken display cannot loop forever.
  env.DSH_PET_RESTART_MAX_FAILURES = '3'
  if (electronPath && existsSync(electronPath)) {
    env.OPENGROKBOT_PET_HELPER_PROFILE = helperProfileDir(home, platform)
    if (opts.packageDir) env.OPENGROKBOT_PET_PACKAGE_ROOT = path.resolve(opts.packageDir)
    if (opts.helper?.mode === 'launcher' && platform !== 'win32') {
      env.DSH_PET_ELECTRON_PATH = helperLauncherPath(home)
      env.OPENGROKBOT_PET_REAL_ELECTRON = electronPath
      env.OPENGROKBOT_PET_APP_ENTRY = path.resolve(opts.helper.appEntry)
    } else env.DSH_PET_ELECTRON_PATH = electronPath
  }
  // Inside the desktop app the server itself runs on Electron as Node; the pet host must too (the
  // upstream helper removes this variable again for its own transparent Electron window).
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  return env
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address()
      const port = typeof a === 'object' && a ? a.port : 0
      srv.close(() => resolve(port))
    })
  })
}

/**
 * Runs the original upstream standalone host (lib/standalone.js: the plugin's own `apply` on a
 * host context, its own route table, its own Electron desktop helper) bound to loopback, with a
 * dedicated home under app data. Its capability token stays in this process: browsers reach the
 * routes only through `forward`, behind Synodica's access control and route policy.
 */
export class PetRuntime {
  private child: ChildProcess | null = null
  private port = 0
  private token = ''
  private state: PetState = 'stopped'
  private reason: string | undefined
  private check: PetPackageCheck
  /** Tail of the serialized lifecycle: every start and stop runs after the previous one finished. */
  private op: Promise<unknown> = Promise.resolve()
  /** The start in flight, shared by concurrent callers so there is only ever one host. */
  private starting: Promise<PetStatus> | null = null
  /** Bumped by every stop: a start from an older generation gives up at its next step. */
  private generation = 0
  /** Identifies one running host (changes on every successful start), for the bridge's publication cache. */
  private instanceId: string | undefined
  private instances = 0
  private disposed = false
  readonly home: string

  constructor(private readonly opts: PetRuntimeOptions) {
    this.home = petHomeDir(opts.dataDir)
    this.check = findPetPackage(opts.appRoot, opts.packageDir)
  }

  packageDir(): string | undefined {
    return this.check.ok ? this.check.dir : undefined
  }

  private envOptions(): PetEnvOptions {
    return { ...(this.opts.helper ? { helper: this.opts.helper } : {}), ...(this.check.ok ? { packageDir: this.check.dir } : {}), ...(this.opts.platform ? { platform: this.opts.platform } : {}) }
  }

  status(): PetStatus {
    const env = this.opts.env ?? process.env
    const display = process.platform !== 'linux' || Boolean(env.DISPLAY || env.WAYLAND_DISPLAY)
    const electron = this.opts.electronPath && existsSync(this.opts.electronPath) ? this.opts.electronPath : undefined
    const desktop: PetStatus['desktop'] = !display ? 'no-display' : electron ? 'available' : 'no-electron'
    const helperProfile = helperProfileFor(this.home, electron, this.envOptions())
    if (!this.check.ok) return { state: this.check.dir && existsSync(this.check.dir) ? 'invalid' : 'missing', version: PET_PACKAGE.version, reason: this.check.reason, command: this.check.command, desktop, helperProfile }
    return { state: this.state, version: PET_PACKAGE.version, animations: this.check.webm, desktop, helperProfile, ...(this.reason ? { reason: this.reason } : {}), ...(this.child?.pid ? { pid: this.child.pid } : {}) }
  }

  isRunning(): boolean {
    return this.state === 'running'
  }

  /** The running host's identity; undefined when no host runs. A restart always yields a new one. */
  instance(): string | undefined {
    return this.state === 'running' ? this.instanceId : undefined
  }

  /**
   * Start the upstream host, or join the start already in flight. Starts and stops are serialized,
   * so concurrent API calls can never spawn a second, untracked host.
   */
  start(): Promise<PetStatus> {
    if (this.disposed) return Promise.resolve({ ...this.status(), reason: 'the server is shutting down' })
    if (this.starting) return this.starting
    this.check = findPetPackage(this.opts.appRoot, this.opts.packageDir)
    if (!this.check.ok) return Promise.resolve(this.status())
    if (this.child && this.state === 'running') return Promise.resolve(this.status())
    const generation = this.generation
    this.state = 'starting'
    delete this.reason
    const run = this.serial(() => this.doStart(generation))
    const shared = run.finally(() => {
      if (this.starting === shared) this.starting = null
    })
    this.starting = shared
    return shared
  }

  /** Stop the host. A start in flight is cancelled; a stop waits until the host has really exited. */
  stop(): Promise<PetStatus> {
    this.generation++
    this.starting = null
    if (this.child || this.state === 'starting') this.state = 'stopping'
    return this.serial(() => this.doStop())
  }

  /** Server shutdown: stop the host and refuse new starts. */
  shutdown(): Promise<PetStatus> {
    this.disposed = true
    return this.stop()
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.op.then(fn, fn)
    this.op = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async doStart(generation: number): Promise<PetStatus> {
    const cancelled = () => generation !== this.generation || this.disposed
    if (cancelled()) return this.status()
    if (this.child && this.state === 'running') return this.status()
    if (!this.check.ok) return this.status()
    const pkg = this.check.dir
    mkdirSync(this.home, { recursive: true })
    let port: number
    try {
      port = await freePort()
    } catch (err) {
      this.state = 'failed'
      this.reason = `no free loopback port: ${err instanceof Error ? err.message : String(err)}`
      return this.status()
    }
    // A stop arrived while the port was being chosen: nothing is spawned.
    if (cancelled()) return this.status()
    const runtimeFile = path.join(this.home, 'dsh-pet', 'standalone-runtime.json')
    this.state = 'starting'
    const log = this.opts.log ?? ((line: string) => console.log(`[pet] ${line}`))
    const env = petEnv(this.opts.env ?? process.env, this.home, this.opts.electronPath, this.envOptions())
    mkdirSync(env.HOME as string, { recursive: true })
    if (env.OPENGROKBOT_PET_REAL_ELECTRON) this.writeLauncher()
    const child = spawn(process.execPath, [path.join(pkg, 'lib', 'standalone.js'), '--port', String(port)], {
      cwd: this.home,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    let tail = ''
    const keep = (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      tail = (tail + text).slice(-2000)
      for (const line of text.split('\n')) if (line.trim()) log(line.slice(0, 400))
    }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    child.once('error', (err) => {
      if (this.child !== child) return
      this.child = null
      this.token = ''
      this.state = 'failed'
      this.reason = `the pet host could not start: ${err.message}`
    })
    child.once('exit', (code, signal) => {
      if (this.child !== child) return
      this.child = null
      this.token = ''
      if (this.state !== 'stopping') {
        this.state = 'failed'
        this.reason = `the pet host exited (${signal ?? code})${tail ? `: ${tail.split('\n').filter(Boolean).slice(-2).join(' / ').slice(0, 300)}` : ''}`
      } else this.state = 'stopped'
    })
    const until = Date.now() + (this.opts.startTimeoutMs ?? 20000)
    while (Date.now() < until) {
      // A stop arrived: the queued stop terminates this child.
      if (cancelled()) return this.status()
      if (this.child !== child) return this.status()
      if (existsSync(runtimeFile)) {
        try {
          const info = JSON.parse(readFileSync(runtimeFile, 'utf8')) as { pid?: number; port?: number; token?: string }
          // Only our own child's announcement counts (its pid and the port we gave it): a stale file
          // or another program on the port is never attached to.
          if (info.pid === child.pid && info.port === port && typeof info.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(info.token)) {
            this.port = info.port
            this.token = info.token
            this.state = 'running'
            this.instanceId = `${child.pid}:${port}:${++this.instances}`
            return this.status()
          }
        } catch {
          // being written; retry
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    await this.terminate(child)
    this.state = 'failed'
    this.reason = 'the pet host did not start in time'
    return this.status()
  }

  private async doStop(): Promise<PetStatus> {
    const child = this.child
    if (!child) {
      if (this.state !== 'failed') this.state = 'stopped'
      return this.status()
    }
    this.state = 'stopping'
    await this.terminate(child)
    this.state = 'stopped'
    delete this.reason
    return this.status()
  }

  /** Ask the host to shut down, then signal it; resolves once the process has exited. */
  private async terminate(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
      if (this.child === child) this.child = null
      return
    }
    const exited = new Promise<void>((r) => child.once('exit', () => r()))
    this.state = 'stopping'
    try {
      if (this.token) await this.call('POST', '/shutdown')
    } catch {
      // fall through to a signal
    }
    const term = setTimeout(() => child.kill('SIGTERM'), 3000)
    const kill = setTimeout(() => child.kill('SIGKILL'), 8000)
    await exited
    clearTimeout(term)
    clearTimeout(kill)
    if (this.child === child) this.child = null
    this.token = ''
    this.instanceId = undefined
  }

  /** The development launcher (POSIX). Rewritten on every start; it contains no paths or secrets. */
  private writeLauncher(): void {
    const file = helperLauncherPath(this.home)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, HELPER_LAUNCHER_SCRIPT, { mode: 0o700 })
    chmodSync(file, 0o700)
  }

  /** A request from Synodica itself (the bridge) to the upstream host, with its capability. */
  call(method: string, pathAndQuery: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      if (!this.isRunning() && pathAndQuery !== '/shutdown') return reject(new Error('the pet runtime is not running'))
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
      const req = http.request({ host: '127.0.0.1', port: this.port, method, path: pathAndQuery, headers: { host: `127.0.0.1:${this.port}`, 'x-dsh-pet-token': this.token, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) }, timeout: 15000 }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json: unknown = text
          try {
            json = text ? JSON.parse(text) : null
          } catch {
            json = text
          }
          resolve({ status: res.statusCode ?? 0, json })
        })
      })
      req.on('timeout', () => req.destroy(new Error('pet host timed out')))
      req.on('error', reject)
      req.end(payload)
    })
  }

  /**
   * Forward an already authorized and policy-checked browser request. The browser's cookies,
   * authorization and origin never reach the child; our capability header is added here.
   */
  forward(req: IncomingMessage, res: ServerResponse, decision: Extract<RouteDecision, { ok: true }>): void {
    if (!this.isRunning()) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'the pet runtime is not running', status: this.status() }))
      return
    }
    const headers: http.OutgoingHttpHeaders = { host: `127.0.0.1:${this.port}`, 'x-dsh-pet-token': this.token }
    for (const h of ['content-type', 'content-length', 'range', 'if-none-match', 'if-modified-since', 'accept']) if (req.headers[h] !== undefined) headers[h] = req.headers[h]
    const upstream = http.request({ host: '127.0.0.1', port: this.port, method: req.method, path: `${PET_ROUTE}/${decision.rest}${decision.search}`, headers }, (r) => {
      const out: http.OutgoingHttpHeaders = {}
      for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !k.toLowerCase().startsWith('access-control-') && k.toLowerCase() !== 'set-cookie') out[k] = v
      out['x-content-type-options'] = 'nosniff'
      res.writeHead(r.statusCode ?? 502, out)
      r.pipe(res)
    })
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'the pet runtime did not answer' }))
    })
    res.on('close', () => upstream.destroy())
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > 1024 * 1024) {
        upstream.destroy()
        req.destroy()
      }
    })
    req.pipe(upstream)
  }

  /** The upstream browser half (lib/client.js), served to our page as-is. */
  clientScript(): string | undefined {
    if (!this.check.ok) return undefined
    const file = path.join(this.check.dir, 'lib', 'client.js')
    return existsSync(file) && statSync(file).isFile() ? file : undefined
  }
}
