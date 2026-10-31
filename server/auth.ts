// Sign-in for a shared office behind an HTTPS reverse proxy. The existing access token
// (OPENGROKBOT_TOKEN) stays the one secret: a browser exchanges it once, in a POST body, for a
// random session cookie (HttpOnly, SameSite=Lax, Secure over HTTPS). The token never appears in a
// URL, so it never lands in browser history, proxy access logs or Referer headers. Programs (the
// desktop app's main process, scripts, webhooks) may keep sending `Authorization: Bearer <token>`.
// Every write must come from an allowed origin; cross-site requests and wildcard CORS are refused.
// Nothing here reads or changes any model provider login or key.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { IncomingHttpHeaders } from 'node:http'
import type { NextFunction, Request, Response } from 'express'
import { detectLocale, translate, type Locale } from '../shared/i18n.js'

export const SESSION_COOKIE = 'ogb_session'
/** The cookie earlier versions set from `?token=` (it held the token itself); upgraded to a session on sight. */
export const LEGACY_COOKIE = 'ogb_token'

export type AuthVia = 'none' | 'session' | 'bearer'

export interface AuthOptions {
  /** The configured access token, or null for a local office without sign-in (loopback only). */
  token: string | null
  /** Where hashed session ids are kept (survives a graceful restart). */
  file?: string
  /** Origins allowed to write besides the request's own (e.g. https://office.example.com). */
  allowedOrigins?: string[]
  /** Behind a reverse proxy on this host: honour X-Forwarded-Proto / -Host / -For. */
  trustProxy?: boolean
  sessionTtlMs?: number
  now?: () => number
  /** Failed sign-ins per client address and window before 429. */
  maxFailures?: number
  failureWindowMs?: number
}

interface SessionRecord {
  hash: string
  createdAt: number
  expiresAt: number
}

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

function sameSecret(a: string, b: string): boolean {
  // Compare digests, so neither the length nor the content leaks through timing.
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest())
}

export function readCookie(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers.cookie
  if (typeof raw !== 'string') return undefined
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== name) continue
    try {
      return decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      return undefined
    }
  }
  return undefined
}

function first(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v
  return s?.split(',')[0]?.trim() || undefined
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
}

/** The origin this request was addressed to (behind a trusted proxy: the public one). */
export function requestOrigin(req: { headers: IncomingHttpHeaders; socket?: object }, trustProxy: boolean): string | undefined {
  const proto = (trustProxy ? first(req.headers['x-forwarded-proto']) : undefined) ?? ((req.socket as { encrypted?: boolean } | undefined)?.encrypted ? 'https' : 'http')
  const host = (trustProxy ? first(req.headers['x-forwarded-host']) : undefined) ?? first(req.headers.host)
  if (!host || (proto !== 'http' && proto !== 'https')) return undefined
  return `${proto}://${host}`.toLowerCase()
}

/**
 * Whether a state-changing request may proceed. Cross-site fetch metadata is always refused. A
 * browser Origin must be this server's own origin or a configured one. Without an Origin, only
 * non-cookie callers (a bearer token, or a
 * local office without sign-in) pass, unless fetch metadata says the request is same-origin.
 */
export function writeAllowed(req: { headers: IncomingHttpHeaders; socket?: object }, via: AuthVia, opts: Pick<AuthOptions, 'allowedOrigins' | 'trustProxy'>): boolean {
  const site = first(req.headers['sec-fetch-site'])
  if (site === 'cross-site') return false
  const origin = first(req.headers.origin)
  if (origin === undefined) return via !== 'session' || site === 'same-origin'
  if (origin === 'null') return false
  const o = origin.toLowerCase()
  if ((opts.allowedOrigins ?? []).some((a) => a.toLowerCase() === o)) return true
  const own = requestOrigin(req, opts.trustProxy === true)
  if (own && o === own) return true
  return false
}

/** Normalize configured origins: scheme://host[:port] only, https unless loopback. Bad entries are dropped. */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  const out: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim()
    if (!v) continue
    try {
      const u = new URL(v)
      if (u.origin === 'null' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) continue
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) continue
      out.push(u.origin)
    } catch {
      // ignored
    }
  }
  return out
}

