import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { parseCritique, parseDecision, parseHandoff, parseObjections, parsePlan, parseReview, parseTaskOps, type DecisionBlock, type Parsed, type PlanBlock } from './handoff.js'
import { canWrite, WorkspaceLocks, type LockHolder } from './locks.js'
import { canonicalPath, isInside } from './paths.js'
import type { ProjectStore } from './projects.js'
import { enforcesReadOnly } from './providers/types.js'
import { PROVIDER_CAPABILITIES } from '../shared/catalog.js'
import type { Agent, CorrectionMode, DiscussionRound, PlanObjection, Project, ProjectPlanTask, ProviderKind, RunKind, Task, TaskKind, TaskRun, TaskTier, Team, VerificationGate } from '../shared/types.js'

export { canWrite } from './locks.js'

/** One workflow turn handed to a provider adapter. */
export interface TurnRequest {
  project: Project
  agent: Agent
  /** Task id, or PLAN / CRITIQUE / FINAL. */
  ref: string
  kind: RunKind
  /** The step instruction for this turn. */
  note: string
  /** Shared project context for the system prompt. */
  context: string
  signal: AbortSignal
  /** Reviews use their own provider session, so a reviewer never continues another thread of work. */
  sessionScope: 'work' | 'review'
  /** The project workspace. */
  cwd: string
  /**
   * Plan, critique, decision and review steps run read-only: no write, edit or shell tools. Only
   * implementation work (`work`) may change files, and only while holding the workspace lock.
   */
  readOnly: boolean
}

export interface TurnOutcome {
  text: string
  error?: string
  messageId?: string
  activity: string[]
  /** The turn was aborted but the provider still replied; the chat keeps it marked superseded and `text` is ''. */
  superseded?: boolean
}

export type TurnRunner = (req: TurnRequest) => Promise<TurnOutcome>

export interface WorkflowDeps {
  getTeam: () => Team
  projects: ProjectStore
  runTurn: TurnRunner
  /** Members of a project conversation (agent ids). */
  members: (conversationId: string) => string[]
  /** Post a short workflow line into the project conversation. */
  note: (conversationId: string, text: string) => void
  /** A project changed (emit to clients, refresh shared files and activity). */
  changed: (project: Project) => void
  /** Writer locks shared with chat turns. Defaults to a private set (tests). */
  locks?: WorkspaceLocks
}

export class WorkflowError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

const TERMINAL: Task['state'][] = ['accepted', 'cancelled']
const TIER_RANK: Record<TaskTier, number> = { routine: 0, standard: 1, critical: 2 }
const MAX_FINAL_REVIEWS = 2
const READ_KINDS: RunKind[] = ['plan', 'discuss', 'critique', 'decide', 'review', 'final-review']

function roles(agent: Agent): string[] {
  return agent.workflowRoles ?? []
}

/**
 * Whether an employee can run commands (tests, builds) in a project work turn: you granted the Bash
 * tool, and the adapter really provides a shell in project turns (Claude Code, Codex inside its OS
 * sandbox, Gemini CLI). API employees never get one there, whatever their tool list says. Exported for tests.
 */
export function commandAccess(agent: Agent, kind: ProviderKind): { ok: true } | { ok: false; reason: string } {
  if (!PROVIDER_CAPABILITIES[kind]?.projectShell) return { ok: false, reason: `${agent.name} runs on an API provider, which has no shell in project turns` }
  if (!agent.tools.includes('Bash')) return { ok: false, reason: `${agent.name} does not have the Bash tool` }
  return { ok: true }
}

function tierOf(agent: Agent): TaskTier {
  return agent.tier ?? 'standard'
}

function taskNumber(id: string): number {
  return Number(/(\d+)$/.exec(id)?.[1] ?? 0)
}

/**
 * The project workflow: kickoff → analysis/plan → bounded critique → decision → tasks →
 * dependency-ordered implementation → independent review (rejections return for repair, bounded) →
 * final consistency review. State lives in ProjectStore; every transition is persisted before
 * the next provider call, and nothing that was in flight is re-run without an explicit Resume.
 */
export class Workflow {
  /** One provider run per project at a time: prevents duplicate dispatch and same-project overlap. */
  private readonly active = new Map<string, { ref: string; abort: AbortController; runId: string }>()
  /** One writer per real folder tree, shared with chat turns: no overlapping writers anywhere. */
  readonly locks: WorkspaceLocks
  private readonly loops = new Map<string, Promise<void>>()
  /** Projects with a correction in progress: no dispatch until it is applied. Value = pending correction ids. */
  private readonly holds = new Map<string, Set<string>>()

  constructor(private readonly deps: WorkflowDeps) {
    this.locks = deps.locks ?? new WorkspaceLocks()
    // Work that waited for a busy folder is re-checked whenever any writer finishes.
    this.locks.onRelease(() => queueMicrotask(() => this.pumpAll()))
  }

  // ---------- queries ----------

  isRunning(projectId: string): boolean {
    return this.active.has(projectId)
  }

  activeRef(projectId: string): string | undefined {
    return this.active.get(projectId)?.ref
  }

  /** Resolves when the project's background work has settled (tests, shutdown). */
  async settle(projectId: string): Promise<void> {
    // The next step is scheduled in a microtask after each one ends, so require two quiet ticks.
    for (let quiet = 0; quiet < 2; ) {
      const loop = this.loops.get(projectId)
      if (loop) {
        quiet = 0
        await loop
      } else {
        quiet++
        await new Promise((resolve) => setImmediate(resolve))
      }
    }
  }

  // ---------- project lifecycle ----------

