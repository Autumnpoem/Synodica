import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isLocale, translate, type Locale, type MessageKey } from '../shared/i18n.js'
import type { ActivitySnapshot, AgentActivityState } from '../shared/types.js'
import type { PetRuntime } from './petruntime.js'

/** Upstream work-status tiers (dsh-pet HOST_WORK_STATUS_STATES), null = idle. */
export type PetWorkState = 'thinking' | 'working' | 'result' | 'waiting' | 'success' | 'error'
/** Upstream TASK_TEXT_MAX (code points). */
export const PET_TASK_MAX = 40
const PRIORITY: PetWorkState[] = ['waiting', 'error', 'working', 'thinking', 'result', 'success']

export type PetFollow = { kind: 'team' } | { kind: 'project'; id: string } | { kind: 'agent'; id: string }

export interface PetSettings {
  /** Start the upstream pet host with the server. Off by default: nothing starts or downloads by itself. */
  enabled: boolean
  follow: PetFollow
  /** Drive the pet's work-status poses from real activity. */
  bridge: boolean
  /** Speech bubbles for accepted tasks, failures and approvals. */
  bubbles: boolean
  /** Render the upstream in-page overlay in the app window. */
  overlay: boolean
  /** Language of bridge bubbles and our pet menu items. */
  locale: Locale
}

export const DEFAULT_PET_SETTINGS: PetSettings = { enabled: false, follow: { kind: 'team' }, bridge: true, bubbles: true, overlay: true, locale: 'en' }

const ID = /^[A-Za-z0-9_-]{1,80}$/

/** Validate a settings patch; unknown or malformed fields keep the current value. */
export function parsePetSettings(raw: unknown, base: PetSettings = DEFAULT_PET_SETTINGS): PetSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const f = r.follow && typeof r.follow === 'object' ? (r.follow as Record<string, unknown>) : undefined
  let follow = base.follow
  if (f?.kind === 'team') follow = { kind: 'team' }
  else if ((f?.kind === 'project' || f?.kind === 'agent') && typeof f.id === 'string' && ID.test(f.id)) follow = { kind: f.kind, id: f.id }
  const bool = (k: keyof PetSettings, d: boolean): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : d)
  return {
    enabled: bool('enabled', base.enabled),
    follow,
    bridge: bool('bridge', base.bridge),
    bubbles: bool('bubbles', base.bubbles),
    overlay: bool('overlay', base.overlay),
    locale: isLocale(r.locale) ? r.locale : base.locale,
  }
}

/** Synodica's own pet settings (data/pet-settings.json). The pet's size, display and packs live in its own config. */
export class PetSettingsStore {
  private readonly file: string
  private current: PetSettings

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'pet-settings.json')
    let raw: unknown
    try {
      raw = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : undefined
    } catch {
      raw = undefined
    }
    this.current = parsePetSettings(raw)
  }

  get(): PetSettings {
    return { ...this.current, follow: { ...this.current.follow } }
  }

  update(patch: unknown): PetSettings {
    this.current = parsePetSettings(patch, this.current)
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.current, null, 2))
    renameSync(tmp, this.file)
    return this.get()
  }
}

/** Which employees the pet follows. */
export function followedAgents(snap: Pick<ActivitySnapshot, 'agents' | 'projects' | 'activity'>, follow: PetFollow): Set<string> {
  if (follow.kind === 'agent') return new Set(snap.agents.some((a) => a.id === follow.id) ? [follow.id] : [])
  if (follow.kind === 'project') {
    const p = snap.projects.find((x) => x.id === follow.id)
    const ids = new Set<string>()
    for (const a of snap.activity) if (a.projectId === follow.id) ids.add(a.agentId)
    for (const t of p?.tasks ?? []) {
      ids.add(t.ownerId)
      if (t.reviewerId) ids.add(t.reviewerId)
    }
    return ids
  }
  return new Set(snap.agents.map((a) => a.id))
}

/**
 * One employee's real activity as an upstream pose tier. Only real events count: a reply that was
 * not an accepted task is "result", never a celebration; a stopped or interrupted turn is not
 * success; a provider failure or an offline provider is "error".
 */
export function tierOf(state: AgentActivityState): PetWorkState | null {
  switch (state) {
    case 'thinking':
      return 'thinking'
    case 'tool':
      return 'working'
    case 'waiting-approval':
    case 'waiting-user':
    case 'interrupted':
      return 'waiting'
    case 'error':
    case 'offline':
      return 'error'
    case 'replied':
      return 'result'
    case 'done':
      return 'success'
    default:
      // idle, queued, waiting-dependency: nothing is happening for the pet to show.
      return null
  }
}

