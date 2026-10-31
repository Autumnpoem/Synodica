import type { Agent, ProjectPlanTask, TaskKind, TaskTier, VerificationCheck } from '../shared/types.js'

/**
 * Structured blocks employees end workflow turns with. Only these move task state; free text
 * like "done!" never does. Each block is a fenced code block tagged team-<kind> holding JSON:
 *
 *   ```team-handoff
 *   {"task":"T-2","status":"implemented","summary":"…","artifacts":["src/a.ts"],"evidence":"npm test: 12 passed"}
 *   ```
 */
export type BlockKind = 'plan' | 'objections' | 'critique' | 'decision' | 'handoff' | 'review' | 'task'

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

const KINDS: TaskKind[] = ['implement', 'test', 'docs', 'design', 'research', 'fix']
const TIERS: TaskTier[] = ['routine', 'standard', 'critical']
const MAX_PLAN_TASKS = 12

/** All JSON bodies of team-<kind> blocks in order of appearance. */
export function findBlocks(text: string, kind: BlockKind): string[] {
  const re = new RegExp('```\\s*team-' + kind + '\\s*\\n([\\s\\S]*?)```', 'gi')
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) out.push((m[1] ?? '').trim())
  return out
}

function parseJson(body: string, kind: BlockKind): Parsed<Record<string, unknown>> {
  // Models often leave a trailing comma; accept that one slip, nothing else.
  const cleaned = body.replace(/,\s*([}\]])/g, '$1')
  try {
    const v = JSON.parse(cleaned) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, error: `team-${kind} must be a JSON object` }
    return { ok: true, value: v as Record<string, unknown> }
  } catch (err) {
    return { ok: false, error: `team-${kind} is not valid JSON (${err instanceof Error ? err.message : String(err)})` }
  }
}

/** The last team-<kind> block, parsed. */
function lastBlock(text: string, kind: BlockKind): Parsed<Record<string, unknown>> {
  const blocks = findBlocks(text, kind)
  const body = blocks[blocks.length - 1]
  if (body === undefined) return { ok: false, error: `no team-${kind} block found` }
  return parseJson(body, kind)
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter((x) => x.length > 0) : typeof v === 'string' && v.trim() ? [v.trim()] : [])

/** Find an employee by id or display name (case-insensitive, optional leading @). */
export function resolveAgent(ref: string, agents: Agent[]): Agent | undefined {
  const r = ref.replace(/^@/, '').trim().toLowerCase()
  if (!r) return undefined
  return agents.find((a) => a.id.toLowerCase() === r) ?? agents.find((a) => a.name.toLowerCase() === r)
}

function hasCycle(tasks: ProjectPlanTask[]): string | null {
  const byKey = new Map(tasks.map((t) => [t.key, t]))
  const state = new Map<string, 1 | 2>()
  const visit = (key: string, trail: string[]): string | null => {
    if (state.get(key) === 2) return null
    if (state.get(key) === 1) return [...trail, key].join(' -> ')
    state.set(key, 1)
    for (const d of byKey.get(key)?.dependsOn ?? []) {
      const c = visit(d, [...trail, key])
      if (c) return c
    }
    state.set(key, 2)
    return null
  }
  for (const t of tasks) {
    const c = visit(t.key, [])
    if (c) return c
  }
  return null
}

export interface PlanBlock {
  summary: string
  architecture: string
  tasks: ProjectPlanTask[]
}

