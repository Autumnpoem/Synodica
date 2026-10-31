import { randomUUID } from 'node:crypto'
import { canonicalPath, overlaps } from './paths.js'
import type { Agent } from '../shared/types.js'

const WRITE_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit']

/** Whether an employee's tools can change files (MCP servers count too: they can do anything). */
export function canWrite(agent: Agent): boolean {
  return agent.tools.some((t) => WRITE_TOOLS.includes(t)) || agent.mcpServers.length > 0
}

/** Who holds a writer lock, in words for the chat and the board. */
export interface LockHolder {
  /** Project id, or the conversation id for a chat turn outside the workflow. */
  owner: string
  /** e.g. "T-3 (work) in Shop" or "chat in #general". */
  label: string
}

interface Held extends LockHolder {
  token: string
  root: string
}

export type Acquired = { ok: true; release: () => void; root: string } | { ok: false; holder: LockHolder; root: string }

/**
 * One writer per folder tree, shared by workflow turns and chat turns in every conversation.
 * Folders are compared by real path, so symlink aliases are the same folder, and a folder
 * overlaps its ancestors and descendants (a writer in /p blocks one in /p/src and vice versa).
 * A refused acquisition never displaces the holder and is never queued here; callers decide.
 */
export class WorkspaceLocks {
  private readonly held = new Map<string, Held>()
  private readonly listeners = new Set<() => void>()

  /** The holder that a writer in `folder` would conflict with, if any. */
  conflict(folder: string): LockHolder | undefined {
    const root = canonicalPath(folder)
    for (const h of this.held.values()) if (overlaps(h.root, root)) return { owner: h.owner, label: h.label }
    return undefined
  }

  acquire(folder: string, holder: LockHolder): Acquired {
    const root = canonicalPath(folder)
    const busy = this.conflict(root)
    if (busy) return { ok: false, holder: busy, root }
    const token = randomUUID()
    this.held.set(token, { ...holder, token, root })
    let released = false
    return {
      ok: true,
      root,
      release: () => {
        if (released) return
        released = true
        this.held.delete(token)
        for (const fn of this.listeners) fn()
      },
    }
  }

  /** Called after every release (the workflow re-checks waiting work). */
  onRelease(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  list(): (LockHolder & { root: string })[] {
    return [...this.held.values()].map(({ owner, label, root }) => ({ owner, label, root }))
  }
}