export class Auth {
  private sessions = new Map<string, SessionRecord>()
  private readonly failures = new Map<string, { count: number; since: number }>()
  private readonly now: () => number
  private readonly ttl: number

  constructor(readonly opts: AuthOptions) {
    this.now = opts.now ?? Date.now
    this.ttl = opts.sessionTtlMs ?? 30 * 24 * 60 * 60_000
    this.load()
  }

  get required(): boolean {
    return this.opts.token !== null
  }

  /** How this request is authenticated, if at all. */
  identify(req: Pick<Request, 'headers'>): AuthVia | undefined {
    const token = this.opts.token
    if (token === null) return 'none'
    const sid = readCookie(req.headers, SESSION_COOKIE)
    if (sid && this.validSession(sid)) return 'session'
    const auth = req.headers.authorization
    if (typeof auth === 'string' && /^Bearer\s+/i.test(auth) && sameSecret(auth.replace(/^Bearer\s+/i, '').trim(), token)) return 'bearer'
    return undefined
  }

  /** Paths reachable without signing in: health probes and the sign-in endpoints themselves. */
  static isPublic(method: string, p: string): boolean {
    if ((method === 'GET' || method === 'HEAD') && (p === '/healthz' || p === '/readyz')) return true
    if ((p === '/api/session' || p === '/api/auth/login' || p === '/api/auth/status') && (method === 'GET' || method === 'POST' || method === 'DELETE')) return true
    return false
  }