/** A team-plan block, validated against the project members. */
export function parsePlan(text: string, members: Agent[]): Parsed<PlanBlock> {
  const j = lastBlock(text, 'plan')
  if (!j.ok) return j
  const raw = Array.isArray(j.value.tasks) ? j.value.tasks : null
  if (!raw || raw.length === 0) return { ok: false, error: 'team-plan has no tasks' }
  if (raw.length > MAX_PLAN_TASKS) return { ok: false, error: `team-plan has ${raw.length} tasks; keep it to ${MAX_PLAN_TASKS} or fewer` }
  const tasks: ProjectPlanTask[] = []
  const errors: string[] = []
  raw.forEach((item, i) => {
    const r = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const key = str(r.key) || str(r.id) || `t${i + 1}`
    const title = str(r.title)
    const ownerRef = str(r.owner)
    const owner = resolveAgent(ownerRef, members)
    const reviewerRef = str(r.reviewer)
    const reviewer = reviewerRef ? resolveAgent(reviewerRef, members) : undefined
    const acceptance = strList(r.acceptance)
    if (!title) errors.push(`task ${i + 1} has no title`)
    if (!owner) errors.push(`task "${title || key}" has unknown owner "${ownerRef}"`)
    if (reviewerRef && !reviewer) errors.push(`task "${title || key}" has unknown reviewer "${reviewerRef}"`)
    if (owner && reviewer && owner.id === reviewer.id) errors.push(`task "${title || key}" is reviewed by its own owner`)
    if (acceptance.length === 0) errors.push(`task "${title || key}" has no acceptance criteria`)
    const kind = KINDS.includes(str(r.kind) as TaskKind) ? (str(r.kind) as TaskKind) : 'implement'
    const tier = TIERS.includes(str(r.tier) as TaskTier) ? (str(r.tier) as TaskTier) : 'standard'
    tasks.push({ key, title, description: str(r.description), kind, tier, owner: owner?.id ?? '', ...(reviewer ? { reviewer: reviewer.id } : {}), dependsOn: strList(r.dependsOn), acceptance })
  })
  const keys = new Set(tasks.map((t) => t.key))
  if (keys.size !== tasks.length) errors.push('task keys must be unique')
  for (const t of tasks) for (const d of t.dependsOn) if (!keys.has(d)) errors.push(`task "${t.key}" depends on unknown key "${d}"`)
  if (errors.length === 0) {
    const cycle = hasCycle(tasks)
    if (cycle) errors.push(`dependency cycle: ${cycle}`)
  }
  if (errors.length > 0) return { ok: false, error: `team-plan is invalid: ${errors.join('; ')}` }
  return { ok: true, value: { summary: str(j.value.summary), architecture: str(j.value.architecture), tasks } }
}

export interface CritiqueBlock {
  verdict: 'approve' | 'revise'
  issues: string[]
}

export function parseCritique(text: string): Parsed<CritiqueBlock> {
  const j = lastBlock(text, 'critique')
  if (!j.ok) return j
  const verdict = str(j.value.verdict).toLowerCase()
  if (verdict !== 'approve' && verdict !== 'revise') return { ok: false, error: 'team-critique.verdict must be "approve" or "revise"' }
  const issues = strList(j.value.issues)
  if (verdict === 'revise' && issues.length === 0) return { ok: false, error: 'team-critique asks for a revision but lists no issues' }
  return { ok: true, value: { verdict, issues } }
}

export interface DecisionBlock {
  decision: string
  rationale: string
  objections?: { id: string; disposition: 'accepted' | 'rejected' | 'unresolved' | 'needs-user'; reason: string }[]
}

export function parseDecision(text: string, openIds: string[] = []): Parsed<DecisionBlock> {
  const j = lastBlock(text, 'decision')
  if (!j.ok) return j
  const decision = str(j.value.decision)
  if (!decision) return { ok: false, error: 'team-decision.decision is empty' }
  const objections: NonNullable<DecisionBlock['objections']> = []
  if (j.value.objections !== undefined && !Array.isArray(j.value.objections)) return { ok: false, error: 'team-decision.objections must be an array' }
  for (const item of (j.value.objections ?? []) as unknown[]) {
    const r = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const id = str(r.id)
    const disposition = str(r.disposition)
    const reason = str(r.reason)
    if (!openIds.includes(id) || objections.some((o) => o.id === id)) return { ok: false, error: `unknown or duplicate objection ${id}` }
    if (!['accepted', 'rejected', 'unresolved', 'needs-user'].includes(disposition) || !reason) return { ok: false, error: `objection ${id} requires a disposition and reason` }
    objections.push({ id, disposition: disposition as typeof objections[number]['disposition'], reason })
  }
  const missing = openIds.filter((id) => !objections.some((o) => o.id === id))
  if (missing.length) return { ok: false, error: `team-decision must address objections: ${missing.join(', ')}` }
  return { ok: true, value: { decision, rationale: str(j.value.rationale), ...(objections.length ? { objections } : {}) } }
}

export interface ObjectionInput {
  claim: string
  reason: string
  severity: 'blocking' | 'advisory'
  basis: 'evidence' | 'hypothesis'
  citations: string[]
  proposal?: string
  truncated?: boolean
}