  create(input: { id?: string; name: string; workspace: string; conversationId: string; brief?: string; decisionOwnerId?: string; criticId?: string }): Project {
    if (!path.isAbsolute(input.workspace)) throw new WorkflowError('project workspace must be an absolute path')
    const now = Date.now()
    const project: Project = {
      id: input.id ?? `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      name: input.name.trim() || 'Project',
      workspace: path.resolve(input.workspace),
      conversationId: input.conversationId,
      brief: (input.brief ?? '').trim(),
      phase: 'new',
      critiques: [],
      decisions: [],
      tasks: [],
      runs: [],
      paused: false,
      finalReviews: 0,
      nextTaskNumber: 1,
      createdAt: now,
      updatedAt: now,
    }
    const members = this.memberAgents(project)
    const lead = (input.decisionOwnerId ? members.find((a) => a.id === input.decisionOwnerId) : undefined) ?? pickLead(members)
    if (lead) project.decisionOwnerId = lead.id
    const critic = (input.criticId ? members.find((a) => a.id === input.criticId && a.id !== lead?.id) : undefined) ?? pickCritic(members, lead)
    if (critic) project.criticId = critic.id
    this.deps.projects.add(project)
    this.deps.changed(project)
    return project
  }

  update(projectId: string, patch: { name?: string; brief?: string; decisionOwnerId?: string; criticId?: string; finalReviewerId?: string }): Project {
    const p = this.must(projectId)
    const members = this.memberAgents(p)
    if (patch.decisionOwnerId !== undefined && !members.some((a) => a.id === patch.decisionOwnerId)) throw new WorkflowError('the decision owner must be a member of the project chat')
    if (patch.criticId !== undefined && patch.criticId !== '' && !members.some((a) => a.id === patch.criticId)) throw new WorkflowError('the critic must be a member of the project chat')
    if (patch.finalReviewerId) {
      const fr = members.find((a) => a.id === patch.finalReviewerId)
      if (!fr) throw new WorkflowError('the final reviewer must be a member of the project chat')
      const why = this.unsuitableReviewer(fr)
      if (why) throw new WorkflowError(why)
      if (this.authors(p).has(fr.id)) throw new WorkflowError(`${fr.name} implemented tasks in this project, so cannot run the independent final review`)
    }
    const owner = patch.decisionOwnerId ?? p.decisionOwnerId
    const critic = patch.criticId === '' ? undefined : (patch.criticId ?? p.criticId)
    if (owner && critic && owner === critic) throw new WorkflowError('the critic must be someone other than the decision owner')
    return this.save(p.id, (x) => {
      if (patch.name?.trim()) x.name = patch.name.trim()
      if (patch.brief !== undefined) x.brief = patch.brief.trim()
      if (owner) x.decisionOwnerId = owner
      if (critic) x.criticId = critic
      else delete x.criticId
      if (patch.finalReviewerId === '') delete x.finalReviewerId
      else if (patch.finalReviewerId) x.finalReviewerId = patch.finalReviewerId
    })
  }

  /**
   * Your decision on the verification gate, with a required reason: "not-applicable" (nothing to
   * exercise, e.g. a pure research deliverable) or "overridden" (ship without it). Recorded in the
   * project's decisions; a blocked project continues to the final review.
   */
  setVerification(projectId: string, state: 'not-applicable' | 'overridden', reason: string): Project {
    const p = this.must(projectId)
    if (!reason.trim()) throw new WorkflowError('a verification decision needs a reason')
    if (this.active.has(p.id)) throw new WorkflowError('a step is running; wait or Stop it first', 409)
    const updated = this.save(p.id, (x) => {
      x.verification = { state, taskIds: [], reason: reason.trim(), by: 'user', at: Date.now() }
      x.decisions.push({ at: Date.now(), by: 'user', decision: state === 'not-applicable' ? 'User-flow verification is not applicable.' : 'Verification gate overridden.', rationale: reason.trim() })
      if (x.phase === 'needs-attention' && x.pendingStep === 'verification') {
        x.phase = 'executing'
        x.paused = false
        delete x.pendingStep
        delete x.reason
      }
    })
    this.deps.note(p.conversationId, `Verification ${state === 'not-applicable' ? 'marked not applicable' : 'overridden'} by you: ${reason.trim()}`)
    this.pumpSoon(p.id)
    return updated
  }

  /** Start planning from a request. Runs in the background; returns at once. */
  kickoff(projectId: string, request: string): Project {
    const p = this.must(projectId)
    this.assertIdle(p)
    const open = p.tasks.filter((t) => !TERMINAL.includes(t.state))
    // After a scope-changing correction you may re-plan: started tasks are cancelled with a reason (kept on the board, files untouched).
    const replan = p.replanAllowed === true
    if (open.length > 0 && p.phase !== 'plan-ready' && p.phase !== 'needs-attention') throw new WorkflowError(`finish or cancel the ${open.length} open task(s) before a new kickoff`, 409)
    if (!replan && open.some((t) => t.attempts > 0)) throw new WorkflowError('implementation already started; edit tasks on the board instead of re-planning', 409)
    if (!p.decisionOwnerId) throw new WorkflowError('this project has no decision owner; pick one in the project settings')
    const text = request.trim()
    if (!text && !p.brief) throw new WorkflowError('write what the project should deliver')
    const updated = this.save(p.id, (x) => {
      if (text) x.brief = x.brief ? `${x.brief}\n\n${text}` : text
      x.phase = 'planning'
      x.paused = false
      x.pendingStep = 'plan'
      x.planEpoch = (x.planEpoch ?? 0) + 1
      supersedeDiscussion(x)
      delete x.reason
      if (replan) {
        for (const t of x.tasks) {
          // Anything that ever ran (even a refunded, interrupted attempt) may have changed files: keep its record.
          if (TERMINAL.includes(t.state) || (t.attempts === 0 && !x.runs.some((r) => r.ref === t.id))) continue
          t.state = 'cancelled'
          t.reason = 'Superseded by a re-plan after your correction.'
          t.history.push({ at: Date.now(), by: 'user', text: t.reason })
          t.updatedAt = Date.now()
        }
        delete x.replanAllowed
      }
      // Unstarted tasks of a previous plan are replaced by the new one.
      x.tasks = x.tasks.filter((t) => TERMINAL.includes(t.state))
      // A new increment needs its own verification.
      x.verification = { state: 'pending', taskIds: [], since: Date.now() }
    })
    this.background(p.id, () => this.planning(p.id, 'plan'))
    return updated
  }

  /** One more critique round on the current plan, before implementation starts. */
  critique(projectId: string): Project {
    const p = this.must(projectId)
    this.assertIdle(p)
    if (!p.plan) throw new WorkflowError('there is no plan to critique yet; run Kickoff first')
    if (p.tasks.some((t) => t.attempts > 0 && !TERMINAL.includes(t.state))) throw new WorkflowError('implementation already started; critique applies to plans, edit tasks instead', 409)
    if (!p.criticId) throw new WorkflowError('this project has no critic; pick one in the project settings')
    const updated = this.save(p.id, (x) => {
      x.phase = 'planning'
      x.pendingStep = 'critique'
      delete x.reason
    })
    this.background(p.id, () => this.planning(p.id, 'critique', 1))
    return updated
  }

  /** Approve the plan and start (or continue) implementation. */
  start(projectId: string): Project {
    const p = this.must(projectId)
    assertNoUserObjections(p)
    if (p.phase === 'planning') throw new WorkflowError('the plan is still being made', 409)
    if (p.phase === 'needs-attention' && p.pendingStep) return this.resume(projectId)
    if (this.openCount(p) === 0) throw new WorkflowError('there are no open tasks; run Kickoff or add a task')
    const fresh = p.phase === 'plan-ready' || p.phase === 'new' || p.phase === 'done'
    if (fresh) this.assertIdle(p)
    let added: Task | undefined
    const updated = this.save(p.id, (x) => {
      x.paused = false
      x.phase = 'executing'
      delete x.reason
      // A board you filled by hand gets the same verification task a plan would get.
      if (fresh) added = this.ensureVerificationTask(x)
    })
    const untested = fresh && !added && updated.verification?.state === 'pending' && !updated.tasks.some((t) => t.kind === 'test' && t.state !== 'cancelled' && t.createdAt >= (updated.verification?.since ?? 0))
    this.deps.note(p.conversationId, `${fresh ? `Implementation started. ${this.openCount(updated)} task(s) on the board.` : 'Continuing.'}${added ? ` ${added.id} (verify user flows and tests) was added, because the board had no verification task.` : ''}${untested ? ` No verification task was added: ${this.noTesterReason(updated)} The project stops before the final review until verification is satisfied.` : ''}`)
    this.pumpSoon(p.id)
    return updated
  }

  pause(projectId: string): Project {
    const p = this.save(projectId, (x) => {
      x.paused = true
    })
    this.deps.note(p.conversationId, this.active.has(projectId) ? 'Paused. The current step finishes; nothing new starts until you resume.' : 'Paused. Nothing new starts until you resume.')
    return p
  }

  /** Stop the running step now. Its task becomes interrupted and waits for an explicit Resume. */
  stop(projectId: string): Project {
    const p = this.save(projectId, (x) => {
      x.paused = true
    })
    const run = this.active.get(projectId)
    if (run) run.abort.abort()
    return p
  }

  // ---------- interrupt and correct ----------

  /** Whether a correction is being applied (the composer shows Stopping / Stopped from this). */
  isCorrecting(projectId: string): boolean {
    return this.holds.has(projectId)
  }

  /**
   * First half of interrupt-and-correct, synchronous: persist the correction as durable project
   * context with a new instruction revision (older runs are superseded from this moment), hold all
   * dispatch, and abort the running step. Returns what was running.
   */
  beginCorrection(projectId: string, input: { id: string; text: string; mode: CorrectionMode }): { project: Project; interrupted?: string; wasRunning: boolean; revision: number } {
    const p = this.must(projectId)
    const text = input.text.trim()
    if (!text) throw new WorkflowError('write the correction')
    const run = this.active.get(projectId)
    const holds = this.holds.get(projectId) ?? new Set<string>()
    // A second correction before the first was applied targets the same interrupted step.
    const inherited = [...(p.corrections ?? [])].reverse().find((c) => holds.has(c.id) && c.interrupted)?.interrupted
    const interrupted = run?.ref ?? inherited
    holds.add(input.id)
    this.holds.set(projectId, holds)
    let revision = 0
    const updated = this.save(projectId, (x) => {
      x.revision = (x.revision ?? 0) + 1
      revision = x.revision
      x.corrections ??= []
      x.corrections.push({ id: input.id, at: Date.now(), text, mode: input.mode, revision, status: run ? 'stopping' : 'stopped', ...(interrupted ? { interrupted } : {}) })
      if (x.corrections.length > 50) x.corrections = x.corrections.slice(-50)
      x.decisions.push({ at: Date.now(), by: 'user', decision: `Correction: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`, rationale: interrupted ? `Interrupted ${interrupted}; this overrides the earlier instruction.` : 'Overrides the earlier instruction.' })
    })
    run?.abort.abort()
    return { project: updated, ...(interrupted ? { interrupted } : {}), wasRunning: run !== undefined, revision }
  }

  /** Resolves once no step of this project runs any more (its turn returned and its writer lock was released). */
  async quiesce(projectId: string): Promise<void> {
    await this.settle(projectId)
  }

  /**
   * Second half, after the old step relinquished its turn and locks: apply the correction to the work
   * it changes. The interrupted task (if any) gets it as a requirement and goes back to work; accepted
   * work that depends on it is queued for a recheck and a passed verification gate reopens; unrelated
   * accepted work stays. continue = the work goes on now; replan = it waits for your Resume / Kickoff.
   * When a newer correction is still pending, this one only records itself and the newest resumes.
   */
  finishCorrection(projectId: string, correctionId: string): Project {
    const holds = this.holds.get(projectId)
    holds?.delete(correctionId)
    const newerPending = (holds?.size ?? 0) > 0
    const p = this.must(projectId)
    const c = p.corrections?.find((x) => x.id === correctionId)
    if (!c) throw new WorkflowError('unknown correction', 404)
    const names = this.names()
    const touched: string[] = []
    const updated = this.save(projectId, (x) => {
      const rec = x.corrections?.find((y) => y.id === correctionId)
      if (!rec) return
      const task = rec.interrupted ? x.tasks.find((t) => t.id === rec.interrupted) : undefined
      if (task && !TERMINAL.includes(task.state)) {
        task.corrections ??= []
        task.corrections.push({ id: rec.id, at: rec.at, text: rec.text })
        task.history.push({ at: Date.now(), by: 'user', text: `Correction: ${rec.text}` })
        if (['interrupted', 'running', 'reviewing', 'implemented', 'failed'].includes(task.state)) {
          task.state = task.reviews.some((r) => r.verdict === 'reject') ? 'rework' : 'ready'
          delete task.reason
          delete task.resumeTo
          delete task.blockedOn
        }
        task.updatedAt = Date.now()
        touched.push(task.id)
        // Accepted or delivered work built on the corrected task is rechecked, not discarded.
        for (const dep of dependentsOf(x.tasks, task.id)) {
          if (!['accepted', 'implemented', 'reviewing', 'interrupted'].includes(dep.state)) continue
          dep.state = 'waiting'
          delete dep.reason
          delete dep.resumeTo
          dep.history.push({ at: Date.now(), by: 'workflow', text: `Recheck needed: prerequisite ${task.id} was corrected.` })
          dep.updatedAt = Date.now()
          touched.push(dep.id)
        }
        if (x.verification?.state === 'passed') {
          x.verification = { ...x.verification, state: 'pending' }
          delete x.verification.evidence
        }
      }
      rec.status = newerPending ? 'superseded' : 'applied'
      if (newerPending) return
      if (rec.mode === 'replan') {
        x.paused = true
        x.replanAllowed = true
        x.phase = 'needs-attention'
        x.reason = 'Your correction changes the scope. Resume continues the current plan with it, or Kickoff re-plans (started tasks are cancelled, not deleted; their files stay).'
        return
      }
      x.paused = false
      if (x.plan && discussionEnabled(this.deps.getTeam(), this.memberAgents(x)) && (x.phase === 'plan-ready' || x.pendingStep === 'discussion' || x.pendingStep === 'critique')) {
        supersedeDiscussion(x)
        x.phase = 'planning'
        x.pendingStep = 'discussion'
        delete x.reason
      }
      // An interrupted planning or final step re-runs with the correction in its context.
      if (x.phase === 'needs-attention' && x.pendingStep && x.pendingStep !== 'verification') {
        x.phase = x.pendingStep === 'final-review' ? 'final-review' : 'planning'
        delete x.reason
      } else if (x.phase === 'final-review' && touched.length > 0) {
        x.phase = 'executing'
        delete x.pendingStep
      }
      refreshWaiting(x)
    })
    if (newerPending) return updated
    if (holds && holds.size === 0) this.holds.delete(projectId)
    const head = `Correction applied${touched.length ? ` to ${touched.join(', ')}` : ''}.`
    if (c.mode === 'replan') {
      this.deps.note(updated.conversationId, `${head} It changes the scope, so nothing continues by itself: press Resume to continue the plan with it, or Kickoff to re-plan.`)
      return updated
    }
    this.deps.note(updated.conversationId, `${head} Continuing with the corrected instruction${updated.decisionOwnerId ? ` (decision owner: ${names(updated.decisionOwnerId)})` : ''}.`)
    const step = updated.pendingStep
    if (updated.phase === 'planning' && (step === 'plan' || step === 'discussion' || step === 'critique')) this.background(projectId, () => this.planning(projectId, step, step === 'critique' ? 1 : undefined))
    else if (updated.phase === 'final-review') this.background(projectId, () => this.finalReview(projectId))
    else this.pumpSoon(projectId)
    return updated
  }

  /** Mark an in-progress correction stopped once the old step is gone (status only; no work changes). */
  markCorrectionStopped(projectId: string, correctionId: string): void {
    this.save(projectId, (x) => {
      const rec = x.corrections?.find((y) => y.id === correctionId)
      if (rec && rec.status === 'stopping') rec.status = 'stopped'
    })
  }

  /** Resume after pause, stop, failure or restart. Re-runs an interrupted planning step if there is one. */
  resume(projectId: string): Project {
    const p = this.must(projectId)
    this.assertIdle(p)
    let step = p.phase === 'needs-attention' ? p.pendingStep : undefined
    // Tasks added after a failed final review run first; the final review comes when they are accepted.
    if (step === 'final-review' && this.openCount(p) > 0) step = undefined
    // The verification gate is re-checked by the scheduler once every task is settled.
    if (step === 'verification') step = undefined
    if (step !== 'plan' && step !== 'discussion' && step !== 'critique') assertNoUserObjections(p)
    const updated = this.save(p.id, (x) => {
      x.paused = false
      delete x.reason
      if (step === undefined && (x.pendingStep === 'final-review' || x.pendingStep === 'verification')) {
        delete x.pendingStep
        x.phase = 'executing'
      }
      if (step === 'plan' || step === 'discussion' || step === 'critique') x.phase = 'planning'
      else if (step === 'final-review') x.phase = 'final-review'
      else if (x.phase === 'needs-attention') x.phase = x.tasks.length > 0 ? 'executing' : 'new'
    })
    if (step === 'plan' || step === 'discussion' || step === 'critique') this.background(p.id, () => this.planning(p.id, step, step === 'critique' ? 1 : undefined))
    else if (step === 'final-review') this.background(p.id, () => this.finalReview(p.id))
    else this.pumpSoon(p.id)
    return updated
  }

  // ---------- task operations (board actions) ----------

  resolveObjection(projectId: string, id: string, disposition: 'accepted' | 'rejected' | 'unresolved', reason: string): Project {
    const p = this.must(projectId)
    this.assertIdle(p)
    const objection = currentObjections(p).find((o) => o.id === id)
    if (!objection || objection.status !== 'needs-user') throw new WorkflowError('This objection is not waiting for your decision.', 409)
    if (!reason.trim()) throw new WorkflowError('Explain your decision.')
    return this.save(projectId, (x) => {
      objection.status = disposition
      objection.disposition = { by: 'user', at: Date.now(), reason: reason.trim(), revision: x.revision ?? 0 }
      x.decisions.push({ at: Date.now(), by: 'user', decision: `${id}: ${disposition}`, rationale: reason.trim() })
      if (!currentObjections(x).some((o) => o.status === 'needs-user') && x.phase === 'plan-ready') delete x.reason
    })
  }

  createTask(projectId: string, input: { title: string; description?: string; ownerId: string; reviewerId?: string; dependsOn?: string[]; acceptance: string[]; kind?: TaskKind; tier?: TaskTier }, by = 'user'): Task {
    const p = this.must(projectId)
    const title = input.title.trim()
    if (!title) throw new WorkflowError('a task needs a title')
    const acceptance = input.acceptance.map((a) => a.trim()).filter(Boolean)
    if (acceptance.length === 0) throw new WorkflowError('a task needs at least one acceptance criterion')
    this.checkPeople(p, input.ownerId, input.reviewerId)
    const deps = input.dependsOn ?? []
    for (const d of deps) if (!p.tasks.some((t) => t.id === d)) throw new WorkflowError(`unknown dependency ${d}`)
    // The plan being made replaces unstarted tasks when it is decided, so a task added now would vanish.
    if (p.phase === 'planning') throw new WorkflowError('the plan is being made; add tasks once it is ready', 409)
    let created: Task | undefined
    this.save(p.id, (x) => {
      // Adding a task never authorizes execution: the phase (and any pending step) stays as it is,
      // and only an executing, unpaused project picks the task up. New, plan-ready, done, paused and
      // needs-attention projects wait for Start / Resume.
      if (x.phase === 'done') {
        // Work after delivery is a new increment: it needs its own verification and final review.
        x.verification = { state: 'pending', taskIds: [], since: Date.now() }
        x.finalReviews = 0
      }
      created = this.newTask(x, { title, description: input.description?.trim() ?? '', kind: input.kind ?? 'implement', tier: input.tier ?? 'standard', ownerId: input.ownerId, reviewerId: input.reviewerId ?? this.pickReviewer(x, input.ownerId)?.id, dependsOn: deps, acceptance }, by)
      refreshWaiting(x)
    })
    if (p.phase === 'executing' && !p.paused) this.pumpSoon(p.id)
    if (!created) throw new WorkflowError('task was not created', 500)
    return created
  }

  updateTask(projectId: string, taskId: string, patch: { title?: string; description?: string; ownerId?: string; reviewerId?: string; dependsOn?: string[]; acceptance?: string[]; tier?: TaskTier }, by = 'user'): Task {
    const p = this.must(projectId)
    const t = this.mustTask(p, taskId)
    if (this.isTaskActive(p, t)) throw new WorkflowError(`${t.id} is running; stop it before changing it`, 409)
    if (TERMINAL.includes(t.state)) throw new WorkflowError(`${t.id} is ${t.state} and can no longer change`, 409)
    const owner = patch.ownerId ?? t.ownerId
    const reviewer = patch.reviewerId ?? t.reviewerId
    this.checkPeople(p, owner, reviewer)
    if (patch.dependsOn) {
      for (const d of patch.dependsOn) {
        if (d === t.id) throw new WorkflowError('a task cannot depend on itself')
        if (!p.tasks.some((x) => x.id === d)) throw new WorkflowError(`unknown dependency ${d}`)
      }
      if (createsCycle(p.tasks, t.id, patch.dependsOn)) throw new WorkflowError('that dependency would create a cycle')
    }
    if (patch.acceptance && patch.acceptance.filter((a) => a.trim()).length === 0) throw new WorkflowError('a task needs at least one acceptance criterion')
    const names = this.names()
    this.save(p.id, (x) => {
      const task = this.mustTask(x, taskId)
      const changes: string[] = []
      if (patch.title?.trim() && patch.title.trim() !== task.title) {
        task.title = patch.title.trim()
        changes.push('title')
      }
      if (patch.description !== undefined && patch.description.trim() !== task.description) {
        task.description = patch.description.trim()
        changes.push('description')
      }
      if (patch.acceptance) {
        task.acceptance = patch.acceptance.map((a) => a.trim()).filter(Boolean)
        changes.push('acceptance criteria')
      }
      if (patch.dependsOn) {
        task.dependsOn = [...new Set(patch.dependsOn)]
        changes.push('dependencies')
      }
      if (patch.tier) task.tier = patch.tier
      if (owner !== task.ownerId) changes.push(`owner ${names(task.ownerId)} → ${names(owner)}`)
      if (reviewer !== task.reviewerId) changes.push(`reviewer → ${reviewer ? names(reviewer) : 'none'}`)
      task.ownerId = owner
      if (reviewer) task.reviewerId = reviewer
      else delete task.reviewerId
      if (task.state === 'blocked' && task.blockedOn === 'reviewer' && reviewer) {
        task.state = 'implemented'
        delete task.blockedOn
        delete task.reason
      }
      if (changes.length) task.history.push({ at: Date.now(), by, text: `Changed ${changes.join(', ')}.` })
      task.updatedAt = Date.now()
      refreshWaiting(x)
    })
    this.pumpSoon(p.id)
    return this.mustTask(this.must(projectId), taskId)
  }

  cancelTask(projectId: string, taskId: string, reason: string, by = 'user'): Task {
    const p = this.must(projectId)
    const t = this.mustTask(p, taskId)
    if (TERMINAL.includes(t.state)) throw new WorkflowError(`${t.id} is already ${t.state}`, 409)
    if (this.isTaskActive(p, t)) this.active.get(p.id)?.abort.abort()
    this.save(p.id, (x) => {
      const task = this.mustTask(x, taskId)
      task.state = 'cancelled'
      task.reason = reason.trim() || 'Cancelled.'
      delete task.blockedOn
      task.history.push({ at: Date.now(), by, text: `Cancelled: ${task.reason}` })
      task.updatedAt = Date.now()
      refreshWaiting(x)
    })
    this.deps.note(p.conversationId, `${t.id} cancelled: ${reason.trim() || 'no reason given'}`)
    this.pumpSoon(p.id)
    return this.mustTask(this.must(projectId), taskId)
  }

  /** Explicit user action on a failed / blocked / interrupted / paused task. */
  retryTask(projectId: string, taskId: string, by = 'user'): Task {
    const p = this.must(projectId)
    const t = this.mustTask(p, taskId)
    if (this.isTaskActive(p, t)) throw new WorkflowError(`${t.id} is already running`, 409)
    if (!['failed', 'blocked', 'interrupted', 'paused'].includes(t.state)) throw new WorkflowError(`${t.id} is ${t.state}; only failed, blocked, interrupted or paused tasks can be retried`, 409)
    if (t.state === 'blocked' && t.blockedOn === 'dependency') throw new WorkflowError(`${t.id} waits for a cancelled dependency; edit its dependencies or cancel it`, 409)
    const budget = Math.max(1, this.deps.getTeam().settings.maxTaskAttempts ?? 3)
    this.save(p.id, (x) => {
      const task = this.mustTask(x, taskId)
      const to = task.resumeTo ?? 'ready'
      if (task.state === 'failed' && task.attempts >= task.maxAttempts) task.maxAttempts = task.attempts + budget
      task.history.push({ at: Date.now(), by, text: task.state === 'interrupted' ? 'Resumed.' : `Retry requested (${to === 'implemented' ? 'review again' : 'work again'}).` })
      task.state = to === 'implemented' ? 'implemented' : task.reviews.some((r) => r.verdict === 'reject') ? 'rework' : 'ready'
      delete task.reason
      delete task.resumeTo
      delete task.blockedOn
      task.updatedAt = Date.now()
      if (x.phase === 'needs-attention' && !x.pendingStep) x.phase = 'executing'
      x.paused = false
      refreshWaiting(x)
    })
    this.pumpSoon(p.id)
    return this.mustTask(this.must(projectId), taskId)
  }

  /** You decide instead of the reviewer. A reason is required and recorded. */
  overrideTask(projectId: string, taskId: string, verdict: 'accept' | 'reject', reason: string): Task {
    const p = this.must(projectId)
    const t = this.mustTask(p, taskId)
    if (!reason.trim()) throw new WorkflowError('an override needs a reason')
    if (this.isTaskActive(p, t)) throw new WorkflowError(`${t.id} is running; stop it first`, 409)
    if (t.state === 'cancelled') throw new WorkflowError(`${t.id} is cancelled`, 409)
    if (verdict === 'reject' && t.state === 'accepted' && p.tasks.some((x) => x.dependsOn.includes(t.id) && x.attempts > 0)) {
      throw new WorkflowError(`tasks that depend on ${t.id} already started; add a fix task instead`, 409)
    }
    this.save(p.id, (x) => {
      const task = this.mustTask(x, taskId)
      task.reviews.push({ at: Date.now(), reviewerId: 'user', verdict: verdict === 'accept' ? 'approve' : 'reject', findings: verdict === 'reject' ? [reason.trim()] : [], evidence: `Owner override: ${reason.trim()}`, override: true })
      task.history.push({ at: Date.now(), by: 'user', text: `Override: ${verdict === 'accept' ? 'accepted' : 'sent back for rework'} — ${reason.trim()}` })
      if (verdict === 'accept') task.state = 'accepted'
      else {
        task.state = 'rework'
        if (task.attempts >= task.maxAttempts) task.maxAttempts = task.attempts + 1
      }
      delete task.reason
      delete task.blockedOn
      delete task.resumeTo
      task.updatedAt = Date.now()
      if (x.phase === 'needs-attention' && !x.pendingStep) x.phase = 'executing'
      refreshWaiting(x)
    })
    this.deps.note(p.conversationId, `${t.id} ${verdict === 'accept' ? 'accepted' : 'sent back'} by override: ${reason.trim()}`)
    this.pumpSoon(p.id)
    return this.mustTask(this.must(projectId), taskId)
  }

  /** Apply team-task blocks from a chat reply. Only the decision owner may change the board from chat. */
  applyChatOps(conversationId: string, authorId: string, text: string): string[] {
    const p = this.deps.projects.byConversation(conversationId)
    if (!p) return []
    const members = this.memberAgents(p)
    const { ops, errors } = parseTaskOps(text, members)
    if (ops.length === 0 && errors.length === 0) return []
    if (authorId !== p.decisionOwnerId) {
      const msg = `Ignored task changes from ${this.names()(authorId)}: only the decision owner (${this.names()(p.decisionOwnerId ?? '')}) changes the board from chat.`
      this.deps.note(conversationId, msg)
      return [msg]
    }
    const results: string[] = errors.map((e) => `Not applied: ${e}`)
    for (const op of ops) {
      try {
        if (op.op === 'create') {
          const t = this.createTask(p.id, { title: op.title, description: op.description, ownerId: op.owner, ...(op.reviewer ? { reviewerId: op.reviewer } : {}), dependsOn: op.dependsOn, acceptance: op.acceptance, kind: op.kind, tier: op.tier }, authorId)
          results.push(`Created ${t.id}: ${t.title}`)
        } else if (op.op === 'update') {
          const t = this.updateTask(p.id, op.task, { ...(op.title ? { title: op.title } : {}), ...(op.description ? { description: op.description } : {}), ...(op.owner ? { ownerId: op.owner } : {}), ...(op.reviewer ? { reviewerId: op.reviewer } : {}), ...(op.dependsOn ? { dependsOn: op.dependsOn } : {}), ...(op.acceptance ? { acceptance: op.acceptance } : {}) }, authorId)
          results.push(`Updated ${t.id}`)
        } else {
          const t = this.cancelTask(p.id, op.task, op.reason, authorId)
          results.push(`Cancelled ${t.id}`)
        }
      } catch (err) {
        results.push(`Not applied: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    this.deps.note(conversationId, results.join('\n'))
    return results
  }

  /** Re-check every project for dispatchable work (after a writer lock frees, on startup resume…). */
  pumpAll(): void {
    for (const p of this.deps.projects.list()) this.pumpSoon(p.id)
  }

  // ---------- planning ----------

  private async planning(projectId: string, from: 'plan' | 'discussion' | 'critique', rounds?: number): Promise<void> {
    const team = this.deps.getTeam()
    if (from === 'plan') {
      const plan = await this.planStep(projectId)
      if (!plan) return
    }
    if (from !== 'critique' && discussionEnabled(team, this.memberAgents(this.must(projectId)))) {
      if (!await this.discussion(projectId)) return
    }
    const maxRounds = rounds ?? team.settings.maxCritiqueRounds ?? 1
    let decided = false
    for (let round = 0; round < maxRounds; round++) {
      const p = this.must(projectId)
      const critic = p.criticId ? this.agent(p.criticId) : undefined
      if (!critic) {
        this.deps.note(p.conversationId, 'No independent critic in this project; the decision owner will decide after any discussion.')
        break
      }
      this.save(projectId, (x) => {
        x.pendingStep = 'critique'
      })
      const critique = await this.step(projectId, critic, 'CRITIQUE', 'critique', critiqueNote(p, critic, this.names()), (text) => parseCritique(text))
      if (!critique) return
      this.save(projectId, (x) => {
        x.critiques.push({ at: Date.now(), by: critic.id, verdict: critique.verdict, issues: critique.issues })
      })
      if (critique.verdict === 'approve') break
      if (!await this.decide(projectId, critique.issues)) return
      decided = true
    }
    const p = this.must(projectId)
    const unstructured = p.discussions?.find((r) => r.epoch === (p.planEpoch ?? 0) && r.revision === (p.revision ?? 0) && r.status === 'complete')?.participants.some((a) => a.status === 'invalid')
    if (currentObjections(p).some((o) => o.status === 'open') || (!decided && unstructured)) {
      if (!await this.decide(projectId, [])) return
      decided = true
    }
    this.finishPlanning(projectId, decided)
  }

  private async decide(projectId: string, issues: string[]): Promise<boolean> {
    const p = this.must(projectId)
    const lead = this.agent(p.decisionOwnerId ?? '')
    if (!lead) { this.attention(projectId, 'critique', 'The decision owner is no longer on the team; pick a new one and Resume.'); return false }
    const members = this.memberAgents(p)
    const openIds = currentObjections(p).filter((o) => o.status === 'open').map((o) => o.id)
    const decision = await this.step<{ decision: DecisionBlock; plan: PlanBlock | undefined }>(projectId, lead, 'PLAN', 'decide', decideNote(p, issues, this.names(), memberLines(members)), (text) => {
      const d = parseDecision(text, openIds)
      if (!d.ok) return d
      const plan = /```\s*team-plan/i.test(text) ? parsePlan(text, members) : undefined
      if (plan && !plan.ok) return plan
      return { ok: true, value: { decision: d.value, plan: plan?.ok ? plan.value : undefined } }
    })
    if (!decision) return false
    this.save(projectId, (x) => {
      x.decisions.push({ at: Date.now(), by: lead.id, decision: decision.decision.decision, rationale: decision.decision.rationale })
      if (decision.plan) x.plan = { ...decision.plan, by: lead.id, at: Date.now() }
      for (const d of decision.decision.objections ?? []) {
        const o = x.objections?.find((item) => item.id === d.id)
        if (o) { o.status = d.disposition; o.disposition = { by: lead.id, at: Date.now(), reason: d.reason, revision: x.revision ?? 0 } }
      }
    })
    return true
  }

  private async discussion(projectId: string): Promise<boolean> {
    const p = this.must(projectId)
    const epoch = p.planEpoch ?? 0, revision = p.revision ?? 0
    let round = p.discussions?.find((r) => r.epoch === epoch && r.revision === revision && r.status !== 'superseded')
    if (round?.status === 'complete') return true
    if (!round) {
      const cap = this.deps.getTeam().settings.maxDiscussionParticipants ?? 6
      let invited = 0
      round = { id: randomUUID(), epoch, revision, startedAt: Date.now(), status: 'running', participants: this.memberAgents(p).filter((a) => a.id !== p.decisionOwnerId && a.id !== p.criticId).map((a) => {
        const reason = a.muted ? 'Muted in group conversations.' : this.writesInTurn(a, true) ? 'This provider cannot enforce read-only discussion with these tools.' : invited >= cap ? 'Discussion participant limit reached.' : undefined
        if (!reason) invited++
        return { agentId: a.id, status: reason ? 'omitted' : 'pending', ...(reason ? { reason } : {}), objectionIds: [] }
      }) }
      this.save(projectId, (x) => {
        supersedeDiscussion(x)
        x.discussions ??= []
        x.discussions.push(round!)
      })
    }
    const currentRound = round
    this.save(projectId, (x) => { x.pendingStep = 'discussion'; currentRound.status = 'running' })
    for (const person of currentRound.participants) {
      if (person.status !== 'pending' && person.status !== 'stopped') continue
      const current = this.must(projectId)
      if (this.holds.has(projectId) || (current.revision ?? 0) !== revision) return false
      if (current.paused) {
        this.save(projectId, () => { currentRound.status = 'stopped' })
        this.attention(projectId, 'discussion', 'Discussion paused. Resume invites the remaining participants.')
        return false
      }
      const agent = this.memberAgents(current).find((a) => a.id === person.agentId)
      if (!agent || agent.muted || this.writesInTurn(agent, true)) {
        this.save(projectId, () => { person.status = 'omitted'; person.reason = 'No longer an eligible read-only participant.' })
        continue
      }
      const result = await this.dispatch(projectId, agent, 'DISCUSS', 'discuss', discussNote(current, this.names()))
      if (result.stopped) {
        const superseded = (this.must(projectId).revision ?? 0) !== revision
        this.save(projectId, () => {
          currentRound.status = superseded ? 'superseded' : 'stopped'
          for (const item of currentRound.participants) if (item.status === 'pending' || item.status === 'stopped') item.status = superseded ? 'superseded' : 'stopped'
        })
        this.attention(projectId, 'discussion', superseded ? 'Discussion superseded by your correction.' : 'Discussion stopped. Resume invites only unanswered participants.')
        return false
      }
      this.save(projectId, (x) => {
        if (result.messageId) person.messageId = result.messageId
        if (result.error || result.busy) { person.status = 'failed'; person.reason = result.error ?? 'Workspace busy.'; return }
        if (!result.text.trim() || result.text.trim() === '[skip]') { person.status = 'skipped'; delete person.reason; return }
        const parsed = parseObjections(result.text)
        person.status = parsed.items.length ? 'objected' : parsed.invalid ? 'invalid' : 'no-objection'
        if (parsed.invalid || parsed.overflow) {
          person.reason = parsed.error ?? `${parsed.invalid} invalid and ${parsed.overflow} excess items; see the original reply.`
          person.excerpt = result.text.slice(0, 600)
        } else delete person.reason
        x.objections ??= []
        x.nextObjectionNumber ??= 1
        for (const item of parsed.items) {
          const id = `O-${x.nextObjectionNumber++}`
          x.objections.push({ ...item, id, roundId: currentRound.id, epoch, revision, by: agent.id, status: 'open', ...(result.messageId ? { messageId: result.messageId } : {}) })
          person.objectionIds.push(id)
        }
      })
    }
    this.save(projectId, () => { currentRound.status = 'complete'; currentRound.endedAt = Date.now() })
    this.deps.note(p.conversationId, `Plan discussion: ${currentRound.participants.map((a) => `${this.names()(a.agentId)}: ${a.status}${a.reason ? ` (${a.reason})` : ''}`).join('; ') || 'no additional participants'}. A skipped or unusable reply is not agreement.`)
    return true
  }

  private async planStep(projectId: string): Promise<PlanBlock | undefined> {
    const p = this.must(projectId)
    const lead = this.agent(p.decisionOwnerId ?? '')
    if (!lead) {
      this.attention(projectId, 'plan', 'The decision owner is not on the team any more; pick one and Resume.')
      return undefined
    }
    const members = this.memberAgents(p)
    const plan = await this.step(projectId, lead, 'PLAN', 'plan', planNote(p, memberLines(members)), (text) => parsePlan(text, members))
    if (!plan) return undefined
    this.save(projectId, (x) => {
      x.plan = { ...plan, by: lead.id, at: Date.now() }
    })
    return plan
  }

  private finishPlanning(projectId: string, decided: boolean): void {
    const p = this.must(projectId)
    if (!p.plan) return this.attention(projectId, 'plan', 'No valid plan was produced.')
    const lead = p.decisionOwnerId ?? p.plan.by
    const lastCritique = p.critiques[p.critiques.length - 1]
    if (currentObjections(p).some((o) => o.status === 'open')) return this.attention(projectId, 'critique', 'Open objections need a recorded decision.')
    const needsUser = currentObjections(p).some((o) => o.status === 'needs-user')
    const autoStart = this.deps.getTeam().settings.autoStartExecution === true && !needsUser
    const updated = this.save(projectId, (x) => {
      if (!decided) {
        x.decisions.push({ at: Date.now(), by: lead, decision: `Adopt the plan: ${x.plan?.summary || `${x.plan?.tasks.length ?? 0} tasks`}`, rationale: lastCritique?.verdict === 'approve' ? 'The critic approved it.' : x.criticId ? 'Critique rounds used up; the decision owner decides.' : 'No independent critic in this project.' })
      }
      this.materialize(x)
      delete x.pendingStep
      x.phase = autoStart ? 'executing' : 'plan-ready'
      if (needsUser) x.reason = 'Resolve the objections that need your decision before starting.'
    })
    const names = this.names()
    const list = updated.tasks.filter((t) => !TERMINAL.includes(t.state)).map((t) => `${t.id} ${t.title} → ${names(t.ownerId)} (review: ${t.reviewerId ? names(t.reviewerId) : 'none'})`)
    this.deps.note(updated.conversationId, `Plan decided by ${names(lead)}: ${list.length} task(s).\n${list.join('\n')}\n${autoStart ? 'Implementation starts now.' : 'Press Start on the board to begin implementation, or Critique again.'}`)
    const dissent = currentObjections(updated).filter((o) => o.status === 'unresolved' || o.status === 'needs-user' || (o.status === 'rejected' && o.severity === 'blocking'))
    if (dissent.length) this.deps.note(updated.conversationId, `Recorded dissent:\n${dissent.map((o) => `${o.id} by ${names(o.by)} [${o.status}]: "${o.claim}" — ${o.reason}. Decision: ${o.disposition?.reason ?? ''}`).join('\n')}`)
    if (autoStart) this.pumpSoon(projectId)
  }

  /**
   * Turn the decided plan into tasks with ids, owners, reviewers and dependency states. A plan
   * without a verification (kind "test") task gets one from the workflow, after everything else,
   * so the final review never starts on untested work just because the model forgot testing.
   */
  private materialize(p: Project): void {
    if (!p.plan) return
    p.tasks = p.tasks.filter((t) => TERMINAL.includes(t.state))
    const idOf = new Map<string, string>()
    for (const pt of p.plan.tasks) idOf.set(pt.key, `T-${p.nextTaskNumber + idOf.size}`)
    const created: Task[] = []
    for (const pt of p.plan.tasks) {
      // A planned reviewer who cannot be held to read-only review is replaced by one who can.
      const planned = pt.reviewer ? this.agent(pt.reviewer) : undefined
      const reviewer = planned && !this.unsuitableReviewer(planned) ? planned.id : this.pickReviewer(p, pt.owner)?.id
      created.push(this.newTask(p, planTaskInput(pt, (k) => idOf.get(k) ?? k, reviewer), p.decisionOwnerId ?? 'workflow'))
    }
    this.ensureVerificationTask(p)
    refreshWaiting(p)
  }

  /**
   * Add the workflow's verification task when the current increment has none (no open or accepted
   * kind "test" task since the gate's start) and you did not decide verification is not applicable
   * or overridden. It runs after every open task. Returns the added task; undefined when none was
   * needed or nobody can verify (the gate then stops the project before the final review).
   */
  private ensureVerificationTask(p: Project): Task | undefined {
    if (!p.verification) p.verification = { state: 'pending', taskIds: [] }
    const g = p.verification
    if (g.state === 'not-applicable' || g.state === 'overridden') return undefined
    const since = g.since ?? 0
    if (p.tasks.some((t) => t.kind === 'test' && t.state !== 'cancelled' && t.createdAt >= since)) return undefined
    const open = p.tasks.filter((t) => !TERMINAL.includes(t.state))
    const tester = this.pickTester(p, open)
    if (!tester) return undefined
    const t = this.newTask(p, verificationTaskInput(open.map((c) => c.id), tester.id, this.pickReviewer(p, tester.id)?.id), 'workflow')
    t.autoVerify = true
    t.history.push({ at: Date.now(), by: 'workflow', text: 'Added by the workflow: the board had no verification task, and the project cannot finish without one.' })
    refreshWaiting(p)
    return t
  }

  // ---------- execution ----------

  private pumpSoon(projectId: string): void {
    queueMicrotask(() => this.pump(projectId))
  }

  private pump(projectId: string): void {
    const p = this.deps.projects.get(projectId)
    if (!p || p.paused || p.archived || this.active.has(projectId) || this.loops.has(projectId) || this.holds.has(projectId)) return
    if (p.phase !== 'executing') return
    if (currentObjections(p).some((o) => o.status === 'needs-user')) {
      this.save(p.id, (x) => {
        x.phase = 'needs-attention'
        x.paused = true
        x.reason = 'Resolve the objections that need your decision before starting.'
      })
      return
    }
    const changed = refreshWaiting(p)
    if (changed) this.save(p.id, () => {})
    const ordered = [...p.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id))
    const next = ordered.find((t) => t.state === 'implemented') ?? ordered.find((t) => t.state === 'rework') ?? ordered.find((t) => t.state === 'ready')
    if (next) {
      if (next.state === 'implemented') this.background(projectId, () => this.review(projectId, next.id))
      else {
        const owner = this.agent(next.ownerId)
        // Someone else writes in this folder tree (another project or a chat turn); a release re-pumps.
        if (owner && this.writesInTurn(owner, false) && this.locks.conflict(p.workspace)) return
        this.background(projectId, () => this.work(projectId, next.id))
      }
      return
    }
    const open = p.tasks.filter((t) => !TERMINAL.includes(t.state))
    if (open.length === 0 && p.tasks.some((t) => t.state === 'accepted')) {
      const gate = this.gate(p)
      if (!gate.ok) return this.attention(projectId, 'verification', gate.reason)
      this.save(projectId, (x) => {
        x.verification = gate.gate
        x.phase = 'final-review'
      })
      this.background(projectId, () => this.finalReview(projectId))
    }
  }

  private async work(projectId: string, taskId: string): Promise<void> {
    let p = this.must(projectId)
    let task = this.mustTask(p, taskId)
    if (task.state !== 'ready' && task.state !== 'rework') return
    this.escalateIfNeeded(p, task)
    p = this.must(projectId)
    task = this.mustTask(p, taskId)
    const owner = this.agent(task.ownerId)
    if (!owner) return this.failTask(projectId, taskId, `Owner ${task.ownerId} is not on the team any more. Reassign the task.`, 'ready')
    const rework = task.state === 'rework'
    const prior = task.state
    this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.attempts++
      t.state = 'running'
      t.history.push({ at: Date.now(), by: 'workflow', text: `Attempt ${t.attempts}/${t.maxAttempts} dispatched to ${owner.name}${rework ? ' (repair after review)' : ''}.` })
      t.updatedAt = Date.now()
    })
    const outcome = await this.dispatch(projectId, owner, taskId, 'work', workNote(this.must(projectId), this.mustTask(this.must(projectId), taskId), this.names()))
    if (outcome.busy) {
      // Another writer took the folder first: nothing ran, so the attempt is refunded and the task waits.
      this.save(projectId, (x) => {
        const t = this.mustTask(x, taskId)
        t.attempts = Math.max(0, t.attempts - 1)
        t.state = prior
        t.history.push({ at: Date.now(), by: 'workflow', text: `Not started: ${outcome.busy?.label} is writing in this folder. It starts when that finishes.` })
        t.updatedAt = Date.now()
      })
      return
    }
    if (outcome.stopped) {
      return this.interruptTask(projectId, taskId, 'ready', 'Stopped by you while the owner was working. Check the workspace, then Resume.', true)
    }
    if (outcome.error) return this.failTask(projectId, taskId, `${owner.name}'s provider failed: ${outcome.error}. Nothing was retried automatically; Retry when the provider works, or reassign.`, 'ready')
    const handoff = parseHandoff(outcome.text, taskId, { requireChecks: task.kind === 'test' })
    if (!handoff.ok) return this.malformedWork(projectId, taskId, handoff.error)
    const h = handoff.value
    const failing = (h.checks ?? []).filter((c) => c.result === 'fail')
    if (h.status === 'implemented' && failing.length > 0) return this.failedChecks(projectId, taskId, owner, h.checks ?? [], h.summary)
    if (h.status === 'blocked') {
      this.save(projectId, (x) => {
        const t = this.mustTask(x, taskId)
        t.state = 'blocked'
        t.blockedOn = 'user'
        t.reason = h.question ?? h.summary
        t.attempts = Math.max(0, t.attempts - 1)
        t.history.push({ at: Date.now(), by: owner.id, text: `Blocked: ${t.reason}` })
        t.updatedAt = Date.now()
      })
      this.deps.note(p.conversationId, `${taskId} is blocked and needs you: ${h.question ?? h.summary}\nAnswer in the chat, then Retry the task on the board.`)
      return
    }
    const { found, missing } = resolveArtifacts(h.artifacts, p.workspace)
    this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.state = 'implemented'
      t.summary = h.summary
      t.evidence = h.evidence
      t.artifacts = [...new Set([...found])]
      if (h.checks) t.checks = h.checks
      t.history.push({ at: Date.now(), by: owner.id, text: `Implemented: ${h.summary || 'no summary'}${missing.length ? ` (artifacts not found: ${missing.join(', ')})` : ''}` })
      t.updatedAt = Date.now()
    })
    const names = this.names()
    this.deps.note(p.conversationId, `${taskId} implemented by ${owner.name}. Independent review by ${task.reviewerId ? names(task.reviewerId) : 'nobody yet (assign a reviewer)'} next.`)
  }

  private async review(projectId: string, taskId: string): Promise<void> {
    const p = this.must(projectId)
    const task = this.mustTask(p, taskId)
    if (task.state !== 'implemented') return
    const reviewer = task.reviewerId ? this.agent(task.reviewerId) : undefined
    const unsuitable = !reviewer || reviewer.id === task.ownerId ? 'No independent reviewer (someone other than the owner).' : this.unsuitableReviewer(reviewer)
    if (!reviewer || unsuitable) {
      this.save(projectId, (x) => {
        const t = this.mustTask(x, taskId)
        t.state = 'blocked'
        t.blockedOn = 'reviewer'
        t.reason = `${unsuitable ?? 'No independent reviewer.'} Assign another reviewer on the board.`
        t.updatedAt = Date.now()
      })
      this.deps.note(p.conversationId, `${taskId} waits for a reviewer: ${unsuitable ?? ''}`.trim())
      return
    }
    this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.state = 'reviewing'
      t.history.push({ at: Date.now(), by: 'workflow', text: `Review dispatched to ${reviewer.name}.` })
      t.updatedAt = Date.now()
    })
    const note = reviewNote(this.must(projectId), this.mustTask(this.must(projectId), taskId), this.names())
    let outcome = await this.dispatch(projectId, reviewer, taskId, 'review', note)
    let verdict = outcome.stopped || outcome.error ? undefined : parseReview(outcome.text, taskId)
    if (verdict && !verdict.ok) {
      // One correction turn for a malformed verdict; the review itself was read-only work.
      outcome = await this.dispatch(projectId, reviewer, taskId, 'review', correctionNote('team-review', verdict.error, taskId))
      verdict = outcome.stopped || outcome.error ? undefined : parseReview(outcome.text, taskId)
    }
    if (outcome.stopped) return this.interruptTask(projectId, taskId, 'implemented', 'Review stopped by you. Resume re-runs the review.', false)
    if (outcome.error) return this.failTask(projectId, taskId, `${reviewer.name}'s provider failed during review: ${outcome.error}. Retry re-runs the review.`, 'implemented')
    if (!verdict || !verdict.ok) return this.failTask(projectId, taskId, `${reviewer.name} did not return a valid review twice (${verdict && !verdict.ok ? verdict.error : 'no reply'}). Retry, reassign the reviewer, or override.`, 'implemented')
    let v = verdict.value
    // An approval of a verification task counts only with passing structured checks on record.
    const current = this.mustTask(this.must(projectId), taskId)
    if (v.verdict === 'approve' && current.kind === 'test' && !hasPassingChecks(current)) {
      v = { verdict: 'reject', findings: ['No passing structured checks are on record for this verification task; run the checks and report each one.'], evidence: `Workflow: approval by ${reviewer.name} not accepted without verification results.` }
    }
    const exhausted = v.verdict === 'reject' && task.attempts >= task.maxAttempts
    this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.reviews.push({ at: Date.now(), reviewerId: reviewer.id, verdict: v.verdict, findings: v.findings, evidence: v.evidence })
      if (v.verdict === 'approve') {
        t.state = 'accepted'
        t.history.push({ at: Date.now(), by: reviewer.id, text: `Accepted: ${v.evidence}` })
      } else if (exhausted) {
        t.state = 'failed'
        t.resumeTo = 'ready'
        t.reason = `Rejected after ${t.attempts} of ${t.maxAttempts} attempts. Last findings: ${v.findings.join('; ')}. Retry grants new attempts; or reassign, override with a reason, or cancel.`
        t.history.push({ at: Date.now(), by: reviewer.id, text: `Rejected (attempts exhausted): ${v.findings.join('; ')}` })
      } else {
        t.state = 'rework'
        t.history.push({ at: Date.now(), by: reviewer.id, text: `Rejected: ${v.findings.join('; ')}` })
      }
      t.updatedAt = Date.now()
      refreshWaiting(x)
    })
    const names = this.names()
    if (v.verdict === 'approve') this.deps.note(p.conversationId, `${taskId} accepted by ${reviewer.name}.`)
    else if (exhausted) this.deps.note(p.conversationId, `${taskId} failed: rejected ${task.attempts} times. It waits for you on the board (Retry, reassign, override or cancel).`)
    else this.deps.note(p.conversationId, `${taskId} rejected by ${reviewer.name}; back to ${names(task.ownerId)} for repair (${task.attempts}/${task.maxAttempts} attempts used).`)
  }

  private async finalReview(projectId: string): Promise<void> {
    const p = this.must(projectId)
    const members = this.memberAgents(p)
    // The gate is checked again here: Resume can reach the final review without the scheduler.
    const gate = this.gate(p)
    if (!gate.ok) return this.attention(projectId, 'verification', gate.reason)
    const pick = this.finalReviewer(p)
    if (!pick.agent) return this.attention(projectId, 'final-review', pick.reason)
    const reviewer = pick.agent
    this.save(projectId, (x) => {
      x.verification = gate.gate
      x.phase = 'final-review'
      x.pendingStep = 'final-review'
    })
    const verdict = await this.step(projectId, reviewer, 'FINAL', 'final-review', finalNote(this.must(projectId), this.names()), (text) => parseReview(text, 'FINAL'))
    if (!verdict) return
    if (verdict.verdict === 'approve') {
      const still = this.gate(this.must(projectId))
      if (!still.ok) return this.attention(projectId, 'verification', still.reason)
      this.save(projectId, (x) => {
        x.phase = 'done'
        delete x.pendingStep
        x.decisions.push({ at: Date.now(), by: reviewer.id, decision: 'Delivery accepted after final consistency review.', rationale: verdict.evidence })
      })
      this.deps.note(p.conversationId, `Final consistency review passed (${reviewer.name}). The project is done; post a new request and press Kickoff for the next increment.`)
      return
    }
    const rounds = p.finalReviews + 1
    if (rounds >= MAX_FINAL_REVIEWS) {
      this.save(projectId, (x) => {
        x.finalReviews = rounds
      })
      return this.attention(projectId, 'final-review', `Final review rejected ${rounds} times: ${verdict.findings.join('; ')}. Add or fix tasks, then Resume to review again.`)
    }
    const fixer = pickImplementer(members, p.tasks, reviewer.id)
    if (!fixer) return this.attention(projectId, 'final-review', `Final review findings need an implementer: ${verdict.findings.join('; ')}`)
    this.save(projectId, (x) => {
      x.finalReviews = rounds
      delete x.pendingStep
      x.phase = 'executing'
      this.newTask(x, { title: 'Address final review findings', description: `The final consistency review by ${reviewer.name} found:\n- ${verdict.findings.join('\n- ')}`, kind: 'fix', tier: 'standard', ownerId: fixer.id, reviewerId: reviewer.id === fixer.id ? this.pickReviewer(x, fixer.id)?.id : reviewer.id, dependsOn: [], acceptance: verdict.findings }, reviewer.id)
      refreshWaiting(x)
    })
    this.deps.note(p.conversationId, `Final review found issues; a fix task went to ${fixer.name}.`)
  }

  /**
   * A planning or final step: one turn, plus one correction turn if the block is malformed.
   * On failure the project goes to needs-attention with a Resume action.
   */
  private async step<T>(projectId: string, agent: Agent, ref: string, kind: RunKind, note: string, parse: (text: string) => Parsed<T>): Promise<T | undefined> {
    const pending = kind === 'final-review' ? 'final-review' : kind === 'plan' ? 'plan' : kind === 'discuss' ? 'discussion' : 'critique'
    let outcome = await this.dispatch(projectId, agent, ref, kind, note)
    let parsed = outcome.stopped || outcome.error || outcome.busy ? undefined : parse(outcome.text)
    if (parsed && !parsed.ok) {
      const tag = kind === 'critique' ? 'team-critique' : kind === 'final-review' ? 'team-review' : kind === 'decide' ? 'team-decision' : 'team-plan'
      outcome = await this.dispatch(projectId, agent, ref, kind, correctionNote(tag, parsed.error, ref))
      parsed = outcome.stopped || outcome.error ? undefined : parse(outcome.text)
    }
    if (outcome.busy) {
      // Refused, not queued: you decide when to run it again.
      this.attention(projectId, pending, `${agent.name}'s ${kind} step was not started: ${outcome.busy.label} is writing in this folder, and ${agent.name}'s provider cannot be held to read-only. Resume when it finishes, or pick someone else.`)
      return undefined
    }
    if (outcome.stopped) {
      this.attention(projectId, pending, `${agent.name}'s ${kind} step was stopped by you. Resume re-runs it.`)
      return undefined
    }
    if (outcome.error) {
      this.attention(projectId, pending, `${agent.name}'s provider failed: ${outcome.error}. Resume re-runs the step.`)
      return undefined
    }
    if (!parsed || !parsed.ok) {
      this.attention(projectId, pending, `${agent.name} did not produce a valid result twice: ${parsed && !parsed.ok ? parsed.error : 'empty reply'}. Resume to try again, or change the decision owner / critic.`)
      return undefined
    }
    return parsed.value
  }

  /**
   * Run one provider turn with run bookkeeping, writer lock and stop handling. Every workflow turn
   * goes through here, so this is the one place the writer lock is taken and released: a turn that
   * can write (work by a write-capable employee, or any step on an adapter that cannot enforce
   * read-only) needs the lock for the real folder tree; on contention nothing runs and `busy`
   * names the holder. The lock is released in `finally`, after errors, stops and cancels alike.
   */
  private async dispatch(projectId: string, agent: Agent, ref: string, kind: RunKind, note: string): Promise<TurnOutcome & { stopped: boolean; busy?: LockHolder }> {
    if (this.active.has(projectId)) throw new WorkflowError(`a run is already active in this project (${this.active.get(projectId)?.ref})`, 409)
    // A correction is being applied: nothing new starts from the old instruction (e.g. a review's second turn).
    if (this.holds.has(projectId)) return { text: '', activity: [], stopped: true }
    const p = this.must(projectId)
    const readOnly = READ_KINDS.includes(kind)
    let release: (() => void) | undefined
    if (this.writesInTurn(agent, readOnly)) {
      const lock = this.locks.acquire(p.workspace, { owner: projectId, label: `${agent.name} (${ref} ${kind}) in project "${p.name}"` })
      if (!lock.ok) return { text: '', activity: [], stopped: false, busy: lock.holder }
      release = lock.release
    }
    const abort = new AbortController()
    const revision = p.revision ?? 0
    const run: TaskRun = { id: randomUUID(), kind, ref, agentId: agent.id, startedAt: Date.now(), status: 'running', revision }
    this.active.set(projectId, { ref, abort, runId: run.id })
    let outcome: TurnOutcome
    try {
      this.save(projectId, (x) => {
        x.runs.push(run)
        if (x.runs.length > 200) x.runs = x.runs.slice(-200)
      })
      outcome = await this.deps.runTurn({ project: p, agent, ref, kind, note, context: projectContext(p, this.names()), signal: abort.signal, sessionScope: kind === 'review' || kind === 'final-review' || kind === 'critique' || kind === 'discuss' ? 'review' : 'work', cwd: p.workspace, readOnly })
    } catch (err) {
      outcome = { text: '', error: err instanceof Error ? err.message : String(err), activity: [] }
    } finally {
      this.active.delete(projectId)
      release?.()
    }
    // A correction bumps the revision: whatever this run produced (even a late, complete reply from a
    // provider that ignored the abort) belongs to the superseded instruction and advances nothing.
    const superseded = (this.must(projectId).revision ?? 0) !== revision
    const stopped = abort.signal.aborted || superseded
    if (!stopped && !outcome.error && !outcome.text.trim() && kind !== 'discuss') outcome = { ...outcome, error: 'the reply was empty' }
    this.save(projectId, (x) => {
      const r = x.runs.find((y) => y.id === run.id)
      if (!r) return
      r.endedAt = Date.now()
      r.status = superseded ? 'superseded' : stopped ? 'stopped' : outcome.error ? 'error' : 'ok'
      if (outcome.messageId) r.messageId = outcome.messageId
      if (outcome.error && !stopped) r.error = outcome.error
    })
    return { ...outcome, stopped }
  }

  /** Whether this turn can change files and therefore needs the folder's writer lock. */
  private writesInTurn(agent: Agent, readOnly: boolean): boolean {
    return canWrite(agent) && (!readOnly || !enforcesReadOnly(this.kindOf(agent)))
  }

  private kindOf(agent: Agent): ProviderKind {
    return this.deps.getTeam().providers[agent.provider]?.kind ?? 'claude'
  }

  /** Why an employee cannot do an independent read-only review, or undefined if they can. */
  private unsuitableReviewer(agent: Agent): string | undefined {
    if (!agent.tools.some((t) => ['Read', 'Grep', 'Glob'].includes(t))) return `${agent.name} has no read tools, so cannot check the work.`
    if (!enforcesReadOnly(this.kindOf(agent))) return `${agent.name} runs on a provider (${this.kindOf(agent)}) whose review turns Synodica cannot hold to read-only.`
    return undefined
  }

  /** Employees who did implementation work in this project (work runs, or owners of accepted tasks). */
  private authors(p: Project): Set<string> {
    const ids = new Set(p.runs.filter((r) => r.kind === 'work').map((r) => r.agentId))
    for (const t of p.tasks) if (t.state === 'accepted' && t.kind !== 'test') ids.add(t.ownerId)
    return ids
  }

  /**
   * The final consistency reviewer: your pick, else the decision owner, else a reviewer, else any
   * member, but always someone who implemented nothing in this project and whose review turns are
   * read-only. Nobody suitable = a concrete reason for the board, never a self-approval.
   */
  private finalReviewer(p: Project): { agent: Agent; reason?: undefined } | { agent?: undefined; reason: string } {
    const members = this.memberAgents(p)
    const authors = this.authors(p)
    const ordered = [p.finalReviewerId, p.decisionOwnerId, ...members.filter((a) => roles(a).includes('reviewer')).map((a) => a.id), ...members.map((a) => a.id)]
    const seen = new Set<string>()
    for (const id of ordered) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      const a = members.find((m) => m.id === id)
      if (a && !authors.has(a.id) && !this.unsuitableReviewer(a)) return { agent: a }
    }
    const names = this.names()
    const chosen = p.finalReviewerId ? members.find((m) => m.id === p.finalReviewerId) : undefined
    const why = chosen ? (authors.has(chosen.id) ? `${chosen.name} implemented tasks here` : (this.unsuitableReviewer(chosen) ?? '')) : ''
    return { reason: `No independent final reviewer: ${[...authors].map(names).join(', ') || 'nobody'} implemented the work${why ? ` (${why})` : ''}, and no other member can review read-only. Add a member who did not implement anything and pick them as final reviewer in the project settings, then Resume.` }
  }

  /** A tester's handoff reported failing checks: the product needs a fix before verification can pass. */
  private failedChecks(projectId: string, taskId: string, tester: Agent, checks: NonNullable<Task['checks']>, summary: string): void {
    const p = this.must(projectId)
    const task = this.mustTask(p, taskId)
    const failing = checks.filter((c) => c.result === 'fail')
    const lines = failing.map((c) => `${c.check}: ${c.detail}`)
    if (task.attempts >= task.maxAttempts) {
      this.save(projectId, (x) => {
        this.mustTask(x, taskId).checks = checks
      })
      return this.failTask(projectId, taskId, `Verification still fails after ${task.attempts} attempts: ${lines.join('; ')}. Fix it, then Retry; or reassign, override with a reason, or cancel.`, 'ready')
    }
    const fixer = pickImplementer(this.memberAgents(p), p.tasks, tester.id)
    let fixId: string | undefined
    this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.checks = checks
      t.summary = summary
      if (fixer) {
        const fix = this.newTask(x, { title: `Fix failing checks from ${taskId}`, description: `Verification by ${tester.name} failed:\n- ${lines.join('\n- ')}`, kind: 'fix', tier: 'standard', ownerId: fixer.id, reviewerId: this.unsuitableReviewer(tester) ? this.pickReviewer(x, fixer.id)?.id : tester.id, dependsOn: [], acceptance: failing.map((c) => `${c.check} passes`) }, 'workflow')
        fixId = fix.id
        t.dependsOn = [...new Set([...t.dependsOn, fix.id])]
        t.state = 'waiting'
        t.history.push({ at: Date.now(), by: tester.id, text: `Verification failed (${failing.length} check(s)); ${fix.id} goes to ${fixer.name}, then verification runs again.` })
      } else {
        t.state = 'blocked'
        t.blockedOn = 'user'
        t.reason = `Verification failed and nobody else can fix it: ${lines.join('; ')}. Add a fix task or reassign, then Retry.`
        t.history.push({ at: Date.now(), by: tester.id, text: `Verification failed: ${lines.join('; ')}` })
      }
      t.updatedAt = Date.now()
      refreshWaiting(x)
    })
    this.deps.note(p.conversationId, fixer && fixId ? `${taskId}: verification failed (${lines.join('; ')}). ${fixId} goes to ${fixer.name}; ${taskId} re-runs after it is accepted.` : `${taskId}: verification failed and needs you: ${lines.join('; ')}`)
  }

  // ---------- transitions ----------

  private malformedWork(projectId: string, taskId: string, error: string): void {
    const task = this.mustTask(this.must(projectId), taskId)
    if (task.attempts < task.maxAttempts) {
      this.save(projectId, (x) => {
        const t = this.mustTask(x, taskId)
        t.state = 'rework'
        t.reviews.push({ at: Date.now(), reviewerId: 'workflow', verdict: 'reject', findings: [`Your reply had no valid completion report: ${error}. Finish the task and end with a correct team-handoff block.`], evidence: 'Handoff validation' })
        t.history.push({ at: Date.now(), by: 'workflow', text: `Malformed handoff: ${error}` })
        t.updatedAt = Date.now()
      })
      this.deps.note(this.must(projectId).conversationId, `${taskId}: the handoff was not valid (${error}); asking the owner again.`)
      return
    }
    this.failTask(projectId, taskId, `No valid handoff after ${task.attempts} attempts (${error}). Retry, reassign or cancel.`, 'ready')
  }

  private failTask(projectId: string, taskId: string, reason: string, resumeTo: 'ready' | 'implemented'): void {
    const p = this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.state = 'failed'
      t.reason = reason
      t.resumeTo = resumeTo
      t.history.push({ at: Date.now(), by: 'workflow', text: `Failed: ${reason}` })
      t.updatedAt = Date.now()
    })
    this.deps.note(p.conversationId, `${taskId} failed: ${reason}`)
  }

  private interruptTask(projectId: string, taskId: string, resumeTo: 'ready' | 'implemented', reason: string, refundAttempt: boolean): void {
    if (this.mustTask(this.must(projectId), taskId).state === 'cancelled') return
    const p = this.save(projectId, (x) => {
      const t = this.mustTask(x, taskId)
      t.state = 'interrupted'
      t.resumeTo = resumeTo
      t.reason = reason
      if (refundAttempt) t.attempts = Math.max(0, t.attempts - 1)
      t.history.push({ at: Date.now(), by: 'workflow', text: reason })
      t.updatedAt = Date.now()
    })
    this.deps.note(p.conversationId, `${taskId} interrupted: ${reason}`)
  }

  private attention(projectId: string, step: NonNullable<Project['pendingStep']>, reason: string): void {
    const p = this.save(projectId, (x) => {
      x.phase = 'needs-attention'
      x.pendingStep = step
      x.reason = reason
    })
    this.deps.note(p.conversationId, `Needs your attention: ${reason}`)
  }

  /** Before the last allowed attempt of a rejected task, move it from a routine owner to a stronger implementer. */
  private escalateIfNeeded(p: Project, task: Task): void {
    if (task.state !== 'rework' || task.attempts + 1 < task.maxAttempts || task.attempts === 0) return
    const owner = this.agent(task.ownerId)
    if (!owner || TIER_RANK[tierOf(owner)] >= TIER_RANK.critical) return
    const stronger = this.memberAgents(p)
      .filter((a) => a.id !== task.reviewerId && a.id !== owner.id && roles(a).includes('implementer') && TIER_RANK[tierOf(a)] > TIER_RANK[tierOf(owner)])
      .sort((a, b) => TIER_RANK[tierOf(b)] - TIER_RANK[tierOf(a)])[0]
    if (!stronger) return
    this.save(p.id, (x) => {
      const t = this.mustTask(x, task.id)
      t.history.push({ at: Date.now(), by: 'workflow', text: `Escalated from ${owner.name} to ${stronger.name} after ${t.attempts} rejected attempt(s).` })
      t.ownerId = stronger.id
    })
    this.deps.note(p.conversationId, `${task.id} escalated from ${owner.name} to ${stronger.name} for the last attempt.`)
  }

  // ---------- helpers ----------

  private newTask(p: Project, input: { title: string; description: string; kind: TaskKind; tier: TaskTier; ownerId: string; reviewerId: string | undefined; dependsOn: string[]; acceptance: string[] }, by: string): Task {
    const now = Date.now()
    const task: Task = {
      id: `T-${p.nextTaskNumber++}`,
      projectId: p.id,
      title: input.title,
      description: input.description,
      kind: input.kind,
      tier: input.tier,
      ownerId: input.ownerId,
      ...(input.reviewerId && input.reviewerId !== input.ownerId ? { reviewerId: input.reviewerId } : {}),
      state: 'waiting',
      dependsOn: input.dependsOn,
      acceptance: input.acceptance,
      attempts: 0,
      maxAttempts: Math.max(1, this.deps.getTeam().settings.maxTaskAttempts ?? 3),
      artifacts: [],
      reviews: [],
      history: [{ at: now, by, text: 'Created.' }],
      createdAt: now,
      updatedAt: now,
    }
    p.tasks.push(task)
    return task
  }

  /** Reviewer for an owner: a reviewer-capable member who is not the owner, preferring another provider kind. */
  private pickReviewer(p: Project, ownerId: string): Agent | undefined {
    const team = this.deps.getTeam()
    const owner = this.agent(ownerId)
    const kindOf = (a: Agent | undefined): string => (a ? (team.providers[a.provider]?.kind ?? a.provider) + ':' + (team.providers[a.provider]?.baseUrl ?? '') : '')
    const candidates = this.memberAgents(p).filter((a) => a.id !== ownerId && !this.unsuitableReviewer(a))
    const score = (a: Agent): number => (roles(a).includes('reviewer') ? 4 : 0) + (roles(a).includes('tester') ? 2 : 0) + (kindOf(a) !== kindOf(owner) ? 3 : 0) + (a.id === p.decisionOwnerId ? -1 : 0)
    return candidates.sort((a, b) => score(b) - score(a))[0]
  }

  /**
   * Owner of the workflow-added verification task. Only members who can really run commands in a
   * project work turn qualify (see `commandAccess`): the task asks for tests or a build. Among them a
   * tester first (preferring one who owns no implementation task in this plan), else anyone who is
   * not the decision owner. Undefined = nobody can verify; the gate then waits for you.
   */
  private pickTester(p: Project, planned: Task[]): Agent | undefined {
    const builders = new Set(planned.filter((t) => t.kind !== 'test').map((t) => t.ownerId))
    const able = this.memberAgents(p).filter((a) => commandAccess(a, this.kindOf(a)).ok)
    const score = (a: Agent): number => (builders.has(a.id) ? 0 : 1)
    const testers = able.filter((a) => roles(a).includes('tester')).sort((a, b) => score(b) - score(a))
    return testers[0] ?? able.filter((a) => a.id !== p.decisionOwnerId).sort((a, b) => score(b) - score(a))[0]
  }

  /** Why nobody on the project can own a verification task, in words you can act on. */
  private noTesterReason(p: Project): string {
    const why = this.memberAgents(p).map((a) => commandAccess(a, this.kindOf(a))).filter((r): r is { ok: false; reason: string } => !r.ok).map((r) => r.reason)
    return `Nobody on this project can run tests or a build in a project turn${why.length ? ` (${why.join('; ')})` : ''}. Add a Claude Code, Codex or Gemini CLI member with the Bash tool to the project chat and add a verification task; or record why verification is not applicable.`
  }

  /** The verification gate, with the reason nobody could verify when that is why it is not satisfied. */
  private gate(p: Project): ReturnType<typeof verificationStatus> {
    const g = verificationStatus(p, this.names())
    if (g.ok) return g
    const since = p.verification?.since ?? 0
    const hasTest = p.tasks.some((t) => t.kind === 'test' && t.state !== 'cancelled' && t.createdAt >= since)
    if (hasTest || this.pickTester(p, [])) return g
    return { ok: false, reason: `${g.reason} ${this.noTesterReason(p)}` }
  }

  private checkPeople(p: Project, ownerId: string, reviewerId: string | undefined): void {
    const members = this.deps.members(p.conversationId)
    if (!members.includes(ownerId) || !this.agent(ownerId)) throw new WorkflowError(`owner ${ownerId} is not a member of the project chat`)
    if (reviewerId !== undefined && reviewerId !== '') {
      const reviewer = this.agent(reviewerId)
      if (!members.includes(reviewerId) || !reviewer) throw new WorkflowError(`reviewer ${reviewerId} is not a member of the project chat`)
      if (reviewerId === ownerId) throw new WorkflowError('the reviewer must be someone other than the owner')
      const why = this.unsuitableReviewer(reviewer)
      if (why) throw new WorkflowError(`${why} Pick another reviewer.`)
    }
  }

  private isTaskActive(p: Project, t: Task): boolean {
    return this.active.get(p.id)?.ref === t.id
  }

  private assertIdle(p: Project): void {
    if (this.holds.has(p.id)) throw new WorkflowError('a correction is being applied in this project; wait until it says Stopped', 409)
    if (this.active.has(p.id) || this.loops.has(p.id)) throw new WorkflowError(`${this.active.get(p.id)?.ref ?? 'a step'} is running in this project; wait or Stop it first`, 409)
  }

  private background(projectId: string, fn: () => Promise<void>): void {
    if (this.loops.has(projectId)) return
    const loop = (async () => {
      try {
        await fn()
      } catch (err) {
        console.error(`[workflow] ${projectId}:`, err)
      } finally {
        this.loops.delete(projectId)
        this.pumpSoon(projectId)
      }
    })()
    this.loops.set(projectId, loop)
  }

  private openCount(p: Project): number {
    return p.tasks.filter((t) => !TERMINAL.includes(t.state)).length
  }

  private save(projectId: string, fn: (p: Project) => void): Project {
    const p = this.deps.projects.update(projectId, fn)
    this.deps.changed(p)
    return p
  }

  private must(id: string): Project {
    const p = this.deps.projects.get(id)
    if (!p) throw new WorkflowError('unknown project', 404)
    return p
  }

  private mustTask(p: Project, id: string): Task {
    const t = p.tasks.find((x) => x.id === id)
    if (!t) throw new WorkflowError(`unknown task ${id}`, 404)
    return t
  }

  private agent(id: string): Agent | undefined {
    return this.deps.getTeam().agents.find((a) => a.id === id)
  }

  private memberAgents(p: Project): Agent[] {
    const ids = this.deps.members(p.conversationId)
    return this.deps.getTeam().agents.filter((a) => ids.includes(a.id))
  }

  private names(): (id: string) => string {
    const team = this.deps.getTeam()
    return (id: string) => (id === 'user' ? team.owner.name : (team.agents.find((a) => a.id === id)?.name ?? id))
  }
}

