import { buildSystemPrompt, buildTurnPrompt, stripSkip } from '../prompt.js'
import { imageReply, imageSupport, isImageUnsupportedError, stageImages, turnImages, type TurnImage } from '../attachments.js'
import { providerModels } from '../provider-models.js'
import { runCli } from './cli.js'
import { emptyUsage, mayBypass, turnCwd, type RunTurnParams, type TurnResult } from './types.js'

const EFFORT: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' }

interface CodexEvent {
  type: string
  thread_id?: string
  item?: { type: string; text?: string; command?: string; changes?: unknown[]; query?: string; status?: string }
  usage?: { input_tokens?: number; cached_input_tokens?: number; cache_write_input_tokens?: number; output_tokens?: number }
  error?: { message?: string }
  message?: string
}

export function sandboxFor(tools: string[], autoApprove: boolean, readOnly = false): string {
  // Review / planning steps: Codex's OS sandbox lets commands read and run, but not write.
  if (readOnly) return 'read-only'
  if (autoApprove) return 'danger-full-access'
  return tools.some((t) => ['Edit', 'Write', 'Bash'].includes(t)) ? 'workspace-write' : 'read-only'
}

/** Put each -i after the stdin prompt marker; older CLI parsers can consume a preceding prompt. */
export function codexExecArgs(common: string[], sessionId: string | undefined, images: TurnImage[]): string[] {
  return sessionId
    ? ['exec', ...common, 'resume', sessionId, '-', ...images.flatMap((image) => ['-i', image.path])]
    : ['exec', ...common, '-', ...images.flatMap((image) => ['-i', image.path])]
}

/** OpenAI Codex CLI in headless mode. Uses `codex login` (ChatGPT subscription) unless the provider has an API key. */
export async function runCodexTurn(params: RunTurnParams): Promise<TurnResult> {
  const { team, conversation, agent, provider, sessionId, signal, handlers, note, notes, context } = params
  const selected = turnImages(conversation, agent, params.resolveAttachment, params.inputMessageId)
  if (selected.problem) return { text: imageReply(team, conversation, 'unreadable') }
  if (selected.images.length > 0 && imageSupport(provider, agent.model, providerModels.inputModalities(agent.provider, provider, agent.model)) === 'unsupported') return { text: imageReply(team, conversation, 'unsupported') }
  let staged: ReturnType<typeof stageImages> | undefined
  try { if (selected.images.some((image) => image.path.includes(','))) staged = stageImages(selected.images) }
  catch { return { text: imageReply(team, conversation, 'unreadable') } }
  const started = Date.now()
  const cwd = turnCwd(params)
  const bypass = mayBypass(params) && !params.readOnly
  const common = ['--json', '--skip-git-repo-check', '-C', cwd, ...(agent.model && agent.model !== 'default' ? ['-m', agent.model] : []), '-s', sandboxFor(agent.tools, bypass, params.readOnly === true), '-c', `model_reasoning_effort="${EFFORT[agent.effort] ?? 'medium'}"`]
  if (bypass) common.push('--dangerously-bypass-approvals-and-sandbox')
  const images = staged ? selected.images.map((image, index) => ({ ...image, path: staged.paths[index]! })) : selected.images
  const args = codexExecArgs(common, sessionId, images)

  // Codex has no system-prompt flag: the persona rides in the first prompt of the thread; project
  // context changes over time, so it rides along on every turn.
  const transcript = buildTurnPrompt(team, conversation, agent, sessionId !== undefined, note, params.inputMessageId)
  const ctx = sessionId && context ? `<project-context>\n${context}\n</project-context>\n\n` : ''
  const stdin = sessionId ? `${ctx}${transcript}` : `<system>\n${buildSystemPrompt(team, conversation, agent, '', notes ?? '', context ?? '')}\n</system>\n\n${transcript}`

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (provider.apiKey) env.OPENAI_API_KEY = provider.apiKey
  else delete env.OPENAI_API_KEY

  let text = ''
  let session: string | undefined
  let error: string | undefined
  const usage = emptyUsage(agent.model)

  let run: Awaited<ReturnType<typeof runCli>>
  try { run = await runCli('codex', args, {
    cwd,
    env,
    stdin,
    signal,
    onLine: (line) => {
      if (!line.startsWith('{')) return
      let ev: CodexEvent
      try {
        ev = JSON.parse(line) as CodexEvent
      } catch {
        return
      }
      if (ev.type === 'thread.started' && ev.thread_id) {
        session = ev.thread_id
        handlers.onSession(session)
      } else if (ev.type === 'item.completed' && ev.item) {
        const item = ev.item
        if (item.type === 'agent_message' && item.text) {
          const chunk = (text.length > 0 ? '\n\n' : '') + item.text
          text += chunk
          handlers.onDelta(chunk)
        } else if (item.type === 'command_execution' && item.command) {
          handlers.onActivity(`Bash ${item.command}`.slice(0, 160))
        } else if (item.type === 'file_change') {
          handlers.onActivity(`Edited ${Array.isArray(item.changes) ? item.changes.length : ''} file(s)`.trim())
        } else if (item.type === 'web_search' && item.query) {
          handlers.onActivity(`Searching the web: ${item.query}`)
        }
      } else if (ev.type === 'item.started' && ev.item?.type === 'command_execution' && ev.item.command) {
        handlers.onActivity(`Bash ${ev.item.command}`.slice(0, 160))
      } else if (ev.type === 'turn.completed' && ev.usage) {
        usage.inputTokens = ev.usage.input_tokens ?? 0
        usage.cacheReadTokens = ev.usage.cached_input_tokens ?? 0
        usage.cacheCreationTokens = ev.usage.cache_write_input_tokens ?? 0
        usage.outputTokens = ev.usage.output_tokens ?? 0
      } else if (ev.type === 'turn.failed' || ev.type === 'error') {
        error = ev.error?.message ?? ev.message ?? 'Codex reported an error.'
      }
    },
  }) } finally { staged?.cleanup() }

  usage.durationMs = Date.now() - started
  if (run.aborted) error = 'Stopped.'
  else if (run.exitCode !== 0 && !error) {
    const tail = run.stderr.trim().split('\n').slice(-3).join(' ').trim()
    error = tail || `codex exited with code ${run.exitCode}`
    if (/not logged in|login|auth/i.test(tail) && !/logged in using/i.test(tail)) error = `Codex is not logged in. Run \`codex login\` in a terminal. (${tail})`
  }

  if (selected.images.length > 0 && error && isImageUnsupportedError(error)) return { text: imageReply(team, conversation, 'unsupported') }

  const out: TurnResult = { text: error ? text.trim() : stripSkip(text), usage }
  if (error) out.error = error
  if (session) out.sessionId = session
  return out
}