/** Keep the speaker's words; an invalid or oversized reply remains in chat for inspection. */
export function parseObjections(text: string): { items: ObjectionInput[]; invalid: number; overflow: number; error?: string } {
  const j = lastBlock(text, 'objections')
  if (!j.ok) return { items: [], invalid: 1, overflow: 0, error: j.error }
  if (!Array.isArray(j.value.items)) return { items: [], invalid: 1, overflow: 0, error: 'team-objections.items must be an array' }
  const items: ObjectionInput[] = []
  let invalid = 0
  for (const item of j.value.items.slice(0, 5)) {
    const r = typeof item === 'object' && item !== null ? item as Record<string, unknown> : {}
    const claim = str(r.claim), reason = str(r.reason), proposal = str(r.proposal)
    if (!claim || !reason) { invalid++; continue }
    const citations = strList(r.citations)
    const truncated = claim.length > 2000 || reason.length > 2000 || proposal.length > 2000 || citations.length > 8 || citations.some((c) => c.length > 1000)
    items.push({ claim: claim.slice(0, 2000), reason: reason.slice(0, 2000), severity: r.severity === 'blocking' ? 'blocking' : 'advisory', basis: r.basis === 'evidence' && citations.length ? 'evidence' : 'hypothesis', citations: citations.slice(0, 8).map((c) => c.slice(0, 1000)), ...(proposal ? { proposal: proposal.slice(0, 2000) } : {}), ...(truncated ? { truncated: true } : {}) })
  }
  return { items, invalid, overflow: Math.max(0, j.value.items.length - 5) }
}

export interface HandoffBlock {
  status: 'implemented' | 'blocked'
  summary: string
  artifacts: string[]
  evidence: string
  question?: string
  /** Verification tasks: every check that was run, with its result. */
  checks?: VerificationCheck[]
}

/** The checks of a verification handoff: [{"check":"…","result":"pass"|"fail","detail":"command / steps and what happened"}]. */
export function parseChecks(v: unknown): Parsed<VerificationCheck[]> {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, error: 'a verification task must list the checks it ran in "checks": [{"check":"…","result":"pass" or "fail","detail":"the command or steps and what happened"}]' }
  const out: VerificationCheck[] = []
  for (const [i, item] of v.entries()) {
    const r = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {}
    const check = str(r.check) || str(r.name)
    const result = str(r.result).toLowerCase()
    const detail = str(r.detail) || str(r.evidence)
    if (!check || (result !== 'pass' && result !== 'fail') || !detail) return { ok: false, error: `check ${i + 1} needs "check", "result" ("pass" or "fail") and "detail" (what was run and what happened)` }
    out.push({ check, result, detail })
  }
  return { ok: true, value: out }
}

/**
 * The owner's completion report for `taskId`. "implemented" requires evidence; for a verification
 * task (`requireChecks`) it also requires structured checks, so free-text evidence is not enough.
 */
export function parseHandoff(text: string, taskId: string, opts: { requireChecks?: boolean } = {}): Parsed<HandoffBlock> {
  const j = lastBlock(text, 'handoff')
  if (!j.ok) return j
  const task = str(j.value.task)
  if (task && task.toUpperCase() !== taskId.toUpperCase()) return { ok: false, error: `team-handoff is for ${task}, but this turn was ${taskId}` }
  const status = str(j.value.status).toLowerCase()
  if (status !== 'implemented' && status !== 'blocked') return { ok: false, error: 'team-handoff.status must be "implemented" or "blocked"' }
  const evidence = str(j.value.evidence)
  const summary = str(j.value.summary)
  if (status === 'implemented' && !evidence) return { ok: false, error: 'team-handoff says implemented but gives no evidence (what you ran or checked, and the result)' }
  const question = str(j.value.question)
  if (status === 'blocked' && !question && !summary) return { ok: false, error: 'team-handoff says blocked but does not say what is needed' }
  let checks: VerificationCheck[] | undefined
  if (opts.requireChecks && status === 'implemented') {
    const c = parseChecks(j.value.checks)
    if (!c.ok) return { ok: false, error: `team-handoff: ${c.error}` }
    checks = c.value
  }
  return { ok: true, value: { status, summary, artifacts: strList(j.value.artifacts), evidence, ...(question ? { question } : {}), ...(checks ? { checks } : {}) } }
}