// ---------- pure helpers (exported for tests) ----------

function pickLead(members: Agent[]): Agent | undefined {
  return members.find((a) => roles(a).includes('lead')) ?? members.find((a) => !a.muted)
}

function pickCritic(members: Agent[], lead: Agent | undefined): Agent | undefined {
  return members.find((a) => a.id !== lead?.id && roles(a).includes('critic')) ?? members.find((a) => a.id !== lead?.id && roles(a).includes('reviewer'))
}

function pickImplementer(members: Agent[], tasks: Task[], notId: string): Agent | undefined {
  const counts = new Map<string, number>()
  for (const t of tasks) if (t.state === 'accepted') counts.set(t.ownerId, (counts.get(t.ownerId) ?? 0) + 1)
  const pool = members.filter((a) => a.id !== notId && canWrite(a))
  return pool.sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || TIER_RANK[tierOf(b)] - TIER_RANK[tierOf(a)])[0]
}

function planTaskInput(pt: ProjectPlanTask, id: (key: string) => string, reviewerId: string | undefined) {
  return { title: pt.title, description: pt.description, kind: pt.kind, tier: pt.tier, ownerId: pt.owner, reviewerId, dependsOn: pt.dependsOn.map(id), acceptance: pt.acceptance }
}

function verificationTaskInput(after: string[], ownerId: string, reviewerId: string | undefined) {
  return {
    title: 'Verify user flows and tests',
    description: 'Exercise the delivery as its users would: run the automated tests or the build, and walk through each main user flow from the brief. Report every check with the exact command or steps and what happened. Do not change product code here; report failures as failing checks.',
    kind: 'test' as const,
    tier: 'standard' as const,
    ownerId,
    reviewerId,
    dependsOn: after,
    acceptance: ['Each main user flow from the brief was exercised and passed', 'The automated tests or the build ran and passed; commands and results are reported'],
  }
}

