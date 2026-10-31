// HTTP routes of the account usage dashboard. They sit behind the app's access control (the
// OPENGROKBOT_TOKEN middleware) and only ever return the sanitized report: no key, token, response
// body, header or raw error. Writes are refused from other sites, so a web page cannot trigger
// queries (or the consented Claude login read) through your browser.
import express from 'express'
import type { IncomingMessage } from 'node:http'
import type { UsageMeter } from './usagemeter.js'

const KEY = /^[A-Za-z0-9_-]{1,80}$/

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

/**
 * A browser write must come from this app: same origin, or (the Vite dev proxy rewrites Host) a
 * loopback page talking to a loopback server. A request without Origin is a non-browser client,
 * which already passed the token check. Cross-site fetch metadata is always refused.
 */
export function usageWriteAllowed(headers: IncomingMessage['headers']): boolean {
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  if (typeof origin !== 'string' || typeof headers.host !== 'string') return false
  if (origin === `http://${headers.host}` || origin === `https://${headers.host}`) return true
  try {
    const o = new URL(origin)
    const h = new URL(`http://${headers.host}`)
    return o.protocol === 'http:' && isLoopbackHost(o.hostname) && isLoopbackHost(h.hostname)
  } catch {
    return false
  }
}

export type ParsedKeys = { ok: true; keys?: string[] } | { ok: false }

/**
 * The account scope of a request body. An omitted `keys` property means every account; a supplied
 * one must be an array of at most 50 plain ids, and an empty array scopes to no account at all.
 * A malformed list is refused as a whole: it is never filtered down, and never widened to "all".
 */
export function parseKeys(body: unknown): ParsedKeys {
  if (body === undefined || body === null) return { ok: true }
  if (typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  if (!Object.prototype.hasOwnProperty.call(body, 'keys')) return { ok: true }
  const raw = (body as { keys?: unknown }).keys
  if (!Array.isArray(raw) || raw.length > 50) return { ok: false }
  if (!raw.every((k): k is string => typeof k === 'string' && KEY.test(k))) return { ok: false }
  return { ok: true, keys: [...new Set(raw)] }
}

const BAD_KEYS = { error: 'keys must be a list of at most 50 account ids' }

export function usageRouter(meter: Pick<UsageMeter, 'report' | 'refresh' | 'cancel' | 'updateSettings'>): express.Router {
  const r = express.Router()
  r.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD' && !usageWriteAllowed(req.headers)) {
      res.status(403).json({ error: 'cross-site usage request refused' })
      return
    }
    res.setHeader('Cache-Control', 'no-store')
    next()
  })
  r.get('/accounts', (_req, res) => {
    res.json(meter.report())
  })
  r.post('/refresh', async (req, res) => {
    const scope = parseKeys(req.body)
    if (!scope.ok) {
      res.status(400).json(BAD_KEYS)
      return
    }
    try {
      res.json(await meter.refresh({ manual: true, ...(scope.keys ? { keys: scope.keys } : {}) }))
    } catch {
      // Never echo the cause: it could come from a provider response.
      res.status(500).json({ error: 'the usage refresh failed' })
    }
  })
  r.post('/cancel', (req, res) => {
    const scope = parseKeys(req.body)
    if (!scope.ok) {
      res.status(400).json(BAD_KEYS)
      return
    }
    res.json({ cancelled: meter.cancel(scope.keys) })
  })
  r.put('/settings', (req, res) => {
    res.json({ settings: meter.updateSettings(req.body ?? {}) })
  })
  return r
}
