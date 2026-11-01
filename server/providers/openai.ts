import { needsApproval } from '../approvals.js'
import { imageReply, imageSupport, isImageUnsupportedError, turnImages } from '../attachments.js'
import { providerModels } from '../provider-models.js'
import { buildSystemPrompt, buildTurnPrompt, stripSkip } from '../prompt.js'
import { allowedLocalTools, runLocalTool, type LocalToolPolicy } from './localexec.js'
import { LOCAL_TOOLS, summarizeLocalTool } from './localtools.js'
import { emptyUsage, mayBypass, turnCwd, type RunTurnParams, type TurnResult } from './types.js'

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  /** Thinking models (e.g. Kimi, DeepSeek) may need their reasoning back alongside tool calls. */
  reasoning_content?: string
}

interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

interface DeltaToolCall {
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChunk {
  choices?: { delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; tool_calls?: DeltaToolCall[] }; finish_reason?: string | null }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
  error?: { message?: string } | string
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/** Read an SSE body and call `onData` for every `data:` payload, including a final unterminated line. */
async function readSse(body: ReadableStream<Uint8Array>, onData: (payload: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const flush = (line: string): void => {
    const l = line.trim()
    if (!l.startsWith('data:')) return
    const payload = l.slice(5).trim()
    if (payload && payload !== '[DONE]') onData(payload)
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      flush(buffer.slice(0, nl))
      buffer = buffer.slice(nl + 1)
      nl = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim()) flush(buffer)
}

/** Turn an error response into one readable line: the provider's own message when it sends JSON. */
async function httpError(label: string, res: Response): Promise<string> {
  const raw = await res.text().catch(() => '')
  let detail = raw.slice(0, 400)
  try {
    const j = JSON.parse(raw) as { error?: { message?: string } | string; message?: string }
    const msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message)
    if (msg) detail = msg
  } catch {
    // not JSON
  }
  const hint = res.status === 401 || res.status === 403 ? ' Check the API key in Settings → Providers.' : res.status === 404 ? ' Check the base URL and the model id.' : res.status === 429 ? ' Rate limited; nothing was retried automatically.' : ''
  return `${label} returned HTTP ${res.status}: ${detail}${hint}`.trim()
}

/**
 * Any OpenAI-compatible chat API (Kimi, OpenRouter, DeepSeek, Groq, xAI, Ollama…). Streams the
 * reply and runs a tool loop with Synodica's local file/shell tools when the employee has tools.
 * Tool calls are executed whenever the model sent any (some providers report finish_reason "stop"
 * with tool calls); the loop ends when a step has no tool calls.
 */
export async function runOpenAiTurn(params: RunTurnParams, fetchImpl: FetchLike = fetch): Promise<TurnResult> {
  const { team, conversation, agent, provider, signal, handlers, note, notes, context } = params
  const started = Date.now()
  const selected = turnImages(conversation, agent, params.resolveAttachment, params.inputMessageId)
  if (selected.problem) return { text: imageReply(team, conversation, 'unreadable') }
  if (selected.images.length > 0 && imageSupport(provider, agent.model, providerModels.inputModalities(agent.provider, provider, agent.model)) === 'unsupported') return { text: imageReply(team, conversation, 'unsupported') }
  const cwd = turnCwd(params)
  // The local shell has no OS sandbox: project (safe) turns and read-only turns never get it.
  const policy: LocalToolPolicy = { allowOutside: mayBypass(params), shell: !params.safe && !params.readOnly, readOnly: params.readOnly === true }
  const tools = allowedLocalTools(agent.tools, policy)
  const prompt = buildTurnPrompt(team, conversation, agent, false, note, params.inputMessageId)
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(team, conversation, agent, '', notes ?? '', context ?? '') },
    { role: 'user', content: selected.images.length ? [{ type: 'text', text: prompt }, ...selected.images.map((image) => ({ type: 'image_url' as const, image_url: { url: `data:${image.mime};base64,${image.data.toString('base64')}` } }))] : prompt },
  ]
  const usage = emptyUsage(agent.model)
  usage.numTurns = 0
  let text = ''
  const done = (error?: string): TurnResult => {
    usage.durationMs = Date.now() - started
    return error ? { text: text.trim(), error, usage } : { text: stripSkip(text), usage }
  }

  for (let step = 0; step < Math.max(1, team.settings.maxTurnsPerReply); step++) {
    if (signal.aborted) return done('Stopped.')
    usage.numTurns++
    const body: Record<string, unknown> = { model: agent.model, messages, stream: true, stream_options: { include_usage: true } }
    if (tools.length > 0) body.tools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }))

    let res: Response
    try {
      res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.apiKey ?? 'none'}`, 'HTTP-Referer': 'https://github.com/Autumnpoem/Synodica', 'X-Title': 'Synodica' },
        body: JSON.stringify(body),
        signal,
      })
    } catch (err) {
      return done(signal.aborted ? 'Stopped.' : `Could not reach ${provider.baseUrl}: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (!res.ok || !res.body) {
      if (selected.images.length > 0 && (res.status === 400 || res.status === 422)) {
        const detail = await res.clone().text().catch(() => '')
        if (isImageUnsupportedError(detail)) return { text: imageReply(team, conversation, 'unsupported') }
      }
      return done(await httpError(provider.label, res))
    }

    const calls: ToolCall[] = []
    const slot = new Map<string, number>()
    let stepText = ''
    let reasoning = ''
    // Assigned inside the stream callback, so kept in an object (no stale narrowing).
    const st: { finish: string | null; streamError: string | undefined; thinkingShown: boolean } = { finish: null, streamError: undefined, thinkingShown: false }
    try {
      await readSse(res.body, (payload) => {
        let chunk: StreamChunk
        try {
          chunk = JSON.parse(payload) as StreamChunk
        } catch {
          return
        }
        if (chunk.error) st.streamError = typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'the provider reported an error mid-stream')
        if (chunk.usage) {
          usage.inputTokens += chunk.usage.prompt_tokens ?? 0
          usage.outputTokens += chunk.usage.completion_tokens ?? 0
          usage.cacheReadTokens += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0
        }
        const choice = chunk.choices?.[0]
        if (!choice) return
        const think = choice.delta?.reasoning_content ?? choice.delta?.reasoning
        if (think) {
          reasoning += think
          if (!st.thinkingShown) {
            st.thinkingShown = true
            handlers.onActivity('Thinking…')
          }
        }
        const content = choice.delta?.content
        if (content) {
          if (stepText.length === 0 && text.length > 0) {
            text += '\n\n'
            handlers.onDelta('\n\n')
          }
          stepText += content
          text += content
          handlers.onDelta(content)
        }
        for (const tc of choice.delta?.tool_calls ?? []) {
          // Providers identify a streamed call by index, by id, or (continuation fragments) by neither.
          const key = tc.index !== undefined ? `i${tc.index}` : tc.id ? `id${tc.id}` : undefined
          let i = key ? slot.get(key) : calls.length > 0 ? calls.length - 1 : undefined
          if (i === undefined) {
            i = calls.length
            if (key) slot.set(key, i)
            calls.push({ id: tc.id ?? `call_${step}_${i}`, type: 'function', function: { name: '', arguments: '' } })
          }
          const cur = calls[i]
          if (!cur) continue
          if (tc.id) cur.id = tc.id
          if (tc.function?.name) cur.function.name += tc.function.name
          if (tc.function?.arguments) cur.function.arguments += tc.function.arguments
        }
        if (choice.finish_reason) st.finish = choice.finish_reason
      })
    } catch (err) {
      return done(signal.aborted ? 'Stopped.' : `${provider.label} stream broke: ${err instanceof Error ? err.message : String(err)}`)
    }
    if (st.streamError) return done(`${provider.label}: ${st.streamError}`)

    const usable = calls.filter((c) => c.function.name)
    if (usable.length === 0) {
      if (st.finish === 'length' && !text.trim()) return done(`${provider.label} stopped at its output limit before answering.`)
      return done()
    }

    // Tool step: run every call, feed results back, and let the model continue.
    const assistant: ChatMessage = { role: 'assistant', content: stepText || null, tool_calls: usable }
    if (reasoning && provider.echoReasoning !== false) assistant.reasoning_content = reasoning
    messages.push(assistant)
    for (const call of usable) {
      let args: Record<string, unknown> = {}
      let badArgs: string | undefined
      try {
        const parsed = JSON.parse(call.function.arguments || '{}') as unknown
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) args = parsed as Record<string, unknown>
        else badArgs = 'arguments must be a JSON object'
      } catch (err) {
        badArgs = `arguments are not valid JSON (${err instanceof Error ? err.message : String(err)})`
      }
      let result: string
      const tool = LOCAL_TOOLS.find((t) => t.name === call.function.name)
      if (!tool || !tools.includes(tool)) {
        result = `Error: tool ${call.function.name} is not available to you. Available: ${tools.map((t) => t.name).join(', ') || 'none'}.`
      } else if (badArgs) {
        result = `Error: ${badArgs}. Call ${call.function.name} again with valid arguments.`
      } else {
        handlers.onActivity(summarizeLocalTool(call.function.name, args))
        const mustAsk = !agent.autoApproveTools && handlers.onToolPermission !== undefined && needsApproval(agent, tool.claudeName)
        try {
          if (mustAsk && !(await handlers.onToolPermission?.(tool.claudeName, args))) result = 'Denied by the boss. Explain what you wanted to do and stop.'
          else result = await runLocalTool(call.function.name, args, cwd, policy, signal)
        } catch (err) {
          result = `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, 60_000) })
    }
  }
  return text.trim() ? done() : done('Ran out of tool steps before answering.')
}

/** Lists models from an OpenAI-compatible endpoint, for the provider status page. */
export async function listOpenAiModels(baseUrl: string, apiKey: string | undefined): Promise<string[]> {
  const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey ?? 'none'}` }, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 ? ' (API key missing or invalid)' : ''}`)
  const data = (await res.json()) as { data?: { id?: string }[] }
  return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string').sort()
}
