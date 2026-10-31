import { query } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk'
import { needsApproval } from '../approvals.js'
import { buildSystemPrompt, buildTurnPrompt, stripSkip } from '../prompt.js'
import { READ_ONLY_TOOLS, turnCwd, type TurnHandlers } from './types.js'
import type { RunTurnParams, TurnResult } from './types.js'
import type { Agent, Conversation, MessageUsage, ProviderDef, Team } from '../../shared/types.js'

function summarizeToolUse(name: string, input: unknown): string {
  const i = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined)
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${name} ${str('file_path') ?? ''}`.trim()
    case 'Bash':
      return `Bash ${str('description') ?? str('command') ?? ''}`.trim()
    case 'Glob':
    case 'Grep':
      return `${name} ${str('pattern') ?? ''}`.trim()
    case 'WebSearch':
      return `Searching the web: ${str('query') ?? ''}`.trim()
    case 'WebFetch':
      return `Fetching ${str('url') ?? ''}`.trim()
    case 'Task':
      return `Subagent: ${str('description') ?? ''}`.trim()
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(name)
      return m ? `${m[1]} → ${m[2]}` : name
    }
  }
}

function envFor(provider: ProviderDef): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    // Subscription by default: drop any globally exported key so you are never billed by accident.
    if (k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') continue
    env[k] = v
  }
  if (provider.apiKey) env.ANTHROPIC_API_KEY = provider.apiKey
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl
  return env
}

function mcpServersFor(team: Team, agent: Agent): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const name of agent.mcpServers) {
    const def = team.mcpServers[name]
    if (!def) continue
    if (def.type === 'stdio') {
      out[name] = { type: 'stdio', command: def.command, ...(def.args ? { args: def.args } : {}), ...(def.env ? { env: def.env } : {}) }
    } else {
      out[name] = { type: def.type, url: def.url, ...(def.headers ? { headers: def.headers } : {}) }
    }
  }
  return out
}

export interface TurnScope {
  cwd?: string
  context?: string
  safe?: boolean
  /** Review / planning: only read tools, no MCP servers, nothing that asks to write. */
  readOnly?: boolean
}

export function buildQueryOptions(team: Team, conversation: Conversation, agent: Agent, provider: ProviderDef, sessionId: string | undefined, abort: AbortController, handlers?: TurnHandlers, notes = '', scope: TurnScope = {}): Options {
  if (scope.readOnly) {
    // Read-only steps: the tool list itself excludes Edit/Write/Bash/NotebookEdit/Task and MCP, and
    // dontAsk denies anything not pre-approved, so no write can be approved even by mistake.
    const tools = agent.tools.filter((t) => READ_ONLY_TOOLS.includes(t))
    return {
      model: agent.model,
      effort: agent.effort,
      systemPrompt: buildSystemPrompt(team, conversation, agent, '', notes, scope.context ?? ''),
      cwd: turnCwd({ team, agent, ...(scope.cwd ? { cwd: scope.cwd } : {}) }),
      tools,
      allowedTools: tools,
      permissionMode: 'dontAsk',
      includePartialMessages: true,
      settingSources: [],
      maxTurns: team.settings.maxTurnsPerReply,
      env: envFor(provider),
      abortController: abort,
      ...(sessionId ? { resume: sessionId } : {}),
    }
  }
  const mcpServers = mcpServersFor(team, agent)
  // Workflow turns never run with bypassPermissions; they fall back to accepting edits in the folder.
  const mode = scope.safe && agent.permissionMode === 'bypassPermissions' ? 'acceptEdits' : agent.permissionMode
  const asks = agent.approvals !== 'auto' && !agent.autoApproveTools && handlers?.onToolPermission !== undefined
  // Tools that must stop for approval are left out of allowedTools so Claude Code calls canUseTool for them.
  const allowedTools = asks
    ? agent.tools.filter((t) => !needsApproval(agent, t))
    : [...agent.tools, ...Object.keys(mcpServers).map((n) => `mcp__${n}`)]
  const mcpNote = agent.mcpServers.length > 0 ? ` You also have MCP tools from: ${agent.mcpServers.join(', ')}.` : ''
  const options: Options = {
    model: agent.model,
    effort: agent.effort,
    systemPrompt: buildSystemPrompt(team, conversation, agent, mcpNote, notes, scope.context ?? ''),
    cwd: turnCwd({ team, agent, ...(scope.cwd ? { cwd: scope.cwd } : {}) }),
    tools: agent.tools,
    allowedTools,
    permissionMode: asks && (mode === 'dontAsk' || mode === 'acceptEdits') ? 'default' : mode,
    includePartialMessages: true,
    settingSources: agent.inheritClaudeSettings ? ['user'] : [],
    maxTurns: team.settings.maxTurnsPerReply,
    env: envFor(provider),
    abortController: abort,
  }
  if (Object.keys(mcpServers).length > 0) options.mcpServers = mcpServers
  if (sessionId) options.resume = sessionId
  if (agent.autoApproveTools) {
    options.canUseTool = async (_tool, input) => ({ behavior: 'allow', updatedInput: input })
  } else if (asks && handlers?.onToolPermission) {
    const ask = handlers.onToolPermission
    options.canUseTool = async (tool, input) => {
      if (!needsApproval(agent, tool)) return { behavior: 'allow', updatedInput: input }
      const ok = await ask(tool, input)
      return ok ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'The boss denied this action. Explain what you wanted to do and stop.' }
    }
  }
  if (mode === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
  return options
}

export async function runClaudeTurn(params: RunTurnParams): Promise<TurnResult> {
  const { team, conversation, agent, provider, sessionId, signal, handlers, note, notes } = params
  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  if (signal.aborted) abort.abort()
  else signal.addEventListener('abort', onAbort, { once: true })

  const prompt = buildTurnPrompt(team, conversation, agent, sessionId !== undefined, note)
  const scope: TurnScope = { ...(params.cwd ? { cwd: params.cwd } : {}), ...(params.context ? { context: params.context } : {}), ...(params.safe ? { safe: true } : {}), ...(params.readOnly ? { readOnly: true } : {}) }
  const q = query({ prompt, options: buildQueryOptions(team, conversation, agent, provider, sessionId, abort, handlers, notes ?? '', scope) })

  let text = ''
  let resultText = ''
  let error: string | undefined
  let session: string | undefined
  let usage: MessageUsage | undefined
  let blockOpen = false

  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        session = msg.session_id
        handlers.onSession(session)
        handlers.onInit?.(String(msg.apiKeySource), msg.claude_code_version)
      } else if (msg.type === 'rate_limit_event') {
        const info = msg.rate_limit_info
        handlers.onRateLimit?.({ status: info.status, rateLimitType: info.rateLimitType, utilization: info.utilization, resetsAt: info.resetsAt })
      } else if (msg.type === 'stream_event') {
        if (msg.parent_tool_use_id) continue
        const ev = msg.event
        if (ev.type === 'content_block_start' && ev.content_block.type === 'text') {
          if (text.length > 0 && !text.endsWith('\n\n')) {
            text += '\n\n'
            handlers.onDelta('\n\n')
          }
          blockOpen = true
        } else if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && blockOpen) {
          text += ev.delta.text
          handlers.onDelta(ev.delta.text)
        } else if (ev.type === 'content_block_stop') {
          blockOpen = false
        }
      } else if (msg.type === 'assistant') {
        if (msg.parent_tool_use_id) continue
        for (const block of msg.message.content) {
          if (block.type === 'tool_use') handlers.onActivity(summarizeToolUse(block.name, block.input))
        }
      } else if (msg.type === 'result') {
        const models = Object.keys(msg.modelUsage ?? {})
        usage = {
          inputTokens: msg.usage.input_tokens,
          outputTokens: msg.usage.output_tokens,
          cacheReadTokens: msg.usage.cache_read_input_tokens,
          cacheCreationTokens: msg.usage.cache_creation_input_tokens,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          numTurns: msg.num_turns,
          model: models.length > 0 ? models.join('+') : agent.model,
        }
        if (msg.subtype === 'success') {
          resultText = msg.result
        } else {
          error = msg.subtype === 'error_during_execution' ? 'The agent hit an error while working.' : `Turn ended: ${msg.subtype}`
          const errs = (msg as { errors?: string[] }).errors
          if (Array.isArray(errs) && errs.length > 0) error = errs.join('\n')
        }
      }
    }
  } catch (err) {
    if (abort.signal.aborted) error = 'Stopped.'
    else error = err instanceof Error ? err.message : String(err)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }

  const finalText = (text.trim().length > 0 ? text : resultText).trim()
  const out: TurnResult = { text: error ? finalText : stripSkip(finalText) }
  if (error) out.error = error
  if (session) out.sessionId = session
  if (usage) out.usage = usage
  return out
}
