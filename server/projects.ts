import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Project, Task } from '../shared/types.js'

/** States in which a provider operation may have been in flight. */
const IN_FLIGHT: Task['state'][] = ['running', 'reviewing']

/**
 * Projects with their tasks and runs, one JSON file each under data/projects. Writes are atomic
 * (tmp + rename). On load, anything that was mid-run when the server died is marked interrupted:
 * it is never re-executed automatically, because the provider may already have changed files.
 */
export class ProjectStore {
  private readonly dir: string
  private readonly projects = new Map<string, Project>()
  /** What load() had to repair, for the startup log and tests. */
  readonly recovered: string[] = []

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'projects')
    mkdirSync(this.dir, { recursive: true })
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.json')) continue
      try {
        const p = normalize(JSON.parse(readFileSync(path.join(this.dir, f), 'utf8')) as Project)
        if (recover(p, Date.now())) {
          this.recovered.push(p.id)
          this.flush(p)
        }
        this.projects.set(p.id, p)
      } catch (err) {
        console.warn(`[projects] skipping unreadable ${f}:`, err)
      }
    }
  }

  list(): Project[] {
    return [...this.projects.values()].sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string): Project | undefined {
    return this.projects.get(id)
  }

  byConversation(conversationId: string): Project | undefined {
    for (const p of this.projects.values()) if (p.conversationId === conversationId) return p
    return undefined
  }

  add(project: Project): void {
    if (this.projects.has(project.id)) throw new Error(`project ${project.id} already exists`)
    this.projects.set(project.id, project)
    this.flush(project)
  }

  /** Mutate a project in place and persist it. Returns the project. */
  update(id: string, fn: (p: Project) => void): Project {
    const p = this.projects.get(id)
    if (!p) throw new Error(`unknown project ${id}`)
    fn(p)
    p.updatedAt = Date.now()
    this.flush(p)
    return p
  }

  private flush(p: Project): void {
    const file = path.join(this.dir, `${p.id}.json`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(p, null, 2))
    renameSync(tmp, file)
  }

  /** Where a project file lives (tests and docs). */
  fileOf(id: string): string {
    return path.join(this.dir, `${id}.json`)
  }
}

/** Fill fields that older or hand-edited files may lack. */
function normalize(p: Project): Project {
  p.critiques ??= []
  p.decisions ??= []
  p.tasks ??= []
  p.runs ??= []
  p.paused ??= false
  p.finalReviews ??= 0
  p.nextTaskNumber ??= p.tasks.length + 1
  p.corrections ??= []
  p.discussions ??= []
  p.objections ??= []
  p.planEpoch ??= 0
  p.nextObjectionNumber ??= Math.max(0, ...p.objections.map((o) => Number(o.id.slice(2)) || 0)) + 1
  for (const t of p.tasks) {
    t.dependsOn ??= []
    t.acceptance ??= []
    t.artifacts ??= []
    t.reviews ??= []
    t.history ??= []
    t.attempts ??= 0
    t.maxAttempts ??= 3
  }
  return p
}

/** Mark in-flight runs and tasks interrupted. Exported for tests. Returns whether anything changed. */
export function recover(p: Project, now: number): boolean {
  let changed = false
  for (const round of p.discussions ?? []) {
    if (round.status !== 'running') continue
    round.status = 'stopped'
    for (const person of round.participants) if (person.status === 'pending') {
      person.status = 'stopped'
      person.reason = 'Interrupted by a server restart.'
    }
    changed = true
  }
  for (const r of p.runs) {
    if (r.status !== 'running') continue
    r.status = 'interrupted'
    r.endedAt = now
    r.error = 'The server stopped while this run was in progress.'
    changed = true
  }
  for (const t of p.tasks) {
    if (!IN_FLIGHT.includes(t.state)) continue
    t.resumeTo = t.state === 'reviewing' ? 'implemented' : 'ready'
    t.state = 'interrupted'
    t.reason = t.resumeTo === 'implemented' ? 'Review was interrupted by a restart. Resume re-runs the review.' : 'Work was interrupted by a restart. Check the workspace, then Resume to let the owner continue.'
    t.history.push({ at: now, by: 'workflow', text: 'Interrupted by a server restart.' })
    t.updatedAt = now
    changed = true
  }
  // A correction that was not applied before the restart stays: it is part of the project context and
  // of its task's requirements, and nothing waits on old work, but nothing continues until you Resume.
  for (const c of p.corrections ?? []) {
    if (c.status !== 'stopping' && c.status !== 'stopped') continue
    c.status = 'pending-restart'
    const t = c.interrupted ? p.tasks.find((x) => x.id === c.interrupted) : undefined
    if (t && !(t.corrections ?? []).some((x) => x.id === c.id)) {
      t.corrections = [...(t.corrections ?? []), { id: c.id, at: c.at, text: c.text }]
      t.history.push({ at: now, by: 'user', text: `Correction (saved before a restart): ${c.text}` })
    }
    p.paused = true
    changed = true
  }
  if (p.phase === 'planning' || p.phase === 'final-review') {
    p.pendingStep = p.phase === 'final-review' ? 'final-review' : (p.pendingStep ?? 'plan')
    p.phase = 'needs-attention'
    p.reason = 'A planning or review step was interrupted by a restart. Resume re-runs it.'
    changed = true
  }
  return changed
}