/** A verification task has structured checks on record and every one passed. */
export function hasPassingChecks(t: Task): boolean {
  return (t.checks?.length ?? 0) > 0 && (t.checks ?? []).every((c) => c.result === 'pass')
}

/**
 * The verification gate. Satisfied by your recorded decision (not applicable / overridden, with a
 * reason), by an accepted verification task with passing checks approved by an independent
 * reviewer, or by your override-acceptance of a verification task (its reason is recorded).
 * Free-text evidence alone never satisfies it.
 */
export function verificationStatus(p: Project, name: (id: string) => string): { ok: true; gate: VerificationGate } | { ok: false; reason: string } {
  const g = p.verification
  if (g && (g.state === 'not-applicable' || g.state === 'overridden') && g.reason) return { ok: true, gate: g }
  const tests = p.tasks.filter((t) => t.kind === 'test' && t.createdAt >= (g?.since ?? 0))
  for (const t of [...tests].reverse()) {
    if (t.state !== 'accepted') continue
    const approval = [...t.reviews].reverse().find((r) => r.verdict === 'approve')
    if (!approval) continue
    if (approval.override) return { ok: true, gate: { state: 'overridden', taskIds: [t.id], reason: approval.evidence, by: 'user', at: approval.at, ...(g?.since ? { since: g.since } : {}) } }
    if (approval.reviewerId !== t.ownerId && approval.reviewerId !== 'workflow' && hasPassingChecks(t)) {
      const checks = (t.checks ?? []).map((c) => `${c.check}: ${c.result} (${c.detail})`).join('; ')
      return { ok: true, gate: { state: 'passed', taskIds: [t.id], evidence: `${checks}. Reviewed by ${name(approval.reviewerId)}: ${approval.evidence}`, by: approval.reviewerId, at: approval.at, ...(g?.since ? { since: g.since } : {}) } }
    }
  }
  const open = tests.filter((t) => t.state !== 'accepted' && t.state !== 'cancelled')
  const why = open.length
    ? `verification ${open.map((t) => `${t.id} (${t.state})`).join(', ')} is not accepted yet`
    : tests.length
      ? 'every verification task was cancelled or lacks passing checks'
      : 'the project has no verification (test) task and nobody was available to run one'
  return { ok: false, reason: `The final review cannot start: ${why}. Add a verification task (kind "test") on the board, or record a reason why verification is not applicable or is overridden, then Resume.` }
}

