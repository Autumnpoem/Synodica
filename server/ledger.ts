import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { bucketOf, LEDGER_TIMELINE, localDay, startOfLocalDay } from '../shared/presence.js'
import type { AgentActivityState, AgentLedgerDay, LedgerBucket } from '../shared/types.js'

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
    return t
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
}

const BUCKETS: LedgerBucket[] = ['working', 'waiting', 'idle', 'problem']
const SAVE_DEBOUNCE_MS = 2000

interface SavedFile {
  version: 1
  /** Last time the open segments were known to be running. */
  savedAt: number
  days: AgentLedgerDay[]
}

/**
 * Today's observed time per employee, from timestamped state transitions. Bounded: one day per
 * employee and at most LEDGER_TIMELINE transitions. Persisted to `data/activity-ledger.json`
 * (debounced, plus a checkpoint each minute while the server runs).
 *
 * Restart: the segment running at the last checkpoint is closed at that checkpoint, so the time the
 * server was down (and at most one checkpoint interval before it) is a gap, not invented work or
 * idle time. Day rollover: at local midnight a new day starts; the running segment continues from
 * midnight. Earlier days are not kept.
 */
export class ActivityLedger {
  private readonly days = new Map<string, AgentLedgerDay>()
  private saveTimer: unknown = null
  private checkpointTimer: unknown = null

  constructor(
    private readonly file: string | undefined,
    private readonly clock: Clock = realClock,
  ) {
    if (file) this.load(file)
  }

  /** Record that an employee is now in `state` (called on every emitted activity change). */
  transition(agentId: string, state: AgentActivityState, at = this.clock.now()): AgentLedgerDay {
    const day = this.today(agentId, at)
    if (day.open && day.open.state === state) return clone(day)
    if (day.open && at > day.open.since) day.totals[day.open.bucket] += at - day.open.since
    day.open = { bucket: bucketOf(state), since: at, state }
    day.timeline.push({ at, state })
    if (day.timeline.length > LEDGER_TIMELINE) day.timeline.splice(0, day.timeline.length - LEDGER_TIMELINE)
    this.saveSoon()
    return clone(day)
  }

  get(agentId: string, now = this.clock.now()): AgentLedgerDay | undefined {
    const day = this.days.get(agentId)
    if (!day) return undefined
    return clone(this.today(agentId, now))
  }

  list(agentIds: string[], now = this.clock.now()): AgentLedgerDay[] {
    return agentIds.map((id) => this.get(id, now)).filter((d): d is AgentLedgerDay => d !== undefined)
  }

  /** Drop employees who left the team. */
  retain(agentIds: string[]): void {
    for (const id of [...this.days.keys()]) if (!agentIds.includes(id)) this.days.delete(id)
  }

  /** Persist now with `savedAt = now`. Called by the minute timer and tests. */
  checkpoint(now = this.clock.now()): void {
    if (!this.file) return
    const data: SavedFile = { version: 1, savedAt: now, days: [...this.days.keys()].map((id) => this.today(id, now)) }
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(data))
    renameSync(tmp, this.file)
  }

  /** Checkpoint every minute while running (unref'd; stops with the process). */
  startCheckpoints(intervalMs = 60_000): void {
    if (this.checkpointTimer !== null) return
    const tick = (): void => {
      this.checkpointTimer = this.clock.setTimeout(tick, intervalMs)
      try {
        this.checkpoint()
      } catch (err) {
        console.warn('[activity] could not save the ledger:', err instanceof Error ? err.message : err)
      }
    }
    this.checkpointTimer = this.clock.setTimeout(tick, intervalMs)
  }

  stop(): void {
    if (this.checkpointTimer !== null) this.clock.clearTimeout(this.checkpointTimer)
    if (this.saveTimer !== null) this.clock.clearTimeout(this.saveTimer)
    this.checkpointTimer = null
    this.saveTimer = null
  }

  private today(agentId: string, now: number): AgentLedgerDay {
    const key = localDay(now)
    let day = this.days.get(agentId)
    if (!day || day.day !== key) {
      const midnight = startOfLocalDay(now)
      const carried = day?.open ? { bucket: day.open.bucket, since: midnight, state: day.open.state } : undefined
      day = { agentId, day: key, totals: { working: 0, waiting: 0, idle: 0, problem: 0 }, observedFrom: carried ? midnight : now, ...(carried ? { open: carried } : {}), timeline: carried ? [{ at: midnight, state: carried.state }] : [] }
      this.days.set(agentId, day)
    }
    return day
  }

  private saveSoon(): void {
    if (!this.file || this.saveTimer !== null) return
    this.saveTimer = this.clock.setTimeout(() => {
      this.saveTimer = null
      try {
        this.checkpoint()
      } catch (err) {
        console.warn('[activity] could not save the ledger:', err instanceof Error ? err.message : err)
      }
    }, SAVE_DEBOUNCE_MS)
  }

  private load(file: string): void {
    if (!existsSync(file)) return
    let data: SavedFile
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as SavedFile
    } catch {
      return
    }
    if (!data || data.version !== 1 || !Array.isArray(data.days) || typeof data.savedAt !== 'number') return
    const today = localDay(this.clock.now())
    for (const d of data.days) {
      if (!d || typeof d.agentId !== 'string' || d.day !== today || typeof d.totals !== 'object') continue
      const totals = { working: 0, waiting: 0, idle: 0, problem: 0 }
      for (const b of BUCKETS) totals[b] = typeof d.totals[b] === 'number' && d.totals[b] >= 0 ? d.totals[b] : 0
      // The running segment ends at the last checkpoint: the downtime is not counted.
      if (d.open && typeof d.open.since === 'number' && BUCKETS.includes(d.open.bucket) && data.savedAt > d.open.since) totals[d.open.bucket] += data.savedAt - d.open.since
      const timeline = Array.isArray(d.timeline) ? d.timeline.filter((e) => e && typeof e.at === 'number' && typeof e.state === 'string').slice(-(LEDGER_TIMELINE - 1)) : []
      timeline.push({ at: data.savedAt, state: 'unknown' })
      this.days.set(d.agentId, { agentId: d.agentId, day: today, totals, observedFrom: typeof d.observedFrom === 'number' ? d.observedFrom : data.savedAt, timeline })
    }
  }
}

function clone(d: AgentLedgerDay): AgentLedgerDay {
  return { ...d, totals: { ...d.totals }, ...(d.open ? { open: { ...d.open } } : {}), timeline: d.timeline.map((e) => ({ ...e })) }
}