function clip(text: string): string {
  const cps = [...text]
  return cps.length <= PET_TASK_MAX ? text : `${cps.slice(0, PET_TASK_MAX - 1).join('')}.`
}

/** The pet's work status for the followed employees: the most urgent tier wins (upstream's own order). */
export function workStatusFor(snap: Pick<ActivitySnapshot, 'agents' | 'projects' | 'activity'>, follow: PetFollow): { state: PetWorkState | null; task: string | null; agentId?: string } {
  const ids = followedAgents(snap, follow)
  let best: { state: PetWorkState; task: string; agentId: string } | undefined
  for (const a of snap.activity) {
    if (!ids.has(a.agentId)) continue
    const tier = tierOf(a.state)
    if (!tier) continue
    if (best && PRIORITY.indexOf(best.state) <= PRIORITY.indexOf(tier)) continue
    const name = snap.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId
    // Safe, bounded text only: a name, a task id or the activity's already-sanitized detail.
    best = { state: tier, task: clip(`${name}${a.taskRef ? ` ${a.taskRef}` : a.detail ? ` ${a.detail}` : ''}`), agentId: a.agentId }
  }
  return best ? { state: best.state, task: best.task, agentId: best.agentId } : { state: null, task: null }
}

/** Speech bubbles for real transitions between two snapshots: accepted / failed tasks, new approvals. */
export function bubblesFor(prev: Pick<ActivitySnapshot, 'projects' | 'approvals' | 'agents'> | undefined, next: Pick<ActivitySnapshot, 'projects' | 'approvals' | 'agents' | 'activity'>, follow: PetFollow, locale: Locale): string[] {
  if (!prev) return []
  const ids = followedAgents(next, follow)
  const t = (key: MessageKey, vars: Record<string, string>) => translate(locale, key, vars)
  const out: string[] = []
  const before = new Map<string, string>()
  for (const p of prev.projects) for (const task of p.tasks) before.set(`${p.id}/${task.id}`, task.state)
  for (const p of next.projects) {
    if (follow.kind === 'project' && p.id !== follow.id) continue
    for (const task of p.tasks) {
      const was = before.get(`${p.id}/${task.id}`)
      if (!was || was === task.state) continue
      if (follow.kind === 'agent' && task.ownerId !== follow.id) continue
      if (task.state === 'accepted') out.push(t('pet.say.accepted', { task: task.id }))
      else if (task.state === 'failed' || task.state === 'blocked') out.push(t('pet.say.failed', { task: task.id, state: translate(locale, `task.state.${task.state}` as MessageKey) }))
    }
  }
  const seen = new Set(prev.approvals.map((a) => a.id))
  for (const a of next.approvals) {
    if (seen.has(a.id) || !ids.has(a.agentId)) continue
    out.push(t('pet.say.waiting', { name: next.agents.find((x) => x.id === a.agentId)?.name ?? a.agentId }))
  }
  return out.slice(0, 3)
}

/** Our right-click menu items on the pet (upstream third-party menu API) and what each opens. */
export const PET_MENU_OWNER = 'OpenGrokBot'
export const PET_MENU_KEYS = ['pet.menu.openTask', 'pet.menu.openApprovals', 'pet.menu.openOffice', 'pet.menu.followNext'] as const

/** The app link (#/...) a pet menu click opens, from the current real state. Undefined = nothing to open. */
export function menuTarget(key: (typeof PET_MENU_KEYS)[number], snap: Pick<ActivitySnapshot, 'projects' | 'approvals' | 'activity' | 'agents'>, follow: PetFollow): string | undefined {
  const ids = followedAgents(snap, follow)
  if (key === 'pet.menu.openApprovals') {
    const a = snap.approvals.find((x) => ids.has(x.agentId)) ?? snap.approvals[0]
    return a ? `#/approval/${encodeURIComponent(a.id)}` : undefined
  }
  if (key === 'pet.menu.openOffice') return follow.kind === 'project' ? `#/office/${encodeURIComponent(follow.id)}` : '#/office'
  if (key === 'pet.menu.openTask') {
    const live = snap.activity.find((a) => ids.has(a.agentId) && a.conversationId && tierOf(a.state) !== null)
    if (live?.conversationId) return `#/chat/${encodeURIComponent(live.conversationId)}`
    const p = follow.kind === 'project' ? snap.projects.find((x) => x.id === follow.id) : snap.projects.find((x) => !x.archived)
    return p ? `#/chat/${encodeURIComponent(p.conversationId)}` : undefined
  }
  return undefined
}