/**
 * Recompute dependency-driven states: waiting ↔ ready, and blocked when a prerequisite was
 * cancelled or removed. Returns whether anything changed.
 */
export function refreshWaiting(p: Project): boolean {
  let changed = false
  const byId = new Map(p.tasks.map((t) => [t.id, t]))
  for (const t of p.tasks) {
    const movable = t.state === 'waiting' || t.state === 'ready' || (t.state === 'blocked' && t.blockedOn === 'dependency')
    if (!movable) continue
    // The workflow's own verification task checks whatever was delivered: cancelled work is skipped, not awaited.
    const deps = t.dependsOn.map((d) => ({ id: d, task: byId.get(d) })).filter((d) => !t.autoVerify || (d.task !== undefined && d.task.state !== 'cancelled'))
    const dead = deps.find((d) => !d.task || d.task.state === 'cancelled')
    let next: Task['state']
    if (dead) next = 'blocked'
    else next = deps.every((d) => d.task?.state === 'accepted') ? 'ready' : 'waiting'
    if (next === t.state && (next !== 'blocked' || t.blockedOn === 'dependency')) continue
    t.state = next
    if (next === 'blocked') {
      t.blockedOn = 'dependency'
      t.reason = `Depends on ${dead?.id} which was ${dead?.task ? 'cancelled' : 'removed'}. Edit the dependencies or cancel this task.`
    } else {
      delete t.blockedOn
      delete t.reason
    }
    t.updatedAt = Date.now()
    changed = true
  }
  return changed
}

