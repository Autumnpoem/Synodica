import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { collectAttachments } from './files.js'
import { buildQueryOptions } from './providers/claude.js'
import { runOpenAiTurn, type FetchLike } from './providers/openai.js'
import { agentCwd, mayBypass, turnCwd, type RunTurnParams, type TurnHandlers } from './providers/types.js'
import { member, mixedTeam, tmp } from './testkit.js'
import { PROVIDER_CAPABILITIES } from '../shared/catalog.js'
import type { Conversation } from '../shared/types.js'

/** An SSE response made of the given chunks (objects are JSON-encoded as data lines). */
function sse(chunks: unknown[], opts: { trailingNewline?: boolean } = {}): Response {
  const body = chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n\n') + (opts.trailingNewline === false ? '' : '\n\n')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function handlers(log: string[] = []): TurnHandlers {
  return { onDelta: (d) => log.push(`delta:${d}`), onActivity: (l) => log.push(`activity:${l}`), onSession: () => {} }
}

function params(cwd: string, over: Partial<RunTurnParams> = {}): RunTurnParams {
  const team = mixedTeam(cwd)
  const agent = member('junior', 'deepseek', ['implementer'], { tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep'] })
  const conversation: Conversation = { id: 'c', kind: 'group', name: 'P', memberIds: ['user', 'junior'], messages: [{ id: 'm', conversationId: 'c', authorId: 'user', text: 'write hello.txt', createdAt: 1, status: 'done' }], sessions: {} }
  const provider = team.providers.deepseek
  assert.ok(provider)
  return { team, conversation, agent, provider, sessionId: undefined, signal: new AbortController().signal, handlers: handlers(), cwd, ...over }
}

test('openai adapter: runs tool calls even when finish_reason is "stop", resolves paths in the turn folder, echoes reasoning', async () => {
  const ws = tmp('ogb-oa-')
  const bodies: Record<string, unknown>[] = []
  const responses = [
    sse([
      { choices: [{ delta: { reasoning_content: 'I should write the file.' } }] },
      // No "index" on the tool call delta (some compatible providers omit it).
      { choices: [{ delta: { tool_calls: [{ id: 'call_a', function: { name: 'write_file', arguments: '{"path":"out/hello.txt",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '"content":"hi"}' } }] }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      '[DONE]',
    ]),
    // Final answer without a trailing newline: the last line must still be read.
    sse([{ choices: [{ delta: { content: 'Wrote out/hello.txt' }, finish_reason: 'stop' }] }], { trailingNewline: false }),
  ]
  const fake: FetchLike = async (_url, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const r = responses.shift()
    assert.ok(r, 'no more responses')
    return r
  }
  const log: string[] = []
  const result = await runOpenAiTurn(params(ws, { handlers: handlers(log), safe: true }), fake)
  assert.equal(result.error, undefined)
  assert.equal(result.text, 'Wrote out/hello.txt')
  assert.equal(readFileSync(path.join(ws, 'out', 'hello.txt'), 'utf8'), 'hi')
  assert.ok(log.includes('activity:Write out/hello.txt'))
  assert.ok(log.includes('activity:Thinking…'))
  const second = bodies[1]?.messages as { role: string; reasoning_content?: string; tool_calls?: unknown[]; tool_call_id?: string; content?: string }[]
  const assistant = second.find((m) => m.role === 'assistant')
  assert.equal(assistant?.reasoning_content, 'I should write the file.')
  assert.equal(assistant?.tool_calls?.length, 1)
  assert.equal(second.find((m) => m.role === 'tool')?.tool_call_id, 'call_a')
  assert.equal(result.usage?.inputTokens, 10)
  assert.equal(result.usage?.numTurns, 2)
})

test('openai adapter: echoReasoning=false omits reasoning; bad tool arguments are reported back to the model', async () => {
  const ws = tmp('ogb-oa-')
  const bodies: Record<string, unknown>[] = []
  const responses = [
    sse([{ choices: [{ delta: { reasoning_content: 'hmm', tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: '{not json' } }] }, finish_reason: 'tool_calls' }] }]),
    sse([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
  ]
  const fake: FetchLike = async (_u, init) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    return responses.shift() as Response
  }
  const p = params(ws)
  const result = await runOpenAiTurn({ ...p, provider: { ...p.provider, echoReasoning: false } }, fake)
  assert.equal(result.text, 'ok')
  const msgs = bodies[1]?.messages as { role: string; reasoning_content?: string; content?: string }[]
  assert.equal(msgs.find((m) => m.role === 'assistant')?.reasoning_content, undefined)
  assert.match(msgs.find((m) => m.role === 'tool')?.content ?? '', /not valid JSON/)
})

test('openai adapter: HTTP and mid-stream errors surface the provider message with a hint', async () => {
  const ws = tmp('ogb-oa-')
  const http: FetchLike = async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 })
  const r1 = await runOpenAiTurn(params(ws), http)
  assert.match(r1.error ?? '', /HTTP 401: Invalid API key/)
  assert.match(r1.error ?? '', /Check the API key/)
  const mid: FetchLike = async () => sse([{ choices: [{ delta: { content: 'part' } }] }, { error: { message: 'model overloaded' } }])
  const r2 = await runOpenAiTurn(params(ws), mid)
  assert.match(r2.error ?? '', /model overloaded/)
  assert.equal(r2.text, 'part', 'partial text is kept for the error bubble')
  const down: FetchLike = async () => {
    throw new Error('ECONNREFUSED')
  }
  assert.match((await runOpenAiTurn(params(ws), down)).error ?? '', /Could not reach .*ECONNREFUSED/)
})

test('openai adapter in safe mode never writes outside the project folder, even with bypass in the profile', async () => {
  const ws = tmp('ogb-oa-')
  const outside = path.join(path.dirname(ws), `outside-${path.basename(ws)}.txt`)
  const responses = [
    sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_file', arguments: JSON.stringify({ path: outside, content: 'x' }) } }] }, finish_reason: 'tool_calls' }] }]),
    sse([{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }]),
  ]
  const fake: FetchLike = async () => responses.shift() as Response
  const p = params(ws, { safe: true })
  await runOpenAiTurn({ ...p, agent: { ...p.agent, permissionMode: 'bypassPermissions', autoApproveTools: true } }, fake)
  assert.equal(existsSync(outside), false)
})

test('safe mode drops permission bypass for every adapter; cwd resolution honours the turn and employee folders', () => {
  const ws = tmp('ogb-cwd-')
  const team = mixedTeam(ws)
  const agent = member('x', 'claude', ['implementer'], { permissionMode: 'bypassPermissions', cwd: 'sub' })
  assert.equal(mayBypass({ agent, safe: true }), false)
  assert.equal(mayBypass({ agent }), true)
  assert.equal(agentCwd(ws, agent), path.join(ws, 'sub'))
  assert.equal(turnCwd({ team, agent, cwd: '/proj' }), '/proj')
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'x', memberIds: ['user', 'x'], messages: [], sessions: {} }
  const provider = team.providers.claude
  assert.ok(provider)
  const safe = buildQueryOptions(team, conversation, agent, provider, undefined, new AbortController(), undefined, '', { safe: true, cwd: '/proj', context: 'Project "P"' })
  assert.equal(safe.permissionMode, 'acceptEdits')
  assert.equal(safe.allowDangerouslySkipPermissions, undefined)
  assert.equal(safe.cwd, '/proj')
  assert.match(String(safe.systemPrompt), /Project context[\s\S]*Project "P"/)
  const legacy = buildQueryOptions(team, conversation, agent, provider, undefined, new AbortController())
  assert.equal(legacy.permissionMode, 'bypassPermissions', 'ordinary chats keep the profile choice')
  assert.equal(legacy.cwd, path.join(ws, 'sub'))
})

test('collectAttachments resolves relative activity paths against the turn folder', () => {
  const ws = tmp('ogb-att-')
  mkdirSync(path.join(ws, 'src'))
  writeFileSync(path.join(ws, 'src', 'a.ts'), 'x')
  const got = collectAttachments('done', ['Write src/a.ts', 'Edit missing.ts'], (p) => p.startsWith(ws), ws)
  assert.deepEqual(got.map((a) => a.path), [path.join(ws, 'src', 'a.ts')])
  assert.deepEqual(collectAttachments('done', ['Write src/a.ts'], () => true), [], 'without a folder, relative paths are not guessed')
})

test('provider capabilities are declared for every adapter kind and differ honestly', () => {
  assert.equal(PROVIDER_CAPABILITIES.codex.inChatApprovals, false)
  assert.equal(PROVIDER_CAPABILITIES.gemini.sessions, false)
  assert.equal(PROVIDER_CAPABILITIES.openai.tools, 'local')
  assert.equal(PROVIDER_CAPABILITIES.claude.mcp, true)
})


test('Claude default follows the SDK model while explicit custom IDs survive normal and review turns', () => {
  const team = mixedTeam(tmp())
  const conversation: Conversation = { id: 'default-model', kind: 'dm', name: 'Test', memberIds: ['user', 'lead'], messages: [], sessions: {} }
  const provider = team.providers.claude!
  for (const readOnly of [false, true]) {
    const automatic = member('lead', 'claude', ['lead'], { model: 'default' })
    const options = buildQueryOptions(team, conversation, automatic, provider, undefined, new AbortController(), undefined, '', { readOnly })
    assert.equal(options.model, undefined, 'default must not be sent as a literal model ID')
    const custom = { ...automatic, model: 'custom-model-from-gateway' }
    assert.equal(buildQueryOptions(team, conversation, custom, provider, undefined, new AbortController(), undefined, '', { readOnly }).model, custom.model)
  }
})