/** The next follow target in a stable cycle: team, then each open project, then each employee. */
export function nextFollow(snap: Pick<ActivitySnapshot, 'projects' | 'agents'>, follow: PetFollow): PetFollow {
  const order: PetFollow[] = [{ kind: 'team' }, ...snap.projects.filter((p) => !p.archived).map((p) => ({ kind: 'project' as const, id: p.id })), ...snap.agents.map((a) => ({ kind: 'agent' as const, id: a.id }))]
  const i = order.findIndex((f) => f.kind === follow.kind && (f.kind === 'team' || (follow.kind !== 'team' && f.id === follow.id)))
  return order[(i + 1) % order.length] ?? { kind: 'team' }
}

export interface PetBridgeDeps {
  /** `instance` identifies one running host; a restart (new instance) invalidates everything published. */
  runtime: Pick<PetRuntime, 'isRunning' | 'call'> & { instance?: () => string | undefined }
  snapshot: () => ActivitySnapshot
  settings: () => PetSettings
  setFollow: (f: PetFollow) => void
  /** Open an app link in the app (SSE event to pages, focus in the desktop app). */
  navigate: (hash: string) => void
  /** Extra items on the pet's right-click menu (e.g. the usage dashboard): an app link to open and/or a line to say (built at click time when a function). */
  extraMenu?: () => PetMenuExtra[]
}

export interface PetMenuExtra {
  label: string
  hash?: string
  say?: string | (() => string)
}

/** What the bridge believes the upstream host shows: a work-status key, "cleared", or nothing known. */
const CLEARED = 'cleared'

/**
 * Pushes real Synodica activity into the upstream pet through its documented host APIs
 * (work-status, broadcast, third-party menu items) and turns pet menu clicks into app links.
 * Everything it remembers about what was published belongs to one running host instance: a stopped
 * or restarted host starts from nothing, so the current pose and menu are always sent again.
 */
