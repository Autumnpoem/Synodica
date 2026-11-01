import assert from 'node:assert/strict'
import { test } from 'node:test'
import { codexModelListNeedsShell, createProviderModelService, queryCodexAppServerModels } from './provider-models.js'
import type { ProviderDef } from '../shared/types.js'

const openai: ProviderDef = { kind: 'openai', label: 'Example', baseUrl: 'https://example.test/v1/', apiKey: 'secret', models: ['custom-id'] }

test('OpenAI-compatible catalog reads upstream IDs, strips trailing slash, and never returns credentials', async () => {
  let calls = 0
  const service = createProviderModelService({ fetch: async (url, init) => {
    calls++
    assert.equal(url, 'https://example.test/v1/models')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer secret')
    assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify({ data: [{ id: 'real-a', name: 'Real A' }, { id: 'real-b' }] }), { status: 200 })
  } })
  const result = await service('example', openai)
  assert.deepEqual(result.models.map((m) => m.id), ['real-a', 'real-b'])
  assert.equal(result.source, 'upstream')
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal((await service('example', openai)).updatedAt, result.updatedAt)
  assert.equal(calls, 1)
})

test('failed upstream response retains only configured IDs and generic error', async () => {
  const service = createProviderModelService({ fetch: async () => new Response('{"error":"secret"}', { status: 401 }) })
  const result = await service('example-2', openai)
  assert.equal(result.source, 'configured')
  assert.equal(result.error, 'unavailable')
  assert.deepEqual(result.models, [{ id: 'custom-id', label: 'custom-id' }])
  assert.equal(JSON.stringify(result).includes('secret'), false)
})

test('Codex and Claude catalogs use their respective adapters and expose default capability', async () => {
  const service = createProviderModelService({
    codexModels: async () => [{ id: 'gpt-x', label: 'GPT X' }],
    claudeModels: async () => [{ id: 'claude-x', label: 'Claude X' }],
  })
  assert.deepEqual((await service('codex', { kind: 'codex', label: 'Codex' })).models.map((m) => m.id), ['gpt-x'])
  assert.equal((await service('codex', { kind: 'codex', label: 'Codex' })).supportsDefault, true)
  assert.equal((await service('claude', { kind: 'claude', label: 'Claude' })).source, 'cli')
  const official = await service('claude-official', { kind: 'claude', label: 'Claude', baseUrl: 'https://api.anthropic.com' })
  assert.equal(official.source, 'cli')
  assert.equal(official.supportsDefault, true)
})

test('catalog retains advertised modalities for the same provider credential and model', async () => {
  const service = createProviderModelService({ codexModels: async () => [{ id: 'text-only', label: 'Text only', inputModalities: ['text'] }] })
  const def: ProviderDef = { kind: 'codex', label: 'Codex', apiKey: 'first-key' }
  await service('codex-models', def)
  assert.deepEqual(service.inputModalities('codex-models', def, 'text-only'), ['text'])
  assert.equal(service.inputModalities('codex-models', { ...def, apiKey: 'other-key' }, 'text-only'), undefined)
})

test('forced refresh is cooled down and simultaneous loads coalesce', async () => {
  let now = 100_000
  let calls = 0
  const service = createProviderModelService({ now: () => now, fetch: async () => {
    calls++
    await Promise.resolve()
    return new Response(JSON.stringify({ data: [{ id: `m${calls}` }] }), { status: 200 })
  } })
  const [a, b] = await Promise.all([service('coalesce', openai), service('coalesce', openai)])
  assert.deepEqual(a, b)
  assert.equal(calls, 1)
  assert.deepEqual((await service('coalesce', openai, true)).models.map((m) => m.id), ['m1'])
  now += 30_001
  assert.deepEqual((await service('coalesce', openai, true)).models.map((m) => m.id), ['m2'])
})

test('Codex app-server model/list fixture pages, excludes hidden rows, and uses selectable model field', async () => {
  const fixture = String.raw`
    let buffer = ''
    if (process.env.OPENAI_API_KEY !== 'catalog-test-key') process.exit(6)
    if (process.env.OPENGROKBOT_SECRET) process.exit(7)
    process.stdin.on('data', chunk => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n')
        if (message.method === 'model/list') {
          if (message.id === 2) {
            if (message.params.includeHidden !== false) process.exit(5)
            process.stdout.write(JSON.stringify({ id: 2, result: { data: [{ id: 'internal', model: 'gpt-real', displayName: 'GPT Real', inputModalities: ['text', 'image'] }, { id: 'secret-model', hidden: true }], nextCursor: 'page2' } }) + '\n')
          } else {
            process.stdout.write(JSON.stringify({ id: message.id, result: { data: [{ id: 'gpt-next', displayName: 'GPT Next' }], nextCursor: null } }) + '\n')
          }
        }
      }
    })
  `
  const models = await queryCodexAppServerModels(process.execPath, ['-e', fixture], { kind: 'codex', label: 'Codex', apiKey: 'catalog-test-key' }, { ...process.env, OPENGROKBOT_SECRET: 'must-not-reach-cli' })
  assert.deepEqual(models.map((m) => m.id), ['gpt-real', 'gpt-next'])
  assert.equal(models[0]?.label, 'GPT Real')
  assert.deepEqual(models[0]?.inputModalities, ['text', 'image'])
})

test('Codex default Windows command uses cmd shell for codex.cmd; explicit commands stay direct', () => {
  assert.equal(codexModelListNeedsShell(undefined, 'win32'), true)
  assert.equal(codexModelListNeedsShell('C:\\Program Files\\Node\\node.exe', 'win32'), false)
  assert.equal(codexModelListNeedsShell(undefined, 'darwin'), false)
})

