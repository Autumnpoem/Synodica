import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { claudeEnv } from './providers/claude-env.js'
import { resolveCodexCommand } from './providers/cli.js'
import { MODEL_SUGGESTIONS } from '../shared/catalog.js'
import { claudeEndpointOrigin } from '../shared/provider-origin.js'
import type { ProviderDef, ProviderModelCatalog } from '../shared/types.js'

type Model = ProviderModelCatalog['models'][number]
type FetchModels = (url: string, init?: RequestInit) => Promise<Response>
interface Dependencies {
  fetch?: FetchModels
  codexModels?: (def: ProviderDef) => Promise<Model[]>
  claudeModels?: (def: ProviderDef) => Promise<Model[]>
  now?: () => number
  timeoutMs?: number
}

const TIMEOUT_MS = 12_000
const CACHE_MS = 5 * 60_000
const REFRESH_COOLDOWN_MS = 30_000

function rows(items: unknown): Model[] {
  if (!Array.isArray(items)) throw new Error('invalid-model-list')
  const seen = new Set<string>()
  const out: Model[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = typeof row.id === 'string' ? row.id : typeof row.model === 'string' ? row.model : typeof row.value === 'string' ? row.value : ''
    if (!id.trim() || seen.has(id)) continue
    seen.add(id)
    const label = [row.displayName, row.display_name, row.name].find((v) => typeof v === 'string' && v.trim())
    out.push({ id, label: typeof label === 'string' ? label : id, ...(typeof row.description === 'string' ? { description: row.description } : {}), ...(Array.isArray(row.inputModalities) ? { inputModalities: row.inputModalities.filter((value): value is string => typeof value === 'string') } : {}) })
  }
  return out
}

async function readModels(fetchImpl: FetchModels, url: string, headers: HeadersInit, timeoutMs: number): Promise<Model[]> {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
  if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? 'unsupported' : 'unavailable')
  const body = await response.json() as { data?: unknown }
  return rows(body.data)
}

async function readAnthropicModels(fetchImpl: FetchModels, baseUrl: string, headers: HeadersInit, timeoutMs: number): Promise<Model[]> {
  const url = new URL(`${baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1/models`)
  const signal = AbortSignal.timeout(timeoutMs)
  const all: Model[] = []
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted()
    const response = await fetchImpl(url.toString(), { headers, signal, redirect: 'error' })
    if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? 'unsupported' : 'unavailable')
    const body = await response.json() as { data?: unknown; has_more?: unknown; last_id?: unknown }
    signal.throwIfAborted()
    all.push(...rows(body.data))
    if (body.has_more === false || body.has_more === undefined) return all
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id) throw new Error('unavailable')
    url.searchParams.set('after_id', body.last_id)
  }
  throw new Error('unavailable')
}

async function readGeminiModels(fetchImpl: FetchModels, apiKey: string, timeoutMs: number): Promise<Model[]> {
  const url = new URL('https://generativelanguage.googleapis.com/v1beta/models')
  const signal = AbortSignal.timeout(timeoutMs)
  const all: Model[] = []
  for (let page = 0; page < 100; page++) {
    signal.throwIfAborted()
    const response = await fetchImpl(url.toString(), { headers: { 'x-goog-api-key': apiKey }, signal, redirect: 'error' })
    if (!response.ok) throw new Error(response.status === 404 || response.status === 405 ? 'unsupported' : 'unavailable')
    const body = await response.json() as { models?: unknown; nextPageToken?: unknown }
    signal.throwIfAborted()
    if (!Array.isArray(body.models)) throw new Error('unavailable')
    all.push(...rows(body.models.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
      .filter((item) => Array.isArray(item.supportedGenerationMethods) && item.supportedGenerationMethods.includes('generateContent'))
      .map((item) => ({ ...item, id: typeof item.name === 'string' ? item.name.replace(/^models\//, '') : '' }))))
    if (!body.nextPageToken) return all
    if (typeof body.nextPageToken !== 'string') throw new Error('unavailable')
    url.searchParams.set('pageToken', body.nextPageToken)
  }
  throw new Error('unavailable')
}

/** Windows PATH may contain only codex.cmd; Node needs a shell for that default command. */
export function codexModelListNeedsShell(command: string | undefined, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && command === undefined
}

export async function queryCodexAppServerModels(command?: string, args = ['app-server'], def?: ProviderDef, sourceEnv: NodeJS.ProcessEnv = process.env): Promise<Model[]> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(sourceEnv).filter(([key]) => !key.startsWith('OPENGROKBOT_'))) as NodeJS.ProcessEnv
    if (def?.apiKey) env.OPENAI_API_KEY = def.apiKey
    else delete env.OPENAI_API_KEY
    const child = spawn(command ?? resolveCodexCommand({ env }), args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: codexModelListNeedsShell(command, process.platform) })
    let buffer = ''
    let settled = false
    const found: Model[] = []
    const seen = new Set<string>()
    const timer = setTimeout(() => finish(new Error('timeout')), TIMEOUT_MS)
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.stdin.end()
      child.kill()
      if (error) reject(error)
      else resolve(found)
    }
    const send = (data: Record<string, unknown>) => { if (!settled) child.stdin.write(`${JSON.stringify(data)}\n`) }
    child.on('error', () => finish(new Error('unavailable')))
    child.on('close', () => finish(new Error('unavailable')))
    child.stdin.on('error', () => {})
    child.stderr.on('data', () => {}) // CLI output can contain local details; never surface it.
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (buffer.length > 2_000_000) return finish(new Error('unavailable'))
      let at: number
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let message: { id?: number; result?: { data?: unknown; nextCursor?: unknown }; error?: { code?: number } }
        try { message = JSON.parse(line) as typeof message } catch { continue }
        if (message.error) return finish(new Error(message.error.code === -32601 ? 'unsupported' : 'unavailable'))
        if (message.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'model/list', params: { limit: 100, includeHidden: false } })
        } else if (message.id && message.id >= 2) {
          let page: Model[]
          try {
            page = rows((message.result?.data as Record<string, unknown>[]).filter((item) => item?.hidden !== true).map((item) => ({ ...item, id: item.model ?? item.id })))
          } catch { return finish(new Error('unavailable')) }
          for (const model of page) if (!seen.has(model.id)) { seen.add(model.id); found.push(model) }
          const cursor = message.result?.nextCursor
          if (typeof cursor === 'string' && cursor && message.id < 101) send({ id: message.id + 1, method: 'model/list', params: { cursor, limit: 100, includeHidden: false } })
          else if (cursor) finish(new Error('unavailable'))
          else finish()
        }
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'opengrokbot', title: 'Synodica', version: '0.5.2' } } })
  })
}

