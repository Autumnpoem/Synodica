import { existsSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { canonicalPath, isInside, isSymlink, overlaps, writeNoFollow } from './paths.js'
import type { Project } from '../shared/types.js'

export type ProjectCommand = { name: 'kickoff' | 'critique' | 'start'; rest: string }

/** /kickoff <request>, /critique, /start (alias /continue) at the start of a project-chat message. */
export function parseCommand(text: string): ProjectCommand | null {
  const m = /^\/(kickoff|critique|start|continue)\b\s*([\s\S]*)$/i.exec(text.trim())
  if (!m) return null
  const name = (m[1] ?? '').toLowerCase()
  return { name: name === 'continue' ? 'start' : (name as ProjectCommand['name']), rest: (m[2] ?? '').trim() }
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'project'
  )
}

/** A fresh folder outside the app for a new project. */
export function suggestWorkspace(name: string, base = path.join(os.homedir(), 'Synodica-projects')): string {
  const slug = slugify(name)
  let candidate = path.join(base, slug)
  let n = 2
  while (existsSync(candidate)) candidate = path.join(base, `${slug}-${n++}`)
  return candidate
}

/** Folders a project may never live in or contain (real paths). Temp folders stay allowed. */
function systemAreas(): string[] {
  if (process.platform === 'win32') {
    return [process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  const unix = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/boot', '/dev', '/proc', '/sys', '/run', '/root','/var/lib', '/var/log', '/var/spool']
  return process.platform === 'darwin' ? [...unix, '/System', '/Library', '/Applications', '/private/etc', '/private/var/db', '/cores'] : unix
}

export interface WorkspaceRules {
  /** The Synodica checkout. */
  appRoot: string
  /** Extra folders that must not overlap a workspace (the data folder, the team file's folder…). */
  denied?: string[]
  /** For tests; defaults to the real home folder. */
  home?: string
}

/**
 * Why a workspace path is unsafe, or undefined when it is fine. Compares *real* paths: symlinks in
 * every existing component are resolved (for a new folder, the nearest existing parent decides),
 * so a link that points into the checkout, home or a system area is caught.
 */
export function workspaceProblem(abs: string, rules: WorkspaceRules): string | undefined {
  const real = canonicalPath(abs)
  const app = canonicalPath(rules.appRoot)
  const home = canonicalPath(rules.home ?? os.homedir())
  if (isInside(real, app)) return 'pick a folder outside the Synodica app folder, so the team never edits the app itself'
  if (isInside(app, real)) return 'that folder contains the Synodica app; pick a dedicated project folder'
  if (real === path.parse(real).root || isInside(home, real)) return 'pick a dedicated project folder, not your home folder or the disk root'
  // Hidden folders in home hold credentials and tool settings (.ssh, .aws, .config, .claude…).
  if (isInside(real, home) && (path.relative(home, real).split(path.sep)[0] ?? '').startsWith('.')) return 'pick a folder outside the hidden settings folders in your home folder'
  for (const area of systemAreas()) {
    const a = canonicalPath(area)
    if (overlaps(real, a)) return `pick a folder outside the system folder ${a}`
  }
  for (const d of rules.denied ?? []) {
    if (overlaps(real, canonicalPath(d))) return 'that folder overlaps Synodica’s own data; pick a dedicated project folder'
  }
  return undefined
}

/**
 * Validate (and create) a project workspace. Refuses the Synodica checkout itself, anything
 * inside it, any folder that contains it, the home folder, hidden home folders, system folders and
 * the filesystem root, all compared by real path after resolving symlinks. Returns the real path.
 */
export function checkWorkspace(input: string, appRoot: string | WorkspaceRules): { ok: true; path: string } | { ok: false; error: string } {
  const rules: WorkspaceRules = typeof appRoot === 'string' ? { appRoot } : appRoot
  const raw = input.trim().replace(/^~(?=$|[\\/])/, os.homedir())
  if (!raw) return { ok: false, error: 'pick a folder for the project' }
  if (!path.isAbsolute(raw)) return { ok: false, error: 'the project folder must be an absolute path' }
  const problem = workspaceProblem(path.resolve(raw), rules)
  if (problem) return { ok: false, error: problem }
  const real = canonicalPath(raw)
  try {
    if (existsSync(real) && !statSync(real).isDirectory()) return { ok: false, error: 'that path is a file, not a folder' }
    // Create the canonical path, so no symlinked parent is followed while creating it.
    mkdirSync(real, { recursive: true })
  } catch (err) {
    return { ok: false, error: `could not create the folder: ${err instanceof Error ? err.message : String(err)}` }
  }
  if (canonicalPath(real) !== real) return { ok: false, error: 'the folder changed while it was being created; try again' }
  return { ok: true, path: real }
}

/**
 * Mirror the shared project files into <workspace>/.opengrokbot/ without following symlinks: the
 * workspace must still pass the safety rules by real path, and neither the .opengrokbot folder nor
 * any file in it may be a symlink. Returns the files written; throws with the reason otherwise.
 */
export function writeProjectFiles(p: Project, name: (id: string) => string, rules: WorkspaceRules): string[] {
  if (!existsSync(p.workspace)) return []
  const problem = workspaceProblem(p.workspace, rules)
  if (problem) throw new Error(`refusing to write shared notes: ${problem}`)
  const dir = path.join(realpathSync.native(p.workspace), '.opengrokbot')
  if (isSymlink(dir)) throw new Error(`refusing to write shared notes: ${dir} is a symbolic link`)
  if (!existsSync(dir)) mkdirSync(dir)
  if (!lstatSync(dir).isDirectory()) throw new Error(`refusing to write shared notes: ${dir} is not a folder`)
  const written: string[] = []
  for (const [file, body] of Object.entries(projectFiles(p, name))) {
    const target = path.join(dir, file)
    if (isSymlink(target)) throw new Error(`refusing to write shared notes: ${target} is a symbolic link`)
    writeNoFollow(target, body)
    written.push(target)
  }
  return written
}

/** Markdown mirrors of the shared project state, written to <workspace>/.opengrokbot/. */
export function projectFiles(p: Project, name: (id: string) => string): Record<string, string> {
  const brief = `# ${p.name}\n\n${p.brief || '(no brief yet)'}\n${p.plan ? `\n## Plan\n\n${p.plan.summary}\n\n**Architecture:** ${p.plan.architecture || '(not stated)'}\n` : ''}`
  const decisions = `# Decisions\n\n${p.decisions.map((d) => `- ${new Date(d.at).toISOString()} — **${d.decision}** (${name(d.by)})${d.rationale ? `\n  - Why: ${d.rationale}` : ''}`).join('\n') || '(none yet)'}\n${p.critiques.length ? `\n## Critiques\n\n${p.critiques.map((c) => `- ${name(c.by)}: ${c.verdict}${c.issues.length ? `\n  - ${c.issues.join('\n  - ')}` : ''}`).join('\n')}\n` : ''}`
  const tasks = `# Task board\n\n${
    p.tasks
      .map(
        (t) =>
          `## ${t.id} · ${t.title} — ${t.state}\n\n- Owner: ${name(t.ownerId)} · Reviewer: ${t.reviewerId ? name(t.reviewerId) : 'none'} · Attempts: ${t.attempts}/${t.maxAttempts}${t.dependsOn.length ? ` · After: ${t.dependsOn.join(', ')}` : ''}\n- Acceptance:\n${t.acceptance.map((a) => `  - ${a}`).join('\n')}${t.summary ? `\n- Handoff: ${t.summary}` : ''}${t.evidence ? `\n- Evidence: ${t.evidence}` : ''}${t.artifacts.length ? `\n- Files: ${t.artifacts.join(', ')}` : ''}${t.reviews.length ? `\n- Reviews:\n${t.reviews.map((r) => `  - ${r.verdict} by ${name(r.reviewerId)}${r.findings.length ? `: ${r.findings.join('; ')}` : ''}`).join('\n')}` : ''}${t.reason ? `\n- Note: ${t.reason}` : ''}\n`,
      )
      .join('\n') || '(no tasks yet)'
  }`
  return { 'brief.md': brief, 'decisions.md': decisions, 'tasks.md': tasks }
}