test('Claude gateway uses selected auth mode and rejects redirects without leaking secret', async () => {
  const gateway: ProviderDef = { kind: 'claude', label: 'Gateway', baseUrl: 'https://gateway.test/v1/', apiKey: 'private', authMode: 'auth-token' }
  const service = createProviderModelService({ fetch: async (url, init) => {
    assert.equal(url, 'https://gateway.test/v1/models')
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer private')
    assert.equal(new Headers(init?.headers).get('x-api-key'), null)
    assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify({ data: [{ id: 'claude-a', display_name: 'Claude A' }] }), { status: 200 })
  } })
  const result = await service('claude-gateway', gateway)
  assert.deepEqual(result.models, [{ id: 'claude-a', label: 'Claude A' }])
  assert.equal(result.source, 'upstream')
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('Gemini suggestions are marked configured, and malformed upstream data is unavailable', async () => {
  const service = createProviderModelService({ fetch: async () => new Response('{}', { status: 200 }) })
  const gemini = await service('gemini', { kind: 'gemini', label: 'Gemini' })
  assert.equal(gemini.source, 'configured')
  assert.equal(gemini.error, 'unsupported')
  assert.equal(gemini.supportsDefault, true)
  assert.ok(gemini.models.some((m) => m.id.startsWith('gemini-')))
  const malformed = await service('malformed', openai)
  assert.equal(malformed.source, 'configured')
  assert.equal(malformed.error, 'unavailable')
})

test('Anthropic list follows after_id pagination on the configured host', async () => {
  const urls: string[] = []
  const service = createProviderModelService({ fetch: async (url, init) => {
    urls.push(url)
    assert.equal(new Headers(init?.headers).get('x-api-key'), 'anthropic-test-key')
    return new Response(JSON.stringify(urls.length === 1
      ? { data: [{ id: 'claude-first', display_name: 'First' }], has_more: true, last_id: 'claude-first', next_url: 'https://evil.test/models' }
      : { data: [{ id: 'claude-second', display_name: 'Second' }], has_more: false, last_id: 'claude-second' }), { status: 200 })
  } })
  const result = await service('anthropic-api', { kind: 'claude', label: 'Claude API', apiKey: 'anthropic-test-key' })
  assert.deepEqual(result.models.map((m) => m.id), ['claude-first', 'claude-second'])
  assert.deepEqual(urls, ['https://api.anthropic.com/v1/models', 'https://api.anthropic.com/v1/models?after_id=claude-first'])
  assert.equal(result.supportsDefault, false)
})

test('Gemini API catalog uses header key, filters generateContent, strips models prefix and pages', async () => {
  const urls: string[] = []
  const service = createProviderModelService({ fetch: async (url, init) => {
    urls.push(url)
    assert.equal(new Headers(init?.headers).get('x-goog-api-key'), 'gemini-test-key')
    assert.equal(init?.redirect, 'error')
    return new Response(JSON.stringify(urls.length === 1
      ? { models: [{ name: 'models/gemini-first', displayName: 'First', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'page-two' }
      : { models: [{ name: 'models/gemini-second', displayName: 'Second', supportedGenerationMethods: ['generateContent'] }] }), { status: 200 })
  } })
  const result = await service('gemini-api', { kind: 'gemini', label: 'Gemini API', apiKey: 'gemini-test-key' })
  assert.equal(result.source, 'upstream')
  assert.deepEqual(result.models.map((m) => m.id), ['gemini-first', 'gemini-second'])
  assert.deepEqual(urls, ['https://generativelanguage.googleapis.com/v1beta/models', 'https://generativelanguage.googleapis.com/v1beta/models?pageToken=page-two'])
  assert.equal(JSON.stringify(result).includes('gemini-test-key'), false)
})

test('failed/aborted model request returns honest unavailable status', async () => {
  const service = createProviderModelService({ timeoutMs: 5, fetch: async (_url, init) => {
    const signal = init?.signal
    assert.ok(signal)
    await new Promise<void>((_resolve, reject) => {
      const guard = setTimeout(() => reject(new Error('abort signal did not fire')), 1_000)
      signal.addEventListener('abort', () => { clearTimeout(guard); reject(signal.reason) }, { once: true })
    })
    throw new Error('unreachable')
  } })
  const result = await service('timeout', { kind: 'openai', label: 'Timeout', baseUrl: 'https://example.test/v1' })
  assert.equal(result.source, 'unavailable')
  assert.equal(result.error, 'unavailable')
  assert.deepEqual(result.models, [])
})

test('pagination has one overall deadline instead of resetting the timeout on every page', async () => {
  for (const kind of ['claude', 'gemini'] as const) {
    let page = 0
    const service = createProviderModelService({ timeoutMs: 25, fetch: async (_url, init) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 15)
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal?.reason) }, { once: true })
      })
      page++
      return new Response(JSON.stringify(kind === 'claude'
        ? { data: [{ id: `claude-${page}` }], has_more: page < 3, last_id: `claude-${page}` }
        : { models: [{ name: `models/gemini-${page}`, supportedGenerationMethods: ['generateContent'] }], nextPageToken: page < 3 ? `page-${page + 1}` : undefined }), { status: 200 })
    } })
    const result = await service(`deadline-${kind}`, { kind, label: kind, apiKey: 'test-key' })
    assert.equal(result.error, 'unavailable', `${kind} must abort the full paginated lookup`)
    assert.ok(page < 3, `${kind} must stop before page 3 completes`)
  }
})
