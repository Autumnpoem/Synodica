import { spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { canonicalPath, confine, isInside, writeNoFollow } from '../paths.js'
import { LOCAL_TOOLS, type LocalTool } from './localtools.js'

/**
 * Executes the API employees' local tools (definitions in localtools.ts). Confinement is by real
 * path: a symlinked file, or a symlinked parent folder, that leads outside the working folder is
 * refused for reads, writes, edits, listings and searches, and new files are created only under a
 * real parent inside the folder. run_command is a plain shell whose cwd is the folder; it is NOT a
 * sandbox, so project (safe) turns and read-only turns never get it.
 */
export interface LocalToolPolicy {
  /** Ordinary chats with permission bypass in the profile: no folder confinement (previous behaviour). */
  allowOutside: boolean
  /** run_command may run. */
  shell: boolean
  /** Review / planning turns: write_file and edit_file are refused as well. */
  readOnly: boolean
}

const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'run_command'])
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo'])

/** The tools a turn is offered under a policy. */
export function allowedLocalTools(claudeTools: string[], policy: Pick<LocalToolPolicy, 'shell' | 'readOnly'>): LocalTool[] {
  return LOCAL_TOOLS.filter((t) => claudeTools.includes(t.claudeName) && (policy.shell || t.name !== 'run_command') && (!policy.readOnly || !WRITE_TOOLS.has(t.name)))
}

function resolve(cwd: string, p: string, policy: LocalToolPolicy): string {
  return policy.allowOutside ? path.resolve(cwd, p) : confine(cwd, p)
}

