import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Approvals } from './approvals.js'
import type { Orchestrator } from './orchestrator.js'
import type { ProjectStore } from './projects.js'
import type { Workflow } from './workflow.js'
import type { CorrectionMode, CorrectionRecord, Message } from '../shared/types.js'

const KEEP = 200
/** After this long without the old turn returning, the record says which turn has not confirmed cancellation. */
export const STALL_NOTICE_MS = 4000

/**
 * Durable log of interrupt-and-correct records (data/corrections.json, atomic writes). A correction
 * is written here before anything is aborted, so a disconnect or restart never loses it; on load,
 * anything not yet applied becomes `pending-restart` and is never replayed automatically.
 */
export class CorrectionLog {
  private readonly file: string
  private records: CorrectionRecord[] = []
  readonly recovered: CorrectionRecord[] = []

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'corrections.json')
    if (existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
        this.records = Array.isArray(raw) ? (raw as CorrectionRecord[]).filter((r) => r && typeof r.id === 'string' && typeof r.text === 'string') : []
      } catch (err) {
        console.warn('[corrections] unreadable log, starting empty:', err instanceof Error ? err.message : err)
      }
    }
    for (const r of this.records) {
      if (r.status !== 'stopping' && r.status !== 'stopped') continue
      r.status = 'pending-restart'
      r.detail = 'The server restarted before this correction was applied. Nothing old was re-run; Resume (projects) or Continue (chats) proceeds with it.'
      r.updatedAt = Date.now()
      this.recovered.push(r)
    }
    if (this.recovered.length) this.flush()
  }

  list(): CorrectionRecord[] {
    return [...this.records]
  }

  get(id: string): CorrectionRecord | undefined {
    return this.records.find((r) => r.id === id)
  }

  /** The latest correction in a conversation. */
  latest(conversationId: string): CorrectionRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) if (this.records[i]?.conversationId === conversationId) return this.records[i]
    return undefined
  }

  add(r: CorrectionRecord): void {
    this.records.push(r)
    if (this.records.length > KEEP) this.records = this.records.slice(-KEEP)
    this.flush()
  }

  update(id: string, patch: Partial<CorrectionRecord>): CorrectionRecord | undefined {
    const r = this.records.find((x) => x.id === id)
    if (!r) return undefined
    Object.assign(r, patch, { updatedAt: Date.now() })
    this.flush()
    return r
  }

  private flush(): void {
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(this.records, null, 2))
    renameSync(tmp, this.file)
  }
}

export interface CorrectorDeps {
  log: CorrectionLog
  orchestrator: Pick<Orchestrator, 'record' | 'postNote' | 'interrupt' | 'isBusy' | 'waitForIdle' | 'replyTo'>
  workflow: Pick<Workflow, 'isRunning' | 'beginCorrection' | 'quiesce' | 'finishCorrection' | 'markCorrectionStopped'>
  projects: Pick<ProjectStore, 'byConversation'>
  approvals: Pick<Approvals, 'invalidate'>
  emit: (r: CorrectionRecord) => void
  /** Timer for the "has not confirmed cancellation" notice (tests pass a fake). */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
}

const CHAT_NOTE = 'The boss interrupted the previous reply to correct it. Their latest message is a correction: it overrides the earlier instruction where they conflict. Continue the work with the corrected intent; keep files and history that are still right.'

/**
 * Interrupt and correct, shared by ordinary chats and project workflows:
 * 1. persist the correction and the owner's message, acknowledge at once (status stopping / stopped);
 * 2. bump the instruction revision, drop queued speakers and dispatch, abort the provider turn,
 *    deny pending approvals in that conversation as stale;
 * 3. wait until the old run really returned and released its writer lock (no claim of instant
 *    cancellation: the record stays `stopping` with a truthful detail while a provider ignores it);
 * 4. apply: the project continues (or waits for Resume / Kickoff on a scope change); a chat starts
 *    a fresh round on the correction. Corrections in one conversation apply in arrival order.
 */
export class Corrector {
  private readonly chains = new Map<string, Promise<void>>()
  private readonly settled = new Map<string, Promise<CorrectionRecord>>()

  constructor(private readonly deps: CorrectorDeps) {}