export interface ReviewBlock {
  verdict: 'approve' | 'reject'
  findings: string[]
  evidence: string
}

/** A reviewer's verdict for `ref` (task id or FINAL). Rejections need findings, approvals need evidence. */
export function parseReview(text: string, ref: string): Parsed<ReviewBlock> {
  const j = lastBlock(text, 'review')
  if (!j.ok) return j
  const task = str(j.value.task)
  if (task && task.toUpperCase() !== ref.toUpperCase()) return { ok: false, error: `team-review is for ${task}, but this review was ${ref}` }
  const verdict = str(j.value.verdict).toLowerCase()
  if (verdict !== 'approve' && verdict !== 'reject') return { ok: false, error: 'team-review.verdict must be "approve" or "reject"' }
  const findings = strList(j.value.findings)
  const evidence = str(j.value.evidence)
  if (verdict === 'reject' && findings.length === 0) return { ok: false, error: 'team-review rejects but lists no findings' }
  if (verdict === 'approve' && !evidence) return { ok: false, error: 'team-review approves but gives no evidence of what was checked' }
  return { ok: true, value: { verdict, findings, evidence } }
}

export type TaskOp =
  | { op: 'create'; title: string; description: string; owner: string; reviewer?: string; dependsOn: string[]; acceptance: string[]; kind: TaskKind; tier: TaskTier }
  | { op: 'update'; task: string; title?: string; description?: string; owner?: string; reviewer?: string; dependsOn?: string[]; acceptance?: string[] }
  | { op: 'cancel'; task: string; reason: string }

/** Task changes the decision owner posts in chat. Invalid ops are reported, valid ones kept. */
export function parseTaskOps(text: string, members: Agent[]): { ops: TaskOp[]; errors: string[] } {
  const ops: TaskOp[] = []
  const errors: string[] = []
  for (const body of findBlocks(text, 'task')) {
    const j = parseJson(body, 'task')
    if (!j.ok) {
      errors.push(j.error)
      continue
    }
    const r = j.value
    const op = str(r.op).toLowerCase()
    const who = (field: string): string | undefined | null => {
      const ref = str(r[field])
      if (!ref) return undefined
      return resolveAgent(ref, members)?.id ?? null
    }
    if (op === 'create') {
      const owner = who('owner')
      const reviewer = who('reviewer')
      const title = str(r.title)
      const acceptance = strList(r.acceptance)
      if (!title || !owner || reviewer === null || acceptance.length === 0) {
        errors.push(`team-task create needs a title, a known owner and acceptance criteria${reviewer === null ? ' (unknown reviewer)' : ''}`)
        continue
      }
      ops.push({ op: 'create', title, description: str(r.description), owner, ...(reviewer ? { reviewer } : {}), dependsOn: strList(r.dependsOn), acceptance, kind: KINDS.includes(str(r.kind) as TaskKind) ? (str(r.kind) as TaskKind) : 'implement', tier: TIERS.includes(str(r.tier) as TaskTier) ? (str(r.tier) as TaskTier) : 'standard' })
    } else if (op === 'update') {
      const task = str(r.task)
      const owner = who('owner')
      const reviewer = who('reviewer')
      if (!task || owner === null || reviewer === null) {
        errors.push('team-task update needs a task id and known employees')
        continue
      }
      ops.push({
        op: 'update',
        task,
        ...(str(r.title) ? { title: str(r.title) } : {}),
        ...(str(r.description) ? { description: str(r.description) } : {}),
        ...(owner ? { owner } : {}),
        ...(reviewer ? { reviewer } : {}),
        ...(Array.isArray(r.dependsOn) ? { dependsOn: strList(r.dependsOn) } : {}),
        ...(Array.isArray(r.acceptance) ? { acceptance: strList(r.acceptance) } : {}),
      })
    } else if (op === 'cancel') {
      const task = str(r.task)
      if (!task) {
        errors.push('team-task cancel needs a task id')
        continue
      }
      ops.push({ op: 'cancel', task, reason: str(r.reason) || 'cancelled by the decision owner' })
    } else {
      errors.push(`team-task.op must be create, update or cancel (got "${op}")`)
    }
  }
  return { ops, errors }
}