/** Tasks that depend on `taskId`, directly or through other tasks. */
export function dependentsOf(tasks: Task[], taskId: string): Task[] {
  const out = new Map<string, Task>()
  const queue = [taskId]
  while (queue.length > 0) {
    const id = queue.shift() as string
    for (const t of tasks) {
      if (t.dependsOn.includes(id) && !out.has(t.id) && t.id !== taskId) {
        out.set(t.id, t)
        queue.push(t.id)
      }
    }
  }
  return [...out.values()]
}

export function createsCycle(tasks: Task[], taskId: string, deps: string[]): boolean {
  const edges = new Map(tasks.map((t) => [t.id, t.id === taskId ? deps : t.dependsOn]))
  const seen = new Set<string>()
  const stack = [...deps]
  while (stack.length > 0) {
    const cur = stack.pop()
    if (cur === undefined) break
    if (cur === taskId) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    stack.push(...(edges.get(cur) ?? []))
  }
  return false
}

/**
 * Resolve handoff artifact paths against the workspace; only files that exist and whose *real*
 * path is inside the real workspace count, so a symlink artifact cannot point the board (and the
 * file preview) at a file outside the project. Found paths keep the workspace spelling.
 */
export function resolveArtifacts(paths: string[], workspace: string): { found: string[]; missing: string[] } {
  const found: string[] = []
  const missing: string[] = []
  const root = path.resolve(workspace)
  const realRoot = canonicalPath(root)
  for (const raw of paths) {
    const abs = path.resolve(root, raw)
    if (!existsSync(abs) || !isInside(abs, root) || !isInside(canonicalPath(abs), realRoot)) missing.push(raw)
    else found.push(abs)
  }
  return { found, missing }
}

