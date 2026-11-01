import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { imageSupport, stageImages, turnImages } from './attachments.js'
import { buildTurnPrompt } from './prompt.js'
import { claudePromptInput } from './providers/claude.js'
import { codexExecArgs } from './providers/codex.js'
import { geminiImagePrompt } from './providers/gemini.js'
import { runGeminiTurn } from './providers/gemini.js'
import { runOpenAiTurn, type FetchLike } from './providers/openai.js'
import { member, mixedTeam, tmp } from './testkit.js'
import type { Conversation, ProviderDef } from '../shared/types.js'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y4ef7sAAAAASUVORK5CYII=', 'base64')

test('turnImages takes only the triggering user image and uses authorized real paths with detected MIME', () => {
  const dir = tmp('syn-images-')
  const old = path.join(dir, 'old.png')
  const fresh = path.join(dir, 'new.png')
  writeFileSync(old, png)
  writeFileSync(fresh, png)
  const agent = member('a', 'deepseek', [], { model: 'unknown-model' })
  const attachment = (file: string) => ({ name: path.basename(file), path: file, mime: 'image/jpeg', size: png.length })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'chat', memberIds: ['user', 'a'], sessions: {}, messages: [
    { id: '1', conversationId: 'c', authorId: 'user', text: 'old', status: 'done', createdAt: 1, attachments: [attachment(old)] },
    { id: '2', conversationId: 'c', authorId: 'a', text: 'seen', status: 'done', createdAt: 2 },
    { id: '3', conversationId: 'c', authorId: 'user', text: 'new', status: 'done', createdAt: 3, attachments: [attachment(fresh)] },
  ] }
  const result = turnImages(conversation, agent, (file) => file, '3')
  assert.equal(result.problem, undefined)
  assert.deepEqual(result.images.map((image) => image.path), [fresh])
  assert.equal(result.images[0]?.mime, 'image/png', 'declared MIME is not trusted')
  assert.equal(turnImages(conversation, agent, undefined, '3').problem, 'unreadable')
  assert.deepEqual(turnImages(conversation, agent, (file) => file).images, [], 'missing trigger ID cannot recover images from history')
})

test('a later text-only @B turn does not reuse the PNG sent to @A or expose its stored path', async () => {
  const dir = tmp('syn-cross-recipient-')
  const old = path.join(dir, 'private-photo.png')
  writeFileSync(old, png)
  const team = mixedTeam(dir)
  const b = member('b', 'deepseek', [], { model: 'custom-model', tools: [] })
  const conversation: Conversation = { id: 'c', kind: 'group', name: 'group', memberIds: ['user', 'a', 'b'], sessions: {}, messages: [
    { id: 'image-for-a', conversationId: 'c', authorId: 'user', text: '@A see this', status: 'done', createdAt: 1, attachments: [{ name: 'private-photo.png', path: old, mime: 'image/png', size: png.length }] },
    { id: 'a-reply', conversationId: 'c', authorId: 'a', text: 'Seen', status: 'done', createdAt: 2 },
    { id: 'text-for-b', conversationId: 'c', authorId: 'user', text: '@B hello', status: 'done', createdAt: 3 },
  ] }
  assert.deepEqual(turnImages(conversation, b, (file) => file, 'text-for-b').images, [])
  const prompt = buildTurnPrompt(team, conversation, b, false, undefined, 'text-for-b')
  assert.equal(prompt.includes(old), false)
  assert.match(prompt, /private-photo.png/)
  assert.match(prompt, /earlier image; content not included/)
  const currentImagePrompt = buildTurnPrompt(team, conversation, b, false, undefined, 'image-for-a')
  assert.equal(currentImagePrompt.includes(old), false, 'even the current image keeps its uploaded path private')
  const selected = turnImages(conversation, b, (file) => file, 'text-for-b').images
  assert.equal(claudePromptInput(prompt, selected), prompt)
  assert.deepEqual(codexExecArgs([], undefined, selected), ['exec', '-'])
  assert.equal(geminiImagePrompt(selected.map((image) => image.path)), '')
  let called = 0
  const fake: FetchLike = async (_url, init) => {
    called++
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[] }
    assert.equal(typeof body.messages.find((m) => m.role === 'user')?.content, 'string')
    return new Response('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n', { status: 200 })
  }
  const result = await runOpenAiTurn({ team, conversation, agent: b, provider: team.providers.deepseek!, sessionId: undefined, signal: new AbortController().signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, inputMessageId: 'text-for-b', resolveAttachment: (file) => file }, fake)
  assert.equal(result.text, 'Hello')
  assert.equal(called, 1)
})