async function claudeSdkModels(def: ProviderDef): Promise<Model[]> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), TIMEOUT_MS)
  const prompt = (async function* () {
    await new Promise<void>((resolve) => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
  })()
  let session: ReturnType<typeof query> | undefined
  try {
    session = query({ prompt, options: { env: claudeEnv(def), abortController: abort, settingSources: [], mcpServers: {}, tools: [], allowedTools: [], permissionMode: 'dontAsk' } })
    const models = await session.supportedModels()
    return rows(models)
  } finally {
    clearTimeout(timer)
    abort.abort()
    session?.close()
  }
}

/** Catalog lookup is requested by the picker, never by connection status polling. */
export function createProviderModelService(deps: Dependencies = {}): ((id: string, def: ProviderDef, force?: boolean) => Promise<ProviderModelCatalog>) & { inputModalities: (id: string, def: ProviderDef, model: string) => string[] | undefined } {
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? Date.now
  const cache = new Map<string, ProviderModelCatalog>()
  const inFlight = new Map<string, Promise<ProviderModelCatalog>>()
  const keyFor = (id: string, def: ProviderDef) => JSON.stringify([id, def.kind, def.baseUrl, def.authMode, def.models, createHash('sha256').update(def.apiKey ?? '').digest('hex')])
  const service = async (id: string, def: ProviderDef, force = false): Promise<ProviderModelCatalog> => {
    const key = keyFor(id, def)
    const cached = cache.get(key)
    const age = cached ? now() - cached.updatedAt : Infinity
    if (cached && age < (force ? REFRESH_COOLDOWN_MS : CACHE_MS)) return cached
    const pending = inFlight.get(key)
    if (pending) return pending
    const load = (async (): Promise<ProviderModelCatalog> => {
      const suggestions = def.kind === 'gemini' ? MODEL_SUGGESTIONS.gemini.filter((model) => model !== 'default') : []
      const configured = [...new Set([...(def.models ?? []), ...suggestions].filter((m) => m.trim()))].map((model) => ({ id: model, label: model }))
      const claudeSubscription = def.kind === 'claude' && !def.apiKey && claudeEndpointOrigin(def.baseUrl) === 'https://api.anthropic.com'
      const base = { provider: id, supportsDefault: def.kind === 'codex' || def.kind === 'gemini' || claudeSubscription, updatedAt: now() }
      try {
        let models: Model[]
        let source: ProviderModelCatalog['source']
        if (def.kind === 'codex') {
          models = await (deps.codexModels ?? ((provider) => queryCodexAppServerModels(undefined, ['app-server'], provider)))(def)
          source = 'cli'
        } else if (claudeSubscription) {
          models = await (deps.claudeModels ?? claudeSdkModels)(def)
          source = 'cli'
        } else if (def.kind === 'claude') {
          if (!def.apiKey) return { ...base, models: configured, source: configured.length ? 'configured' : 'unavailable', error: 'missing-credential' }
          models = await readAnthropicModels(fetchImpl, def.baseUrl ?? 'https://api.anthropic.com', def.authMode === 'auth-token' ? { authorization: `Bearer ${def.apiKey}`, 'anthropic-version': '2023-06-01' } : { 'x-api-key': def.apiKey, 'anthropic-version': '2023-06-01' }, deps.timeoutMs ?? TIMEOUT_MS)
          source = 'upstream'
        } else if (def.kind === 'gemini') {
          if (!def.apiKey) return { ...base, models: configured, source: configured.length ? 'configured' : 'unavailable', error: 'unsupported' }
          models = await readGeminiModels(fetchImpl, def.apiKey, deps.timeoutMs ?? TIMEOUT_MS)
          source = 'upstream'
        } else {
          if (!def.baseUrl) return { ...base, models: configured, source: configured.length ? 'configured' : 'unavailable', error: 'unavailable' }
          models = await readModels(fetchImpl, `${def.baseUrl.replace(/\/+$/, '')}/models`, { authorization: `Bearer ${def.apiKey ?? 'none'}` }, deps.timeoutMs ?? TIMEOUT_MS)
          source = 'upstream'
        }
        return { ...base, models, source }
      } catch (error) {
        const reason = error instanceof Error && error.message === 'unsupported' ? 'unsupported' : 'unavailable'
        return { ...base, models: configured, source: configured.length ? 'configured' : 'unavailable', error: reason }
      }
    })()
    inFlight.set(key, load)
    try {
      const value = await load
      cache.set(key, value)
      return value
    } finally {
      inFlight.delete(key)
    }
  }
  return Object.assign(service, { inputModalities: (id: string, def: ProviderDef, model: string): string[] | undefined => cache.get(keyFor(id, def))?.models.find((row) => row.id === model)?.inputModalities })
}

export const providerModels = createProviderModelService()