function memberLines(members: Agent[]): string {
  return members
    .map((a) => `- ${a.name} (id ${a.id}; ${a.role}; roles: ${roles(a).join(', ') || 'none'}; tier ${tierOf(a)}; ${canWrite(a) ? 'can change files' : 'read-only'}; tools ${a.tools.join(', ') || 'none'})${a.scope ? ` — ${a.scope}` : ''}`)
    .join('\n')
}

/** Shared project context for every turn in a project conversation. */
export function discussionEnabled(team: Team, members: Agent[]): boolean {
  return team.settings.planDiscussion === 'on' || (team.settings.planDiscussion !== 'off' && members.some((a) => /^(company|laboratory)-/.test(a.templateSeat ?? '')))
}

function assertNoUserObjections(p: Project): void {
  if (currentObjections(p).some((o) => o.status === 'needs-user')) throw new WorkflowError('Resolve the objections that need your decision before starting.', 409)
}

function currentObjections(p: Project): PlanObjection[] {
  return (p.objections ?? []).filter((o) => o.epoch === (p.planEpoch ?? 0) && o.status !== 'superseded')
}

function supersedeDiscussion(p: Project): void {
  for (const round of p.discussions ?? []) round.status = 'superseded'
  for (const o of p.objections ?? []) o.status = 'superseded'
}

function discussionContext(p: Project, name: (id: string) => string): string {
  const objections = currentObjections(p)
  const round = p.discussions?.find((r) => r.epoch === (p.planEpoch ?? 0) && r.status !== 'superseded')
  if (!round && !objections.length) return ''
  const short = (s: string) => s.length > 400 ? `${s.slice(0, 400)}…` : s
  const outstanding = objections.filter((o) => o.status !== 'accepted')
  const lines = outstanding.slice(0, 12).map((o) => `- ${o.id} [${o.severity}, ${o.basis}] by ${name(o.by)}: "${short(o.claim)}" — ${short(o.reason)} → ${o.status}${o.disposition ? ` by ${name(o.disposition.by)}: ${short(o.disposition.reason)}` : ''}`)
  const unheard = round?.participants.filter((a) => ['omitted', 'invalid', 'failed', 'stopped', 'pending'].includes(a.status)) ?? []
  return `\nPlan discussion (current plan): ${objections.filter((o) => o.status === 'accepted').length} accepted; skipping is not agreement.\n${lines.join('\n')}${outstanding.length > 12 ? `\n(${outstanding.length - 12} more on the board)` : ''}${unheard.length ? `\nNot heard: ${unheard.map((a) => `${name(a.agentId)} (${a.status}: ${a.reason ?? 'awaiting reply'})`).join('; ')}` : ''}\n`
}

