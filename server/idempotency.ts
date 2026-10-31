// Stable client request ids for writes. A client sends the same Idempotency-Key when it resends a
// write (a flaky phone network, a page refresh with an unsent message in its outbox, a second click
// on another device that shares the id); the server runs the write once and answers every repeat
// with the first answer. A key reused for a different request is refused. Completed answers are
// kept on disk for a day, so a resend after a server restart does not dispatch the work again.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { isRequestId, stableJson } from '../shared/sync.js'

export interface StoredResponse {
  status: number
  body: unknown
}

interface Entry {
  fingerprint: string
  at: number
  response?: StoredResponse
  waiters?: ((r: StoredResponse | undefined) => void)[]
}

/** Bodies above this size are not kept for replay; a repeat then gets a short "already done" answer. */
const MAX_BODY_CHARS = 64 * 1024

export interface IdempotencyOptions {
  ttlMs?: number
  max?: number
  now?: () => number
}

export class IdempotencyStore {
  private readonly entries = new Map<string, Entry>()
  private readonly ttlMs: number
  private readonly max: number
  private readonly now: () => number

  constructor(
    private readonly file?: string,
    opts: IdempotencyOptions = {},
  ) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60_000
    this.max = opts.max ?? 2000
    this.now = opts.now ?? Date.now
    this.load()
  }

  size(): number {
    return this.entries.size
  }

  /** Express middleware for writes (POST, PUT, PATCH, DELETE) that carry an Idempotency-Key header. */
  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next()
      const raw = req.headers['idempotency-key']
      if (raw === undefined) return next()
      if (!isRequestId(raw)) {
        res.status(400).json({ error: 'Idempotency-Key must be 8-128 letters, digits, - or _', code: 'bad-request-id' })
        return
      }
      const fingerprint = fingerprintOf(req)
      this.prune()
      const hit = this.entries.get(raw)
      if (hit) {
        if (hit.fingerprint !== fingerprint) {
          res.status(422).json({ error: 'this request id was already used for a different request', code: 'idempotency-mismatch' })
          return
        }
        if (hit.response) return replay(res, hit.response)
        // The first request is still running: answer this repeat when it finishes.
        hit.waiters ??= []
        hit.waiters.push((r) => {
          if (r) replay(res, r)
          else if (!res.headersSent) res.status(409).json({ error: 'the first attempt of this request failed; send it again', code: 'retry' })
        })
        return
      }
      const entry: Entry = { fingerprint, at: this.now() }
      this.entries.set(raw, entry)
      const json = res.json.bind(res)
      let captured = false
      res.json = (body: unknown) => {
        if (!captured) {
          captured = true
          this.complete(raw, entry, { status: res.statusCode, body })
        }
        return json(body)
      }
      // Any other ending (a stream, a file, a closed socket) is not replayable: forget the key.
      res.on('close', () => {
        if (!captured) this.complete(raw, entry, undefined)
      })
      next()
    }
  }

  private complete(key: string, entry: Entry, response: StoredResponse | undefined): void {
    const waiters = entry.waiters ?? []
    delete entry.waiters
    // Server errors are not remembered: the client may try again.
    if (!response || response.status >= 500) {
      if (this.entries.get(key) === entry) this.entries.delete(key)
      for (const w of waiters) w(undefined)
      return
    }
    const text = JSON.stringify(response.body ?? null)
    entry.response = text.length <= MAX_BODY_CHARS ? response : { status: response.status, body: { ok: response.status < 400, replayed: true } }
    for (const w of waiters) w(entry.response)
    this.save()
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs
    for (const [k, e] of this.entries) if (e.at < cutoff && e.response) this.entries.delete(k)
    while (this.entries.size > this.max) {
      const oldest = [...this.entries.entries()].find(([, e]) => e.response)
      if (!oldest) break
      this.entries.delete(oldest[0])
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { version?: unknown; entries?: [string, { fingerprint: string; at: number; response: StoredResponse }][] }
      if (raw.version !== 1 || !Array.isArray(raw.entries)) return
      for (const [k, e] of raw.entries) {
        if (isRequestId(k) && typeof e?.fingerprint === 'string' && typeof e.at === 'number' && e.response && typeof e.response.status === 'number') this.entries.set(k, { fingerprint: e.fingerprint, at: e.at, response: e.response })
      }
      this.prune()
    } catch {
      // A damaged file only loses replay protection for older requests.
    }
  }

  private save(): void {
    if (!this.file) return
    const entries = [...this.entries.entries()].filter(([, e]) => e.response).map(([k, e]) => [k, { fingerprint: e.fingerprint, at: e.at, response: e.response }])
    const tmp = `${this.file}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }), { mode: 0o600 })
      renameSync(tmp, this.file)
    } catch (err) {
      console.warn('[idempotency] could not save:', err instanceof Error ? err.message : err)
    }
  }
}

function replay(res: Response, r: StoredResponse): void {
  if (res.headersSent) return
  res.setHeader('Idempotent-Replayed', 'true')
  res.status(r.status).json(r.body)
}

/** Same method, path, query and body = the same request. Raw uploads are identified by method and path. */
export function fingerprintOf(req: Pick<Request, 'method' | 'originalUrl' | 'body'>): string {
  const body = req.body === undefined || Buffer.isBuffer(req.body) ? '' : stableJson(req.body)
  return createHash('sha256').update(`${req.method} ${req.originalUrl}\n${body}`).digest('hex')
}
