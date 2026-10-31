import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { oneShot } from './providers/oneshot.js'
import type { Agent, Message, ProviderDef, Team } from '../shared/types.js'

const MAX_CHARS = 4000

export type MemoryCall = (provider: ProviderDef, model: string, system: string, prompt: string, signal: AbortSignal, cwd: string) => Promise<string>

const defaultCall: MemoryCall = (provider, model, system, prompt, signal, cwd) => oneShot({ provider, model, system, prompt, signal, cwd })

/**
 * Long-term notes per employee, kept as small markdown files and injected into their system
 * prompt. Scopes keep projects apart: ordinary chats use memory/<agent>.md (the file older
 * versions wrote, untouched), each project uses memory/projects/<projectId>/<agent>.md.
 * The background rewrite runs only when a memory helper model is configured in Settings.
 */
export class Memory {
  private readonly dir: string
  private readonly busy = new Set<string>()

  constructor(
    dataDir: string,
    private readonly call: MemoryCall = defaultCall,
  ) {
    this.dir = path.join(dataDir, 'memory')
    mkdirSync(this.dir, { recursive: true })
  }

  file(agentId: string, projectId?: string): string {
    if (!projectId) return path.join(this.dir, `${agentId}.md`)
    return path.join(this.dir, 'projects', projectId.replace(/[^a-z0-9_-]/gi, ''), `${agentId}.md`)
  }

  read(agentId: string, projectId?: string): string {
    const f = this.file(agentId, projectId)
    return existsSync(f) ? readFileSync(f, 'utf8') : ''
  }

  write(agentId: string, text: string, projectId?: string): void {
    const f = this.file(agentId, projectId)
    mkdirSync(path.dirname(f), { recursive: true })
    const tmp = `${f}.tmp`
    writeFileSync(tmp, text.trim().slice(0, MAX_CHARS * 2))
    renameSync(tmp, f)
  }

  clear(agentId: string, projectId?: string): void {
    const f = this.file(agentId, projectId)
    if (existsSync(f)) unlinkSync(f)
  }

  /**
   * Fold the messages of a finished round into the employee's notes for that scope. At most one
   * update per employee and scope at a time; errors are swallowed because memory is best effort.
   */
  async update(team: Team, agent: Agent, recent: Message[], projectId?: string): Promise<void> {
    const helper = team.settings.memory
    if (!helper || helper.mode !== 'model') return
    const provider = team.providers[helper.provider]
    if (!provider) return
    const key = `${projectId ?? ''}/${agent.id}`
    if (this.busy.has(key) || recent.length === 0) return
    this.busy.add(key)
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), 60_000)
    try {
      const names = new Map<string, string>([['user', team.owner.name]])
      for (const a of team.agents) names.set(a.id, a.name)
      const transcript = recent
        .filter((m) => m.status === 'done' && m.text.trim())
        .map((m) => `[${names.get(m.authorId) ?? m.authorId}]: ${m.text.replace(/\s+/g, ' ').slice(0, 600)}`)
        .join('\n')
      const current = this.read(agent.id, projectId)
      const prompt = `Current notes of ${agent.name} (${agent.role}):\n${current || '(empty)'}\n\nNew conversation excerpt:\n${transcript}\n\nRewrite the notes.`
      const system = `You maintain the long-term working notes of one employee at ${team.company}${projectId ? ' for one project only' : ''}. Keep only durable facts worth remembering: the boss's stable preferences and decisions, project facts (names, paths, URLs, stack), commitments this employee made, open threads they own, and lessons from mistakes. Drop chit-chat, one-off details and anything already stale. Write terse markdown bullets under short headings, at most ${MAX_CHARS} characters, in the language the notes are already in (English if empty). Output only the notes.`
      const out = (await this.call(provider, helper.model, system, prompt, abort.signal, team.workspace)).trim()
      if (out && out !== current.trim()) this.write(agent.id, out, projectId)
    } catch {
      // best effort
    } finally {
      clearTimeout(timer)
      this.busy.delete(key)
    }
  }
}