export function projectContext(p: Project, name: (id: string) => string): string {
  const brief = p.brief.length > 3000 ? `${p.brief.slice(0, 3000)}…` : p.brief
  const decisions = p.decisions.slice(-8).map((d) => `- ${d.decision}${d.rationale ? ` (why: ${d.rationale})` : ''} — ${name(d.by)}`)
  const tasks = [...p.tasks].sort((a, b) => taskNumber(a.id) - taskNumber(b.id)).map((t) => `- ${t.id} [${t.state}] ${t.title} — owner ${name(t.ownerId)}, reviewer ${t.reviewerId ? name(t.reviewerId) : 'none'}${t.dependsOn.length ? `, after ${t.dependsOn.join(', ')}` : ''}`)
  const corrections = (p.corrections ?? []).slice(-6).map((c) => `- (revision ${c.revision}${c.interrupted ? `, interrupted ${c.interrupted}` : ''}) ${c.text.length > 600 ? `${c.text.slice(0, 600)}…` : c.text}`)
  return `Project "${p.name}". Workspace (work only inside it): ${p.workspace}
Decision owner: ${p.decisionOwnerId ? name(p.decisionOwnerId) : 'none'}. Critic: ${p.criticId ? name(p.criticId) : 'none'}. Phase: ${p.phase}.
Brief:
${brief || '(none yet)'}
${corrections.length ? `\nCorrections from the boss (latest last; they override the brief and earlier instructions where they conflict):\n${corrections.join('\n')}\n` : ''}${p.plan?.architecture ? `\nArchitecture: ${p.plan.architecture}\n` : ''}${decisions.length ? `\nDecisions:\n${decisions.join('\n')}\n` : ''}${tasks.length ? `\nTask board:\n${tasks.join('\n')}\n` : ''}
${discussionContext(p, name)}Shared notes are also written to ${path.join(p.workspace, '.opengrokbot')} (brief.md, decisions.md, tasks.md).
Only the decision owner changes the board from chat, with fenced team-task blocks: {"op":"create","title":…,"owner":…,"reviewer":…,"dependsOn":["T-1"],"acceptance":[…]} / {"op":"update","task":"T-2",…} / {"op":"cancel","task":"T-3","reason":…}.`
}

const WORKFLOW_RULE = 'This is a workflow step from the dispatcher. It overrides the chat brevity rule and the [skip] option: do the step fully, keep the prose short, and end with the requested block exactly once.'

function discussNote(p: Project, name: (id: string) => string): string {
  return `This is one read-only planning discussion turn. Your role is a primary responsibility, not a boundary on reasoned objections. Do not implement, edit files, run commands or change the task board. Do not speak for anyone else. You may return [skip] when you have nothing material to add; skipping still uses a model call.
Plan: ${p.plan?.summary ?? ''}
Architecture: ${p.plan?.architecture ?? ''}
Tasks: ${JSON.stringify(p.plan?.tasks ?? [])}
Earlier objections in this discussion:
${currentObjections(p).map((o) => `${o.id} by ${name(o.by)}: "${o.claim}" — ${o.reason}`).join('\n') || '(none)'}
Raise only concrete issues that can change the decision; avoid repeated agreement or duplicate objections. State evidence and source locations, or label assumptions as hypotheses. Missing shell access limits executed checks, not logical reasoning; say what check would settle a hypothesis. The user corrections in the shared context override earlier requirements. Do not invent tests, sources or data.
Return at most five items, preserving your actual reasons. Empty items means no objection, not agreement:
\`\`\`team-objections
{"items":[{"claim":"the issue","reason":"why it matters","basis":"evidence or hypothesis","citations":["file:line or source URL"],"severity":"blocking or advisory","proposal":"suggested alternative"}]}
\`\`\``
}

function planNote(p: Project, members: string): string {
  return `${WORKFLOW_RULE}
Step: requirement analysis and plan. You are the decision owner for "${p.name}".
1. Analyse the brief: goal, users, must-haves, constraints, risks. Where something is unclear, choose a sensible assumption and state it.
2. Choose the architecture in a few sentences (stack, structure, how it is tested).
3. Break the work into the fewest tasks that each produce a checkable result (a simple request may be one task). For each: an owner who can do it, a reviewer who is NOT the owner (prefer a different provider), dependencies by key, a tier (routine / standard / critical) and concrete, testable acceptance criteria. Plan verification (tests or a user-flow check) and documentation that depends on the implementation, when the project needs them.
Project members:
${members}
End with:
\`\`\`team-plan
{"summary":"one line","architecture":"short","tasks":[{"key":"core","title":"…","description":"…","kind":"implement","tier":"standard","owner":"NAME","reviewer":"NAME","dependsOn":[],"acceptance":["…"]}]}
\`\`\``
}

function critiqueNote(p: Project, critic: Agent, name: (id: string) => string): string {
  const plan = p.plan
  return `${WORKFLOW_RULE}
Step: independent plan critique for "${p.name}". You are ${critic.name}; the decision owner is ${p.decisionOwnerId ? name(p.decisionOwnerId) : 'unknown'}.
Plan by ${plan ? name(plan.by) : '?'}: ${plan?.summary ?? ''}
Architecture: ${plan?.architecture ?? ''}
Tasks:
${(plan?.tasks ?? []).map((t) => `- ${t.key}: ${t.title} (owner ${name(t.owner)}, reviewer ${t.reviewer ? name(t.reviewer) : 'auto'}, after ${t.dependsOn.join(', ') || 'nothing'}) — acceptance: ${t.acceptance.join(' | ')}`).join('\n')}
Check: missing requirements, wrong order or dependencies, owners who cannot do their task (tools, tier), untestable acceptance criteria, security / data-loss risks, over-engineering. Approve if it is good enough to start; ask for a revision only for issues that matter, listed concretely.
End with:
\`\`\`team-critique
{"verdict":"approve" or "revise","issues":["…"]}
\`\`\``
}

function decideNote(p: Project, issues: string[], name: (id: string) => string, members: string): string {
  const open = currentObjections(p).filter((o) => o.status === 'open')
  const invalid = p.discussions?.filter((r) => r.epoch === (p.planEpoch ?? 0) && r.status !== 'superseded').flatMap((r) => r.participants.filter((a) => a.excerpt).map((a) => `${name(a.agentId)}: ${a.excerpt}`)) ?? []
  return `${WORKFLOW_RULE}
Step: decision. ${p.criticId ? name(p.criticId) : 'The critic'} asked for revisions:
- ${issues.join('\n- ')}
You are the decision owner. Accept the points you agree with, reject the others with a reason, and decide. If the plan changes, post the full revised team-plan (same format as before). Members:
${members}
Open objections (the words of the original speakers):
${open.map((o) => `${o.id} by ${name(o.by)} [${o.severity}, ${o.basis}]: "${o.claim}" — ${o.reason}${o.citations.length ? ` Sources: ${o.citations.join('; ')}` : ''}${o.proposal ? ` Proposal: ${o.proposal}` : ''}`).join('\n') || '(none)'}
${invalid.length ? `Unstructured replies (not agreement; address any substantive issue):\n${invalid.join('\n')}` : ''}
Address each open objection exactly once by ID, with disposition accepted, rejected, unresolved or needs-user and a reason. Retain disagreement honestly. Use needs-user only for authority, priorities, budget or expanded permissions that require the user; decide routine supported tradeoffs yourself. A blocking label does not automatically require user intervention. Accepted improvements should be reflected in a revised plan. An unresolved item stays visible during execution. Never change permissions or models to settle a disagreement.
End with an optional revised team-plan block and then:
\`\`\`team-decision
{"decision":"what we will do","rationale":"why, including which critique points you rejected","objections":[${open.map((o) => `{"id":"${o.id}","disposition":"accepted|rejected|unresolved|needs-user","reason":"why"}`).join(',')}]}
\`\`\``
}

function workNote(p: Project, t: Task, name: (id: string) => string): string {
  const deps = t.dependsOn.map((d) => p.tasks.find((x) => x.id === d)).filter((x): x is Task => x !== undefined)
  const depLines = deps.map((d) => `- ${d.id} ${d.title} (accepted): ${d.summary ?? ''}${d.artifacts.length ? ` — files: ${d.artifacts.join(', ')}` : ''}`)
  const lastReject = [...t.reviews].reverse().find((r) => r.verdict === 'reject')
  const repair = t.state === 'running' && lastReject ? `\nThis is a repair. ${lastReject.reviewerId === 'workflow' ? 'The workflow' : lastReject.reviewerId === 'user' ? 'The boss' : name(lastReject.reviewerId)} rejected the previous attempt:\n- ${lastReject.findings.join('\n- ')}\nFix exactly these, keep what works.` : ''
  return `${WORKFLOW_RULE}
Task ${t.id}: ${t.title} (attempt ${t.attempts} of ${t.maxAttempts}; tier ${t.tier}).
${t.description}
Acceptance criteria:
- ${t.acceptance.join('\n- ')}
${correctionLines(t)}${depLines.length ? `Builds on:\n${depLines.join('\n')}\n` : ''}Work in ${p.workspace}. Do the task with your tools, verify it (run the tests or the build, or check the result), and report honestly.${repair}
If you cannot proceed without the boss, set status "blocked" and ask one question.${
    t.kind === 'test'
      ? `
This is the verification task: the project cannot finish without it. Report every check you ran in "checks", with "result" "pass" or "fail" and the exact command or steps in "detail". Report failures honestly as "fail"; do not fix product code in this task.
End with:
\`\`\`team-handoff
{"task":"${t.id}","status":"implemented" or "blocked","summary":"what you verified","artifacts":["relative/path"],"evidence":"overall result","checks":[{"check":"user flow or test","result":"pass","detail":"command or steps and what happened"}],"question":"only when blocked"}
\`\`\``
      : `
End with:
\`\`\`team-handoff
{"task":"${t.id}","status":"implemented" or "blocked","summary":"what changed","artifacts":["relative/path"],"evidence":"commands you ran and their results","question":"only when blocked"}
\`\`\``
  }`
}

function reviewNote(p: Project, t: Task, name: (id: string) => string): string {
  const prior = t.reviews.filter((r) => r.reviewerId !== 'workflow').map((r) => `- ${r.verdict} by ${name(r.reviewerId)}: ${r.findings.join('; ') || r.evidence}`)
  return `${WORKFLOW_RULE}
Step: independent review of ${t.id}: ${t.title}. Owner: ${name(t.ownerId)}. You did not build it; check it yourself.
Acceptance criteria:
- ${t.acceptance.join('\n- ')}
${correctionLines(t)}Owner's report: ${t.summary ?? '(none)'}
Owner's evidence: ${t.evidence ?? '(none)'}
Files: ${t.artifacts.length ? t.artifacts.join(', ') : '(none listed)'}
${t.checks?.length ? `Verification checks reported:\n${t.checks.map((c) => `- [${c.result}] ${c.check}: ${c.detail}`).join('\n')}\n` : ''}${prior.length ? `Earlier reviews:\n${prior.join('\n')}\n` : ''}This review is read-only: you cannot change files. Read the files in ${p.workspace} and verify each criterion (your tools may allow read-only checks). Approve only if every criterion is met; otherwise reject with concrete, fixable findings.
End with:
\`\`\`team-review
{"task":"${t.id}","verdict":"approve" or "reject","findings":["…"],"evidence":"what you checked and how"}
\`\`\``
}

function finalNote(p: Project, name: (id: string) => string): string {
  const tasks = p.tasks.filter((t) => t.state === 'accepted').map((t) => `- ${t.id} ${t.title} (${name(t.ownerId)}): ${t.summary ?? ''}${t.artifacts.length ? ` — ${t.artifacts.join(', ')}` : ''}`)
  return `${WORKFLOW_RULE}
Step: final consistency review of "${p.name}". All tasks are accepted:
${tasks.join('\n')}
Verification gate: ${p.verification ? `${p.verification.state}${p.verification.evidence ? ` — ${p.verification.evidence}` : ''}${p.verification.reason ? ` — reason: ${p.verification.reason}` : ''}` : 'pending'}
This review is read-only and independent: you implemented none of these tasks. Check the delivery as a whole against the brief: do the parts fit together, do the docs match the code and commands, is anything promised missing? Read the files in ${p.workspace}.
End with:
\`\`\`team-review
{"task":"FINAL","verdict":"approve" or "reject","findings":["…"],"evidence":"what you checked"}
\`\`\``
}

/** The boss's corrections for a task, as requirements that override the description. */
function correctionLines(t: Task): string {
  const list = t.corrections ?? []
  if (list.length === 0) return ''
  return `Corrections from the boss (they are requirements and override the description where they conflict; latest last):\n- ${list.map((c) => c.text).join('\n- ')}\n`
}

function correctionNote(tag: string, error: string, ref: string): string {
  return `${WORKFLOW_RULE}
Your previous reply for ${ref} could not be used: ${error}. Reply again with a corrected \`\`\`${tag}\`\`\` block (valid JSON, all required fields). Do not redo work that is already done.`
}
