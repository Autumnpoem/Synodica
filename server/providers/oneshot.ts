import { claudeEnv } from './claude-env.js'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { runCli } from './cli.js'
import type { ProviderDef } from '../../shared/types.js'

export interface OneShotRequest {
  provider: ProviderDef
  model: string
  system: string
  prompt: string
  signal: AbortSignal
  /** Folder the CLI runs in. Helpers get no tools and never write. */
  cwd: string
}


/**
 * A single tool-less completion on whichever provider the team configured for an internal
 * helper (router, memory). Throws with a readable message on failure; callers fall back.
 */
export async function oneShot(req: OneShotRequest): Promise<string> {
  const { provider, model, system, prompt, signal, cwd } = req
  switch (provider.kind) {
    case 'claude': {
      const abort = new AbortController()
      const onAbort = (): void => abort.abort()
      signal.addEventListener('abort', onAbort, { once: true })
      let text = ''
      let error: string | undefined
      try {
        const q = query({ prompt, options: { model, systemPrompt: system, tools: [], allowedTools: [], permissionMode: 'dontAsk', settingSources: [], maxTurns: 1, env: claudeEnv(provider), abortController: abort, cwd } })
        for await (const msg of q) {
          if (msg.type !== 'result') continue
          if (msg.subtype === 'success') text = msg.result
          else error = `Claude helper ended: ${msg.subtype}`
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      if (error) throw new Error(error)
      return text
    }
    case 'openai': {
      if (!provider.baseUrl) throw new Error(`${provider.label} has no base URL`)
      const res = await fetch(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey ?? 'none'}` },
        body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: false }),
        signal,
      })
      const body = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string | null } }[]; error?: { message?: string } }
      if (!res.ok) throw new Error(`${provider.label} returned HTTP ${res.status}${body.error?.message ? `: ${body.error.message}` : ''}`)
      return body.choices?.[0]?.message?.content ?? ''
    }
    case 'codex': {
      const env: NodeJS.ProcessEnv = { ...process.env }
      if (provider.apiKey) env.OPENAI_API_KEY = provider.apiKey
      else delete env.OPENAI_API_KEY
      const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd, '-s', 'read-only', ...(model && model !== 'default' ? ['-m', model] : []), '-']
      let text = ''
      const run = await runCli('codex', args, {
        cwd,
        env,
        stdin: `<system>\n${system}\n</system>\n\n${prompt}`,
        signal,
        onLine: (line) => {
          if (!line.startsWith('{')) return
          try {
            const ev = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } }
            if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && ev.item.text) text += ev.item.text
          } catch {
            // not a JSON event line
          }
        },
      })
      if (run.exitCode !== 0 && !text) throw new Error(run.stderr.trim().split('\n').slice(-2).join(' ') || `codex exited with code ${run.exitCode}`)
      return text
    }
    case 'gemini': {
      const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
      if (provider.apiKey) env.GEMINI_API_KEY = provider.apiKey
      const args = ['--output-format', 'json', '--approval-mode', 'default', ...(model && model !== 'default' ? ['-m', model] : [])]
      const run = await runCli('gemini', args, { cwd, env, stdin: `<system>\n${system}\n</system>\n\n${prompt}`, signal })
      const start = run.stdout.lastIndexOf('\n{')
      const doc = start === -1 ? run.stdout.trim() : run.stdout.slice(start + 1).trim()
      try {
        const parsed = JSON.parse(doc) as { response?: string }
        return parsed.response ?? ''
      } catch {
        throw new Error(run.stderr.trim().split('\n').slice(-2).join(' ') || `gemini exited with code ${run.exitCode}`)
      }
    }
  }
}
