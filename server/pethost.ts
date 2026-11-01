/** Minimal loopback host for the pinned, unmodified dsh-pet apply(ctx) plugin. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { PetBalanceResult } from './petbridge.js'

type PetRoute = { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }
type PetApi = { balance: { register: (def: { id: string; fetch: () => Promise<PetBalanceResult> }) => () => void } }
type PetModule = { apply: (ctx: Record<string, unknown>) => void }

const home = process.env.DSH_HOME
const packageRoot = process.env.OPENGROKBOT_PET_PACKAGE_ROOT
const port = Number(process.argv[process.argv.indexOf('--port') + 1])
if (!home || !packageRoot || !Number.isInteger(port) || port < 1 || port > 65535 || !process.send) throw new Error('invalid pet host launch')

const token = randomBytes(32).toString('base64url')
const runtimeFile = path.join(home, 'dsh-pet', 'standalone-runtime.json')
const routes: PetRoute[] = []
const services = new Map<string, unknown>()
const disposers: (() => unknown)[] = []
const pending = new Map<number, { resolve: (result: PetBalanceResult) => void; timer: NodeJS.Timeout }>()
let requestId = 0
let closing = false

const unavailable = (): PetBalanceResult => ({ ok: false, provider: 'Synodica', reason: 'unsupported' })
function requestBalance(): Promise<PetBalanceResult> {
  return new Promise((resolve) => {
    const id = ++requestId
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, provider: 'Synodica', reason: 'fetch-error', message: 'The local usage snapshot did not respond.' })
    }, 3000)
    pending.set(id, { resolve, timer })
    process.send?.({ type: 'pet:balance', id }, (err) => {
      if (!err) return
      clearTimeout(timer)
      pending.delete(id)
      resolve(unavailable())
    })
  })
}

process.on('message', (message: unknown) => {
  const reply = message as { type?: unknown; id?: unknown; result?: unknown } | null
  if (reply?.type !== 'pet:balance:reply' || typeof reply.id !== 'number') return
  const waiting = pending.get(reply.id)
  if (!waiting) return
  pending.delete(reply.id)
  clearTimeout(waiting.timer)
  const result = reply.result as PetBalanceResult | undefined
  waiting.resolve(result && typeof result === 'object' && typeof result.provider === 'string' && typeof result.ok === 'boolean' ? result : unavailable())
})

const logger = { info: (s: unknown) => console.log(String(s)), warn: (s: unknown) => console.warn(String(s)), error: (s: unknown) => console.error(String(s)) }
const server = createServer((req, res) => {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) { res.writeHead(403).end(); return }
  const supplied = req.headers['x-dsh-pet-token']
  const suppliedBytes = typeof supplied === 'string' ? Buffer.from(supplied) : Buffer.alloc(0)
  const tokenBytes = Buffer.from(token)
  if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) { res.writeHead(403).end(); return }
  const pathname = (() => { try { return new URL(req.url ?? '/', `http://${host}`).pathname } catch { return '' } })()
  if (pathname === '/health' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ name: 'synodica-pet-host', pid: process.pid, plugin: { root: packageRoot, version: '0.3.8' } }))
    return
  }
  if (pathname === '/shutdown' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json')
    res.end('{"ok":true}')
    setImmediate(() => { void shutdown() })
    return
  }
  const route = routes.find((item) => item.kind === 'prefix' ? (pathname === item.path || pathname.startsWith(`${item.path}/`)) : pathname === item.path)
  if (!route) { res.writeHead(404).end(); return }
  void Promise.resolve().then(() => route.handler(req, res)).catch((error: unknown) => {
    logger.error(error instanceof Error ? error.message : String(error))
    if (!res.writableEnded && !res.destroyed) res.writeHead(500).end()
  })
})

const ctx: Record<string, unknown> = {
  effect(fn: () => unknown) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose as () => unknown)
    return dispose
  },
  provide(name: string, value: unknown) { services.set(name, value); return () => services.delete(name) },
  get(name: string) { return services.get(name) },
  on() { return () => {} },
  logger,
  webServer: { get port() { return port }, register(route: PetRoute) { routes.push(route); return () => { const at = routes.indexOf(route); if (at >= 0) routes.splice(at, 1) } } },
  connection: { authenticatedUrl: (origin: string) => origin },
  commands: { register: () => () => {} },
  agentDefaultModel: { currentSelection: () => ({ provider: 'synodica', model: '' }) },
  credentials: { resolve: async () => undefined },
  llm: {
    listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => undefined,
    stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => { throw new Error('Pet model calls are disabled in Synodica') } }) }),
  },
}

async function shutdown(): Promise<void> {
  if (closing) return
  closing = true
  for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.resolve(unavailable()) }
  pending.clear()
  for (const dispose of disposers.reverse()) try { await dispose() } catch (error) { logger.warn(error) }
  await new Promise<void>((resolve) => server.close(() => resolve()))
  try { unlinkSync(runtimeFile) } catch { /* host may have exited before publishing */ }
  process.exit(0)
}

process.on('SIGTERM', () => { void shutdown() })
process.on('SIGINT', () => { void shutdown() })
process.on('disconnect', () => { void shutdown() })

await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
const plugin = await import(pathToFileURL(path.join(packageRoot, 'lib', 'index.js')).href) as PetModule
plugin.apply(ctx)
const api = services.get('petApi7340') as PetApi | undefined
if (!api?.balance?.register) throw new Error('The pinned pet does not expose balance.register')
disposers.push(api.balance.register({ id: 'synodica', fetch: requestBalance }))
mkdirSync(path.dirname(runtimeFile), { recursive: true })
const temporary = `${runtimeFile}.${process.pid}.tmp`
writeFileSync(temporary, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 })
renameSync(temporary, runtimeFile)