test('known text-only model is denied; unknown model remains unknown', () => {
  const deepseek: ProviderDef = { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' }
  assert.equal(imageSupport(deepseek, 'deepseek-v4-pro'), 'unsupported')
  assert.equal(imageSupport(deepseek, 'deepseek-flash'), 'supported')
  assert.equal(imageSupport(deepseek, 'custom-model'), 'unknown')
  assert.equal(imageSupport({ kind: 'openai', label: 'Proxy', baseUrl: 'https://proxy.test/v1' }, 'deepseek-v4-pro'), 'unknown')
  assert.equal(imageSupport({ kind: 'codex', label: 'Codex' }, 'any', ['text']), 'unsupported')
})

test('Claude SDK receives native image block; Codex exec/resume receive image args after prompt marker', async () => {
  const image = { path: '/tmp/sent.png', mime: 'image/png' as const, data: png }
  const input = claudePromptInput('describe', [image])
  assert.equal(typeof input, 'object')
  const messages = []
  for await (const message of input as AsyncIterable<{ message: { content: unknown } }>) messages.push(message)
  assert.equal(messages.length, 1)
  assert.deepEqual((messages[0]?.message.content as { type: string; source?: { data: string } }[]).map((part) => part.type), ['text', 'image'])
  assert.equal((messages[0]?.message.content as { type: string; source?: { data: string } }[])[1]?.source?.data, png.toString('base64'))
  assert.deepEqual(codexExecArgs(['--json'], undefined, [image]), ['exec', '--json', '-', '-i', '/tmp/sent.png'])
  assert.deepEqual(codexExecArgs(['--json'], 'session-1', [image]), ['exec', '--json', 'resume', 'session-1', '-', '-i', '/tmp/sent.png'])
})

test('Gemini image directory contains only selected bytes and is deleted after use', () => {
  const first = { path: '/outside/private-a.png', mime: 'image/png' as const, data: png }
  const staged = stageImages([first])
  try {
    assert.deepEqual(staged.paths.map((p) => path.basename(p)), ['1.png'])
    assert.deepEqual(readFileSync(staged.paths[0]!), png)
    assert.match(geminiImagePrompt(staged.paths), /read_file/)
    assert.equal(geminiImagePrompt(staged.paths).includes(first.path), false)
  } finally { staged.cleanup() }
  assert.equal(existsSync(staged.directory), false)
})

test('OpenAI adapter sends image data in user content and never calls a known text-only model', async () => {
  const dir = tmp('syn-image-http-')
  const file = path.join(dir, 'photo.png')
  writeFileSync(file, png)
  const team = mixedTeam(dir)
  const agent = member('a', 'deepseek', [], { model: 'custom-model', tools: [] })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'chat', memberIds: ['user', 'a'], sessions: {}, messages: [
    { id: '1', conversationId: 'c', authorId: 'user', text: 'What is shown?', status: 'done', createdAt: 1, attachments: [{ name: 'photo.png', path: file, mime: 'image/png', size: png.length }] },
  ] }
  let calls = 0
  const fake: FetchLike = async (_url, init) => {
    calls++
    const request = JSON.parse(String(init.body)) as { messages: { role: string; content: unknown }[] }
    const user = request.messages.find((message) => message.role === 'user')
    assert.ok(Array.isArray(user?.content))
    assert.ok(user.content.some((part: { type: string; image_url?: { url: string } }) => part.type === 'image_url' && part.image_url?.url === `data:image/png;base64,${png.toString('base64')}`))
    return new Response('data: {"choices":[{"delta":{"content":"A dot"},"finish_reason":"stop"}]}\n\n', { status: 200 })
  }
  const base = { team, conversation, agent, provider: team.providers.deepseek!, sessionId: undefined, signal: new AbortController().signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, inputMessageId: '1', resolveAttachment: (file: string) => file }
  const result = await runOpenAiTurn(base, fake)
  assert.equal(result.text, 'A dot')
  assert.equal(calls, 1)
  const blocked = await runOpenAiTurn({ ...base, agent: { ...agent, model: 'deepseek-v4-pro' }, provider: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' } }, fake)
  assert.equal(blocked.error, undefined)
  assert.match(blocked.text, /image|图片/i)
  assert.equal(calls, 1)
})

test('upstream explicit image unsupported error becomes a clear reply', async () => {
  const dir = tmp('syn-image-unsupported-')
  const file = path.join(dir, 'photo.png')
  writeFileSync(file, png)
  const team = mixedTeam(dir)
  const agent = member('a', 'deepseek', [], { model: 'unknown-model', tools: [] })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'chat', memberIds: ['user', 'a'], sessions: {}, messages: [
    { id: '1', conversationId: 'c', authorId: 'user', text: 'Can you see it?', status: 'done', createdAt: 1, attachments: [{ name: 'photo.png', path: file, mime: 'image/png', size: png.length }] },
  ] }
  const fake: FetchLike = async () => new Response(JSON.stringify({ error: { message: 'This model does not support image input' } }), { status: 400 })
  const result = await runOpenAiTurn({ team, conversation, agent, provider: team.providers.deepseek!, sessionId: undefined, signal: new AbortController().signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, inputMessageId: '1', resolveAttachment: (p) => p }, fake)
  assert.equal(result.error, undefined)
  assert.match(result.text, /cannot view images/i)
})

test('an image without a host-authorized path is not sent to OpenAI', async () => {
  const dir = tmp('syn-image-path-')
  const file = path.join(dir, 'photo.png')
  writeFileSync(file, png)
  const team = mixedTeam(dir)
  const agent = member('a', 'deepseek', [], { model: 'unknown-model', tools: [] })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'chat', memberIds: ['user', 'a'], sessions: {}, messages: [
    { id: '1', conversationId: 'c', authorId: 'user', text: 'See this?', status: 'done', createdAt: 1, attachments: [{ name: 'photo.png', path: file, mime: 'image/png', size: png.length }] },
  ] }
  const fake: FetchLike = async () => { throw new Error('must not reach provider') }
  const result = await runOpenAiTurn({ team, conversation, agent, provider: team.providers.deepseek!, sessionId: undefined, signal: new AbortController().signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, inputMessageId: '1' }, fake)
  assert.equal(result.error, undefined)
  assert.match(result.text, /could not read/i)
})

test('Gemini without the Read tool names the connection limit before starting its CLI', async () => {
  const dir = tmp('syn-image-gemini-')
  const file = path.join(dir, 'photo.png')
  writeFileSync(file, png)
  const team = mixedTeam(dir)
  const agent = member('a', 'gemini', [], { model: 'default', tools: [] })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'chat', memberIds: ['user', 'a'], sessions: {}, messages: [
    { id: '1', conversationId: 'c', authorId: 'user', text: 'See this?', status: 'done', createdAt: 1, attachments: [{ name: 'photo.png', path: file, mime: 'image/png', size: png.length }] },
  ] }
  const result = await runGeminiTurn({ team, conversation, agent, provider: team.providers.gemini!, sessionId: undefined, signal: new AbortController().signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, inputMessageId: '1', resolveAttachment: (p) => p })
  assert.equal(result.error, undefined)
  assert.match(result.text, /connection could not read the image/i)
})