function globToRegex(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if (c && /[.+^${}()|[\]\\]/.test(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`)
}

/**
 * Visit files under `root`. When confined, symlinked folders are never entered and a symlinked
 * file is visited (at its real path) only if it really lies inside `confineTo`.
 */
function walk(root: string, max: number, visit: (abs: string, rel: string) => boolean, confineTo: string | undefined): void {
  let count = 0
  const stack = [root]
  while (stack.length > 0 && count < max) {
    const dir = stack.pop()
    if (!dir) break
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (SKIP_DIRS.has(name)) continue
      const abs = path.join(dir, name)
      let target = abs
      let st
      try {
        st = lstatSync(abs)
        if (st.isSymbolicLink()) {
          st = statSync(abs)
          if (confineTo !== undefined) {
            if (st.isDirectory()) continue
            target = realpathSync.native(abs)
            if (!isInside(target, confineTo)) continue
          }
        }
      } catch {
        continue
      }
      if (st.isDirectory()) stack.push(abs)
      else if (st.isFile()) {
        if (visit(target, path.relative(root, abs).split(path.sep).join('/'))) count++
        if (count >= max) return
      }
    }
  }
}

/** Run one tool call. Refusals and failures come back as an "Error: …" result for the model, never as a throw. */
export async function runLocalTool(name: string, args: Record<string, unknown>, cwd: string, policy: LocalToolPolicy, signal: AbortSignal): Promise<string> {
  try {
    return await execute(name, args, cwd, policy, signal)
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function execute(name: string, args: Record<string, unknown>, cwd: string, policy: LocalToolPolicy, signal: AbortSignal): Promise<string> {
  const s =(k: string): string => (typeof args[k] === 'string' ? (args[k] as string) : '')
  if (policy.readOnly && WRITE_TOOLS.has(name)) return `Error: ${name} is not available in this read-only step.`
  if (name === 'run_command' && !policy.shell) return 'Error: run_command is disabled here. API employees have no OS sandbox, so project and review turns cannot run shell commands.'
  const confineTo = policy.allowOutside ? undefined : canonicalPath(cwd)
  switch (name) {
    case 'read_file': {
      const abs = resolve(cwd, s('path'), policy)
      if (!existsSync(abs)) return `Error: file not found: ${s('path')}`
      const lines = readFileSync(abs, 'utf8').split('\n')
      const offset = typeof args.offset === 'number' ? Math.max(0, args.offset) : 0
      const slice = lines.slice(offset, offset + 400)
      const more = lines.length > offset + 400 ? `\n… ${lines.length - offset - 400} more lines (use offset=${offset + 400})` : ''
      return slice.map((l, i) => `${offset + i + 1}\t${l}`).join('\n') + more
    }
    case 'list_files': {
      const re = globToRegex(s('pattern').replace(/\\/g, '/').replace(/^\.\//, ''))
      const out: string[] = []
      walk(
        confineTo ?? cwd,
        5000,
        (_abs, rel) => {
          if (!re.test(rel)) return false
          out.push(rel)
          return true
        },
        confineTo,
      )
      return out.length > 0 ? out.slice(0, 300).join('\n') : 'No files matched.'
    }
    case 'search_files': {
      let re: RegExp
      try {
        re = new RegExp(s('pattern'), 'i')
      } catch (err) {
        return `Error: invalid regex: ${err instanceof Error ? err.message : String(err)}`
      }
      const base = confineTo ?? cwd
      const root = s('path') ? resolve(cwd, s('path'), policy) : base
      const out: string[] = []
      const scan = (abs: string, rel: string): boolean => {
        let content: string
        try {
          if (statSync(abs).size > 1_500_000) return false
          content = readFileSync(abs, 'utf8')
        } catch {
          return false
        }
        if (content.includes('\0')) return false
        const lines = content.split('\n')
        let hit = false
        for (let i = 0; i < lines.length && out.length < 200; i++) {
          const line = lines[i] ?? ''
          if (re.test(line)) {
            out.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
            hit = true
          }
        }
        return hit
      }
      if (existsSync(root) && statSync(root).isFile()) scan(root, path.relative(base, root))
      else walk(root, 4000, (abs, rel) => scan(abs, rel), confineTo)
      return out.length > 0 ? out.join('\n') : 'No matches.'
    }
    case 'run_command': {
      return new Promise((done) => {
        const child = spawn(s('command'), { cwd, shell: true, windowsHide: true })
        let out = ''
        const cap = (chunk: Buffer) => {
          if (out.length < 60_000) out += chunk.toString('utf8')
        }
        child.stdout.on('data', cap)
        child.stderr.on('data', cap)
        const timer = setTimeout(() => child.kill(), 120_000)
        const onAbort = () => child.kill()
        signal.addEventListener('abort', onAbort, { once: true })
        child.on('close', (code) => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          done(`${out.trim()}\n(exit code ${code})`.trim())
        })
        child.on('error', (err) => done(`Error: ${err.message}`))
      })
    }
    case 'write_file': {
      const abs = resolve(cwd, s('path'), policy)
      mkdirSync(path.dirname(abs), { recursive: true })
      // The parent was just created from a canonical path; check again before writing into it.
      if (!policy.allowOutside && resolve(cwd, s('path'), policy) !== abs) return `Error: the folder for ${s('path')} changed while writing; nothing was written.`
      writeNoFollow(abs, s('content'))
      return `Wrote ${s('path')} (${s('content').length} chars).`
    }
    case 'edit_file': {
      const abs = resolve(cwd, s('path'), policy)
      if (!existsSync(abs)) return `Error: file not found: ${s('path')}`
      const content = readFileSync(abs, 'utf8')
      const first = content.indexOf(s('old_text'))
      if (first === -1) return 'Error: old_text not found in the file.'
      if (content.indexOf(s('old_text'), first + 1) !== -1) return 'Error: old_text occurs more than once; include more context.'
      writeNoFollow(abs, content.slice(0, first) + s('new_text') + content.slice(first + s('old_text').length))
      return `Edited ${s('path')}.`
    }
    case 'fetch_url': {
      const res = await fetch(s('url'), { signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]), headers: { 'user-agent': 'Synodica/1.0' } })
      const body = await res.text()
      const text = body
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      return `HTTP ${res.status}\n${text.slice(0, 30_000)}`
    }
    default:
      return `Error: unknown tool ${name}`
  }
}