  correct(conversationId: string, text: string, opts: { mode?: CorrectionMode } = {}): CorrectionRecord {
    const body = text.trim()
    if (!body) throw new Error('write the correction')
    const mode: CorrectionMode = opts.mode === 'replan' ? 'replan' : 'continue'
    const project = this.deps.projects.byConversation(conversationId)
    const id = `cor-${randomUUID().slice(0, 12)}`
    const now = Date.now()
    const message: Message = this.deps.orchestrator.record(conversationId, body, { correctionId: id })
    const chatBusy = this.deps.orchestrator.isBusy(conversationId)
    const record: CorrectionRecord = { id, conversationId, ...(project ? { projectId: project.id } : {}), text: body, mode, status: 'stopping', revision: 0, wasRunning: chatBusy, messageId: message.id, createdAt: now, updatedAt: now }
    this.deps.log.add(record)
    let wasRunning = chatBusy
    if (project && !project.archived) {
      const begun = this.deps.workflow.beginCorrection(project.id, { id, text: body, mode })
      wasRunning = wasRunning || begun.wasRunning
      this.deps.log.update(id, { revision: begun.revision, wasRunning, ...(begun.interrupted ? { interrupted: begun.interrupted } : {}) })
    }
    this.deps.orchestrator.interrupt(conversationId)
    this.deps.approvals.invalidate(conversationId, 'A correction superseded the run that asked for this approval.')
    const ack = this.deps.log.update(id, wasRunning ? { status: 'stopping', detail: 'Stopping the current work.' } : { status: 'stopped', detail: 'Nothing was running.' }) ?? record
    this.deps.emit(ack)
    this.deps.orchestrator.postNote(conversationId, wasRunning ? 'Correction received. Stopping the current work; it continues with your correction once the old step has really stopped.' : 'Correction received. Nothing was running; continuing with it.')

    const prev = this.chains.get(conversationId) ?? Promise.resolve()
    const done = prev.then(() => this.apply(id))
    const tail = done.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(conversationId, tail)
    void tail.then(() => {
      if (this.chains.get(conversationId) === tail) this.chains.delete(conversationId)
    })
    this.settled.set(id, done)
    return ack
  }

  /** Resolves when the correction was applied (tests, scripts). */
  done(id: string): Promise<CorrectionRecord | undefined> {
    return this.settled.get(id) ?? Promise.resolve(this.deps.log.get(id))
  }

  private async apply(id: string): Promise<CorrectionRecord> {
    const r = this.deps.log.get(id)
    if (!r) throw new Error(`unknown correction ${id}`)
    const setTimer = this.deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    const clearTimer = this.deps.clearTimer ?? ((h: unknown) => clearTimeout(h as NodeJS.Timeout))
    const stall = setTimer(() => {
      const cur = this.deps.log.get(id)
      if (cur?.status !== 'stopping') return
      const what = cur.interrupted ? `${cur.interrupted} ` : ''
      const u = this.deps.log.update(id, { detail: `Still stopping: the provider running ${what}has not confirmed cancellation yet. Nothing new starts until it returns.` })
      if (u) this.deps.emit(u)
    }, STALL_NOTICE_MS)
    try {
      // Both the chat round and the workflow step must have returned (and released their locks).
      await this.deps.orchestrator.waitForIdle(r.conversationId)
      if (r.projectId) await this.deps.workflow.quiesce(r.projectId)
    } finally {
      clearTimer(stall)
    }
    if (r.projectId) this.deps.workflow.markCorrectionStopped(r.projectId, id)
    const stopped = this.deps.log.update(id, { status: 'stopped', detail: 'Stopped. The old step relinquished its turn and locks.' })
    if (stopped) this.deps.emit(stopped)

    const latest = this.deps.log.latest(r.conversationId)
    const newer = latest !== undefined && latest.id !== id && latest.createdAt >= r.createdAt
    if (r.projectId) {
      const p = this.deps.workflow.finishCorrection(r.projectId, id)
      const status = p.corrections?.find((c) => c.id === id)?.status ?? 'applied'
      const out = this.deps.log.update(id, { status: status === 'superseded' ? 'superseded' : 'applied', detail: status === 'superseded' ? 'A newer correction carries this one.' : r.mode === 'replan' ? 'Applied. Waiting for your Resume or Kickoff (scope change).' : 'Applied. Work continues with the correction.' })
      if (out) this.deps.emit(out)
      // A project chat where no workflow step was running (a discussion): the employees answer the correction.
      if (status !== 'superseded' && !r.interrupted && r.wasRunning) this.replay(r)
      return out ?? r
    }
    if (newer) {
      const out = this.deps.log.update(id, { status: 'superseded', detail: 'A newer correction carries this one.' })
      if (out) this.deps.emit(out)
      return out ?? r
    }
    this.replay(r)
    const out = this.deps.log.update(id, { status: 'applied', detail: 'Applied. A new round answers the correction.' })
    if (out) this.deps.emit(out)
    return out ?? r
  }

  /** Continue a chat after a restart left a correction pending (explicit owner action). */
  resume(id: string): CorrectionRecord {
    const r = this.deps.log.get(id)
    if (!r) throw new Error('unknown correction')
    if (r.status !== 'pending-restart') throw new Error(`this correction is ${r.status}`)
    if (r.projectId) throw new Error('project corrections continue with Resume on the board')
    this.replay(r)
    const out = this.deps.log.update(id, { status: 'applied', detail: 'Applied after the restart, on your request.' }) ?? r
    this.deps.emit(out)
    return out
  }

  private replay(r: CorrectionRecord): void {
    const message: Message = { id: r.messageId ?? r.id, conversationId: r.conversationId, authorId: 'user', text: r.text, createdAt: r.createdAt, status: 'done', correctionId: r.id }
    this.deps.orchestrator.replyTo(r.conversationId, message, CHAT_NOTE)
  }
}