  /** Access control for every route. Pages get the sign-in form; API calls get 401. */
  middleware(loginPage: (locale: Locale, failed: boolean) => string) {
    return (req: Request, res: Response, next: NextFunction) => {
      let via = this.identify(req)
      res.locals.authVia = via
      // An unauthenticated write can only reach the sign-in endpoint; a browser Origin is still checked there.
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && !writeAllowed(req, via ?? 'none', this.opts)) {
        res.status(403).json({ error: 'cross-site request refused', code: 'origin' })
        return
      }
      if (via || Auth.isPublic(req.method, req.path)) return next()
      if (req.path.startsWith('/api/') || req.path.startsWith('/dsh-pet')) {
        res.status(401).json({ error: 'sign in first', code: 'unauthorized' })
        return
      }
      const locale = detectLocale(null, acceptLanguages(req.headers['accept-language']))
      res.status(401).setHeader('Cache-Control', 'no-store')
      res.type('html').send(loginPage(locale, req.query.login === 'failed'))
    }
  }

  /** POST /api/session: { token } as JSON (programs) or a form post (the sign-in page). */
  login(req: Request, res: Response): void {
    const form = !req.is('application/json')
    if (this.opts.token === null) {
      res.json({ authenticated: true })
      return
    }
    const who = req.ip ?? 'unknown'
    const f = this.failures.get(who)
    const windowMs = this.opts.failureWindowMs ?? 15 * 60_000
    if (f && this.now() - f.since < windowMs && f.count >= (this.opts.maxFailures ?? 10)) {
      res.setHeader('Retry-After', String(Math.ceil((f.since + windowMs - this.now()) / 1000)))
      if (form) res.redirect(303, '/?login=failed')
      else res.status(429).json({ error: 'too many failed sign-ins; wait and try again', code: 'rate-limited' })
      return
    }
    const given = typeof (req.body as { token?: unknown } | undefined)?.token === 'string' ? ((req.body as { token: string }).token.trim()) : ''
    if (!given || !sameSecret(given, this.opts.token)) {
      const cur = f && this.now() - f.since < windowMs ? f : { count: 0, since: this.now() }
      cur.count++
      this.failures.set(who, cur)
      if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value as string)
      if (form) res.redirect(303, '/?login=failed')
      else res.status(401).json({ error: 'wrong access token', code: 'unauthorized' })
      return
    }
    this.failures.delete(who)
    this.issue(req, res)
    if (form) res.redirect(303, '/')
    else res.json({ authenticated: true })
  }

  /** DELETE /api/session: sign this browser out (the session is removed on the server too). */
  logout(req: Request, res: Response): void {
    const sid = readCookie(req.headers, SESSION_COOKIE)
    if (sid) {
      this.sessions.delete(sha(sid))
      this.save()
    }
    res.setHeader('Set-Cookie', this.cookie(req, '', 0))
    res.json({ authenticated: false })
  }

  /** Number of live sessions (tests, health). */
  sessionCount(): number {
    this.prune()
    return this.sessions.size
  }

  private issue(req: Request, res: Response): void {
    const sid = randomBytes(32).toString('base64url')
    const now = this.now()
    this.sessions.set(sha(sid), { hash: sha(sid), createdAt: now, expiresAt: now + this.ttl })
    this.prune()
    this.save()
    const cookies = [this.cookie(req, sid, Math.floor(this.ttl / 1000))]
    if (readCookie(req.headers, LEGACY_COOKIE) !== undefined) cookies.push(`${LEGACY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
    res.setHeader('Set-Cookie', cookies)
  }

  private cookie(req: Request, value: string, maxAge: number): string {
    const secure = requestOrigin(req, this.opts.trustProxy === true)?.startsWith('https:') ?? false
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
  }

  private validSession(sid: string): boolean {
    if (sid.length > 200) return false
    const rec = this.sessions.get(sha(sid))
    if (!rec) return false
    if (rec.expiresAt <= this.now()) {
      this.sessions.delete(rec.hash)
      return false
    }
    return true
  }

  private prune(): void {
    const now = this.now()
    for (const [k, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(k)
    while (this.sessions.size > 100) this.sessions.delete(this.sessions.keys().next().value as string)
  }

  /** Sessions are bound to the token they were issued under: changing the token signs everyone out. */
  private tokenTag(): string {
    return this.opts.token === null ? '' : sha(`opengrokbot-session\0${this.opts.token}`).slice(0, 16)
  }

  private load(): void {
    const file = this.opts.file
    if (!file || !existsSync(file) || this.opts.token === null) return
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; tag?: unknown; sessions?: SessionRecord[] }
      if (raw.version !== 1 || raw.tag !== this.tokenTag() || !Array.isArray(raw.sessions)) return
      for (const s of raw.sessions) if (typeof s?.hash === 'string' && /^[a-f0-9]{64}$/.test(s.hash) && typeof s.expiresAt === 'number') this.sessions.set(s.hash, s)
      this.prune()
    } catch {
      // unreadable: everyone signs in again
    }
  }

  private save(): void {
    const file = this.opts.file
    if (!file || this.opts.token === null) return
    try {
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, tag: this.tokenTag(), sessions: [...this.sessions.values()] }), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch (err) {
      console.warn('[auth] could not save sessions:', err instanceof Error ? err.message : err)
    }
  }
}

export function acceptLanguages(header: string | string[] | undefined): string[] {
  const v = Array.isArray(header) ? header.join(',') : (header ?? '')
  return v
    .split(',')
    .map((s) => s.split(';')[0]?.trim() ?? '')
    .filter(Boolean)
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

/** The sign-in page: a plain form that POSTs the token in the body (no script, no token in the URL). */
export function loginPage(locale: Locale, failed: boolean): string {
  const t = (k: Parameters<typeof translate>[1]) => esc(translate(locale, k))
  return `<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>Synodica</title>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f5f5f7;color:#1d1d1f;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box">
<form method="post" action="/api/session" style="display:flex;flex-direction:column;gap:18px;width:100%;max-width:380px;padding:32px;box-sizing:border-box;background:#fff;border:1px solid #e5e5ea;border-radius:20px;box-shadow:0 18px 48px rgba(29,29,31,.08)">
<h1 style="font-size:26px;letter-spacing:-.03em;margin:0">${t('auth.title')}</h1>
<p style="margin:0;color:#6e6e73;font-size:14px;line-height:1.5">${t('auth.hint')}</p>
${failed ? `<p role="alert" style="margin:0;color:#c93434;font-size:14px;line-height:1.4">${t('auth.failed')}</p>` : ''}
<label style="display:flex;flex-direction:column;gap:8px;font-size:13px;font-weight:600">${t('auth.token')}<input name="token" type="password" autocomplete="current-password" required autofocus style="padding:13px 14px;border-radius:11px;border:1px solid #d2d2d7;background:#fff;color:#1d1d1f;font-size:16px;outline-color:#007aff"></label>
<button style="padding:13px 16px;border-radius:11px;border:0;background:#007aff;color:#fff;font-weight:600;font-size:16px;cursor:pointer">${t('auth.signIn')}</button>
</form></body></html>`
}