export class PetBridge {
  private last: ActivitySnapshot | undefined
  private published = ''
  private menuLabels = ''
  private polling = false
  private stopped = false
  private instance: string | undefined
  /** Serializes syncs so two overlapping calls never publish out of order. */
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: PetBridgeDeps) {}

  /** Forget everything published (the host stopped, restarted or was replaced). */
  invalidate(): void {
    this.published = ''
    this.menuLabels = ''
    this.last = undefined
    this.instance = undefined
  }

  /** Re-publish the pet state from the current snapshot (call on activity / project / approval changes). */
  sync(): Promise<void> {
    const run = this.chain.then(() => this.syncNow())
    this.chain = run.catch(() => undefined)
    return run
  }

  private async syncNow(): Promise<void> {
    if (!this.deps.runtime.isRunning()) {
      this.invalidate()
      return
    }
    const instance = this.deps.runtime.instance?.()
    if (instance !== this.instance) {
      this.invalidate()
      this.instance = instance
    }
    const s = this.deps.settings()
    const snap = this.deps.snapshot()
    await this.ensureMenu(s.locale)
    // With the bridge off, the pet must not keep a pose from earlier activity: clear it explicitly once.
    const ws = s.bridge ? workStatusFor(snap, s.follow) : { state: null, task: null }
    const key = ws.state ? `${ws.state}|${ws.task}` : CLEARED
    if (key !== this.published) {
      const r = ws.state ? await this.deps.runtime.call('POST', '/dsh-pet-7340/work-status', { state: ws.state, task: ws.task }) : await this.deps.runtime.call('DELETE', '/dsh-pet-7340/work-status')
      // Remembered only after the host accepted it, so a failed call is retried on the next sync.
      if (r.status >= 200 && r.status < 300) this.published = key
    }
    if (s.bubbles) {
      const lines = bubblesFor(this.last, snap, s.follow, s.locale)
      if (lines.length) await this.say(lines.join('\n'))
    }
    this.last = snap
  }

  /** A short line on the pet (e.g. a low-quota notice), in its own bubble. */
  async notice(text: string): Promise<void> {
    if (!this.deps.runtime.isRunning() || !text.trim()) return
    await this.say(text.slice(0, 200))
  }

  private async say(text: string): Promise<void> {
    const cfg = await this.deps.runtime.call('GET', '/dsh-pet-7340/config')
    for (const id of petIds(cfg.json)) {
      await this.deps.runtime.call('POST', `/dsh-pet-7340/broadcast?pet=${encodeURIComponent(id)}&surface=any`, { text, duration: 8000 })
    }
  }

  private async ensureMenu(locale: Locale): Promise<void> {
    const labels = [...PET_MENU_KEYS.map((k) => translate(locale, k)), ...this.extras().map((x) => x.label)]
    const key = labels.join('|')
    if (key !== this.menuLabels) {
      const r = await this.deps.runtime.call('POST', '/dsh-pet-7340/menu/item', { owner: PET_MENU_OWNER, labels })
      if ((r.json as { ok?: boolean } | null)?.ok) this.menuLabels = key
    }
    if (!this.polling) void this.poll()
  }

  /** Long-poll our menu clicks (read-and-consume, upstream semantics) while the runtime runs. */
  private async poll(): Promise<void> {
    this.polling = true
    try {
      while (!this.stopped && this.deps.runtime.isRunning()) {
        let r: { status: number; json: unknown }
        try {
          r = await this.deps.runtime.call('GET', `/dsh-pet-7340/menu/events?owner=${encodeURIComponent(PET_MENU_OWNER)}&wait=10000`)
        } catch {
          break
        }
        const j = r.json as { ok?: boolean; events?: Record<string, string | null> } | null
        if (!j?.ok) {
          this.menuLabels = ''
          break
        }
        this.handleClicks(j.events ?? {})
      }
    } finally {
      this.polling = false
    }
  }

  /** Apply clicked menu labels (exported behaviour for tests through the public method). */
  handleClicks(events: Record<string, string | null>): string[] {
    const s = this.deps.settings()
    const opened: string[] = []
    for (const key of PET_MENU_KEYS) {
      const label = translate(s.locale, key)
      if (!events[label]) continue
      if (key === 'pet.menu.followNext') {
        this.deps.setFollow(nextFollow(this.deps.snapshot(), s.follow))
        this.published = ''
        continue
      }
      const hash = menuTarget(key, this.deps.snapshot(), s.follow)
      if (hash) {
        this.deps.navigate(hash)
        opened.push(hash)
      }
    }
    for (const item of this.extras()) {
      if (!events[item.label]) continue
      if (item.hash) {
        this.deps.navigate(item.hash)
        opened.push(item.hash)
      }
      if (item.say) {
        let text = ''
        try {
          text = typeof item.say === 'function' ? item.say() : item.say
        } catch {
          text = ''
        }
        if (text.trim()) void this.say(text.slice(0, 400)).catch(() => {})
      }
    }
    return opened
  }

  /** Validated extra items: upstream accepts at most 20 labels of 1-32 characters without control characters. */
  private extras(): PetMenuExtra[] {
    const own = new Set(PET_MENU_KEYS.map((k) => translate(this.deps.settings().locale, k)))
    const out: PetMenuExtra[] = []
    // eslint-disable-next-line no-control-regex
    for (const x of this.deps.extraMenu?.() ?? []) if (x.label.trim() && x.label.length <= 32 && !/[\u0000-\u001f\u007f]/.test(x.label) && !own.has(x.label) && !out.some((y) => y.label === x.label)) out.push(x)
    return out.slice(0, 20 - PET_MENU_KEYS.length)
  }

  stop(): void {
    this.stopped = true
  }
}

/** Pet instance ids from the upstream merged config ({ main: { pets: [...] }, <pack>: {...} }). */
export function petIds(cfg: unknown): string[] {
  const out: string[] = []
  if (!cfg || typeof cfg !== 'object') return out
  for (const entry of Object.values(cfg as Record<string, unknown>)) {
    const pets = entry && typeof entry === 'object' ? (entry as { pets?: unknown }).pets : undefined
    if (!Array.isArray(pets)) continue
    for (const p of pets) {
      const id = p && typeof p === 'object' ? (p as { id?: unknown; display?: unknown }).id : undefined
      const display = p && typeof p === 'object' ? (p as { display?: unknown }).display : undefined
      if (typeof id === 'string' && display !== 'none') out.push(id)
    }
  }
  return out
}
