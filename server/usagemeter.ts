// Account usage, quotas and balances for every configured provider, from read-only sources only:
// official HTTPS endpoints at fixed origins, the installed Codex CLI's app-server protocol, and (with
// your explicit consent) Claude Code's own login file. No model is ever called to learn a quota, no
// account, model, credential or configuration is changed, and nothing is bought, reset or e-mailed.
// Request handling (bounded body, redirect refusal, per-account de-duplication) follows the approach
// of dsh-model-meter 0.6.1 (MIT); see THIRD_PARTY_NOTICES.md.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { translate, type Locale, type MessageKey } from '../shared/i18n.js'
import type { ProviderDef, Team, UsageSummary } from '../shared/types.js'
import {
  classifyProvider,
  countdownParts,
  DEFAULT_USAGE_SETTINGS,
  formatPercent,
  isUsageReason,
  newlyLow,
  safeReasonVars,
  parseClaudeUsage,
  parseCodexAccount,
  parseCodexRateLimits,
  parseDeepSeekBalance,
  parseKimiUsage,
  parseMoonshotBalance,
  parseUsageSettings,
  tightestWindow,
  USAGE_ORIGINS,
  type Classification,
  type ReasonVars,
  type UsageReason,
  type UsageReport,
  type UsageRow,
  type UsageSettings,
  type UsageSnapshot,
  type UsageState,
  type UsageWindow,
} from '../shared/usage.js'

const MAX_BODY = 1024 * 1024
const USER_AGENT = 'Synodica-usage/1'

/** English text of a reason id (the API's `detail`; the page translates the id itself). */
export function reasonText(reason: UsageReason, vars?: ReasonVars): string {
  return translate('en', `quota.reason.${reason}`, vars ?? {})
}

/**
 * A failure with a state the UI can show and a fixed reason id (plus numeric / token parameters).
 * Its English `detail` is rendered from the locale resource, so it never contains a body, header,
 * token or key. A free text (only in tests) is kept as the detail with no reason id.
 */
export class UsageFailure extends Error {
  readonly reason?: UsageReason
  readonly vars?: ReasonVars
  readonly detail: string
  readonly retryAfterMs?: number
  constructor(
    readonly state: UsageState,
    reason: UsageReason | string,
    opts: { vars?: Record<string, unknown>; retryAfterMs?: number } = {},
  ) {
    const id = isUsageReason(reason) ? reason : undefined
    const vars = safeReasonVars(opts.vars)
    const detail = id ? reasonText(id, vars) : reason
    super(detail)
    this.detail = detail
    if (id) this.reason = id
    if (vars) this.vars = vars
    if (opts.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs
  }
}

export type FetchLike = (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>

/** Retry-After: delta seconds or an HTTP date, clamped to 1 s .. 1 h. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined
  const v = header.trim()
  let ms: number | undefined
  if (/^\d+$/.test(v)) ms = Number(v) * 1000
  else {
    const at = Date.parse(v)
    if (Number.isFinite(at)) ms = at - now
  }
  if (ms === undefined || !Number.isFinite(ms)) return undefined
  return Math.min(3600_000, Math.max(1000, ms))
}

async function readBounded(res: Response): Promise<unknown> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body?.cancel().catch(() => {})
    throw new UsageFailure('invalid-response', 'too-large')
  }
  const reader = res.body?.getReader()
  if (!reader) throw new UsageFailure('invalid-response', 'no-body')
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {})
        throw new UsageFailure('invalid-response', 'too-large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new UsageFailure('invalid-response', 'not-json')
  }
}

/**
 * One read-only GET to a fixed official origin. Redirects are refused (a credential never follows
 * one), the body is bounded, and failures are classified without echoing anything from the response.
 */
export async function getJson(fetchImpl: FetchLike, url: string, headers: Record<string, string>, signal: AbortSignal, now: () => number): Promise<unknown> {
  const origin = new URL(url).origin
  if (!USAGE_ORIGINS.has(origin) || !url.startsWith('https://')) throw new UsageFailure('error', 'endpoint-refused')
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json', 'User-Agent': USER_AGENT, ...headers }, redirect: 'manual', signal })
  } catch (err) {
    if (signal.aborted) throw new UsageFailure(signal.reason === 'timeout' ? 'timeout' : 'error', signal.reason === 'timeout' ? 'timeout' : 'cancelled')
    if (err instanceof Error && /redirect/i.test(err.message)) throw new UsageFailure('redirect-refused', 'redirect')
    throw new UsageFailure('network', 'network')
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => {})
    throw new UsageFailure('redirect-refused', 'redirect-status', { vars: { status: res.status } })
  }
  if (res.type === 'opaqueredirect' || res.redirected) throw new UsageFailure('redirect-refused', 'redirect')
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    if (res.status === 401) throw new UsageFailure('auth-failed', 'http-401')
    if (res.status === 403) throw new UsageFailure('auth-failed', 'http-403')
    if (res.status === 429) throw new UsageFailure('rate-limited', 'http-429', { retryAfterMs: retryAfterMs(res.headers.get('retry-after'), now()) ?? 60_000 })
    if (res.status === 404) throw new UsageFailure('unsupported', 'http-404')
    throw new UsageFailure('http-error', 'http-status', { vars: { status: res.status } })
  }
  return readBounded(res)
}

// ---------- Codex: the installed CLI's official app-server protocol ----------

export interface CodexQuery {
  account: unknown
  rateLimits?: unknown
}

/**
 * Ask the installed Codex CLI (`codex app-server`, JSON-RPC over stdio) for the signed-in account
 * and its plan limits: initialize / initialized, account/read with refreshToken false, then
 * account/rateLimits/read. Nothing else is called: no thread, turn, login, logout or config change.
 * Output lines are never logged; the arguments carry no secret.
 */
export function queryCodexAppServer(opts: { command?: string; env?: NodeJS.ProcessEnv; signal: AbortSignal }): Promise<CodexQuery> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {}
    for (const [k, v] of Object.entries(opts.env ?? process.env)) if (!k.startsWith('OPENGROKBOT_')) env[k] = v
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(opts.command ?? 'codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      reject(new UsageFailure('cli-missing', 'codex-missing'))
      return
    }
    let settled = false
    let buffer = ''
    let stderrTail = ''
    let account: unknown
    const finish = (err: UsageFailure | undefined, value?: CodexQuery) => {
      if (settled) return
      settled = true
      opts.signal.removeEventListener('abort', onAbort)
      try {
        child.stdin?.end()
      } catch {
        // already closed
      }
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      if (err) reject(err)
      else resolve(value as CodexQuery)
    }
    const send = (msg: Record<string, unknown>) => {
      try {
        child.stdin?.write(`${JSON.stringify(msg)}\n`)
      } catch {
        finish(new UsageFailure('error', 'codex-talk'))
      }
    }
    const onAbort = () => finish(new UsageFailure(opts.signal.reason === 'timeout' ? 'timeout' : 'error', opts.signal.reason === 'timeout' ? 'codex-timeout' : 'cancelled'))
    if (opts.signal.aborted) return onAbort()
    opts.signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (err: NodeJS.ErrnoException) => finish(err.code === 'ENOENT' ? new UsageFailure('cli-missing', 'codex-missing') : new UsageFailure('error', 'codex-start')))
    // A CLI that exits at once (an old version) must not crash the server with EPIPE on our request.
    child.stdin?.on('error', () => {})
    // "close", not "exit": stderr is fully read by then, so an unknown subcommand is recognized.
    child.once('close', (code) => {
      if (/unrecognized subcommand|unknown command|invalid subcommand/i.test(stderrTail)) finish(new UsageFailure('unsupported', 'codex-no-app-server'))
      else finish(new UsageFailure('error', 'codex-exited', { vars: { code: code ?? 'signal' } }))
    })
    child.stderr?.on('data', (c: Buffer) => {
      stderrTail = (stderrTail + c.toString('utf8')).slice(-2000)
    })
    child.stdout?.on('data', (c: Buffer) => {
      buffer += c.toString('utf8')
      if (buffer.length > MAX_BODY) return finish(new UsageFailure('invalid-response', 'codex-too-much'))
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: { id?: unknown; result?: unknown; error?: { code?: unknown } }
        try {
          msg = JSON.parse(line) as typeof msg
        } catch {
          continue
        }
        if (msg.id === undefined) continue // notifications (e.g. account/rateLimits/updated)
        if (msg.error) {
          const code = typeof msg.error.code === 'number' ? msg.error.code : undefined
          if (code === -32601) return finish(new UsageFailure('unsupported', 'codex-old'))
          return finish(code !== undefined ? new UsageFailure('error', 'codex-refused-code', { vars: { code } }) : new UsageFailure('error', 'codex-refused'))
        }
        if (msg.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/read', params: { refreshToken: false } })
        } else if (msg.id === 2) {
          account = msg.result
          const kind = parseCodexAccount(account).kind
          if (kind !== 'chatgpt') return finish(undefined, { account })
          send({ id: 3, method: 'account/rateLimits/read' })
        } else if (msg.id === 3) return finish(undefined, { account, rateLimits: msg.result })
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'opengrokbot', title: 'Synodica', version: '0.3.0' } } })
  })
}

// ---------- Claude Code login file (explicit consent only) ----------

export type ClaudeLogin = { ok: true; accessToken: string; expiresAt?: number; plan?: string; identity: string } | { ok: false; state: 'auth-missing' | 'auth-failed'; detail: string; reason?: UsageReason }

/**
 * Read Claude Code's own login (claudeAiOauth in <CLAUDE_CONFIG_DIR or ~/.claude>/.credentials.json),
 * only when you turned on the consent switch. The token stays in this process for one request; it
 * is never stored, logged or refreshed (refreshing would rotate Claude Code's own login). The macOS
 * Keychain is not read.
 */
export function readClaudeLogin(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): ClaudeLogin {
  const dir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(home, '.claude')
  const file = path.join(dir, '.credentials.json')
  if (!existsSync(file)) {
    const reason: UsageReason = platform === 'darwin' ? 'claude-keychain' : 'claude-no-file'
    return { ok: false, state: 'auth-missing', reason, detail: reasonText(reason) }
  }
  try {
    if (statSync(file).size > MAX_BODY) throw new Error('too large')
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; subscriptionType?: unknown } }
    const o = raw.claudeAiOauth
    if (!o || typeof o.accessToken !== 'string' || !o.accessToken.trim()) return { ok: false, state: 'auth-missing', reason: 'claude-no-subscription', detail: reasonText('claude-no-subscription') }
    let account: string | undefined
    try {
      const meta = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')) as { oauthAccount?: { accountUuid?: unknown } }
      if (typeof meta.oauthAccount?.accountUuid === 'string') account = meta.oauthAccount.accountUuid
    } catch {
      account = undefined
    }
    const identity = sha(`claude\0${account ?? (typeof o.refreshToken === 'string' ? o.refreshToken : o.accessToken)}`)
    const plan = typeof o.subscriptionType === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(o.subscriptionType) ? o.subscriptionType : undefined
    return { ok: true, accessToken: o.accessToken, ...(typeof o.expiresAt === 'number' ? { expiresAt: o.expiresAt } : {}), ...(plan ? { plan } : {}), identity }
  } catch {
    return { ok: false, state: 'auth-failed', reason: 'claude-unreadable', detail: reasonText('claude-unreadable') }
  }
}

// ---------- the service ----------

function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

const FALLBACK_PROVIDER: ProviderDef = { kind: 'claude', label: 'Claude (subscription)' }

/** Accounts whose identity is only learned by querying the signed-in CLI or login (not from a key). */
function loginBound(c: Classification): boolean {
  return c.binding === 'cli-login' || c.binding === 'claude-login-file'
}

/**
 * Settle as soon as `signal` aborts, even when the work underneath ignores it (a stuck CLI or a
 * transport that never rejects): a late answer is then discarded, never committed.
 */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {})
  const reason = () => (signal.reason === 'timeout' ? new UsageFailure('timeout', 'timeout') : new UsageFailure('error', 'cancelled'))
  if (signal.aborted) return Promise.reject(reason())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(reason())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}

interface RowPlan {
  row: UsageRow
  c: Classification
  /** The credential to send (only for queryable keyed accounts). Never leaves this module. */
  key?: string
  /** Known before a query for keyed accounts; learned from the response for CLI / login accounts. */
  identity?: string
}

interface AccountState {
  identity?: string
  snapshot?: UsageSnapshot
  state?: UsageState
  reason?: UsageReason
  reasonVars?: ReasonVars
  /** English text of a failure without a reason id (only test doubles throw those). */
  detail?: string
  cached?: boolean
  /**
   * CLI / login accounts only: the sample belongs to the account signed in now, as confirmed by the
   * latest query of this process. A cached or older sample stays hidden until it is confirmed.
   */
  confirmed?: boolean
  lastAttemptAt?: number
  nextAllowedAt?: number
  retryAfterUntil?: number
  failures: number
  flight?: Promise<void>
}

export interface UsageMeterDeps {
  getTeam: () => Team
  dataDir: string
  localUsage?: () => UsageSummary
  fetchImpl?: FetchLike
  codex?: (signal: AbortSignal) => Promise<CodexQuery>
  claudeLogin?: () => ClaudeLogin
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (h: unknown) => void
  onChange?: (report: UsageReport) => void
  /** Windows that just crossed the low-quota line (for the pet's notice). */
  onLow?: (row: UsageRow, windows: UsageWindow[]) => void
  timeoutMs?: number
  codexTimeoutMs?: number
  concurrency?: number
  /** A sample younger than this is not re-queried by the scheduler. */
  ttlMs?: number
}

/**
 * Usage rows for every configured provider and employee, grouped by account: providers and employees
 * that share one credential / login share one row and one fetched sample.
 */
export class UsageMeter {
  private readonly accounts = new Map<string, AccountState>()
  private readonly controllers = new Set<AbortController>()
  private readonly byKey = new Map<string, AbortController>()
  private settings: UsageSettings
  private timer: unknown
  private disposed = false
  private refreshing = 0
  /** Bumped on every change of the Claude login consent; a query started under another value is void. */
  private consentGen = 0
  private readonly now: () => number
  private readonly settingsFile: string
  private readonly cacheFile: string

  constructor(private readonly deps: UsageMeterDeps) {
    this.now = deps.now ?? Date.now
    mkdirSync(deps.dataDir, { recursive: true })
    this.settingsFile = path.join(deps.dataDir, 'usage-settings.json')
    this.cacheFile = path.join(deps.dataDir, 'usage-cache.json')
    this.settings = parseUsageSettings(readJson(this.settingsFile))
    this.loadCache()
  }

  getSettings(): UsageSettings {
    return { ...this.settings }
  }

  updateSettings(patch: unknown): UsageSettings {
    const hadConsent = this.settings.claudeLoginFile
    this.settings = parseUsageSettings(patch, this.settings)
    writeAtomic(this.settingsFile, JSON.stringify(this.settings, null, 2))
    if (hadConsent !== this.settings.claudeLoginFile) this.consentGen++
    if (hadConsent && !this.settings.claudeLoginFile) this.revokeConsent()
    this.schedule()
    this.changed()
    return this.getSettings()
  }

  /** Start the bounded auto-refresh (when enabled). */
  start(): void {
    // The first automatic query comes shortly after start, not one whole interval later.
    this.schedule(5_000)
  }

  /** App shutdown: no more timers, every query in flight is aborted, nothing more is written. */
  dispose(): void {
    this.disposed = true
    if (this.timer !== undefined) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = undefined
    for (const c of this.controllers) c.abort('disposed')
    this.controllers.clear()
    this.byKey.clear()
  }

  /** Cancel the queries in flight (all, or only `keys`). Their accounts keep the previous sample and state. */
  cancel(keys?: string[]): number {
    let n = 0
    for (const [key, c] of this.byKey) {
      if (keys && !keys.includes(key)) continue
      c.abort('cancelled')
      n++
    }
    return n
  }

  isDisposed(): boolean {
    return this.disposed
  }

  report(): UsageReport {
    const local = this.deps.localUsage?.()
    const rows = this.plans().map(({ row }) => {
      if (!local) return row
      let messages = 0
      let inputTokens = 0
      let outputTokens = 0
      let costUsd = 0
      for (const a of row.agents) {
        const u = local.byAgent[a.id]
        if (!u) continue
        messages += u.messages
        inputTokens += u.inputTokens + u.cacheReadTokens + u.cacheCreationTokens
        outputTokens += u.outputTokens
        costUsd += u.costUsd
      }
      return messages ? { ...row, local: { messages, inputTokens, outputTokens, costUsd } } : row
    })
    return { rows, settings: this.getSettings(), serverNow: this.now(), refreshing: this.refreshing > 0 }
  }

  /**
   * Query the accounts that have a source (all, or only `keys`). Manual refreshes skip the freshness
   * check and the error backoff, but never a provider's Retry-After. Concurrent refreshes of one
   * account share one query; at most `concurrency` accounts are queried at a time.
   */
  async refresh(opts: { keys?: string[]; manual?: boolean } = {}): Promise<UsageReport> {
    if (this.disposed) return this.report()
    const plans = this.plans().filter((p) => this.queryable(p) && (!opts.keys || opts.keys.includes(p.row.key)))
    this.refreshing++
    this.changed()
    try {
      const queue = [...plans]
      const workers = Array.from({ length: Math.max(1, Math.min(this.deps.concurrency ?? 2, queue.length)) }, async () => {
        for (let p = queue.shift(); p && !this.disposed; p = queue.shift()) await this.refreshOne(p, opts.manual === true)
      })
      await Promise.all(workers)
    } finally {
      this.refreshing--
    }
    this.changed()
    return this.report()
  }

  /** Short pet lines: the tightest window or the balance of each account with a sample. */
  petSummary(locale: Locale): string {
    const lines: string[] = []
    for (const row of this.report().rows) {
      const snap = row.snapshot
      if (!snap) continue
      const name = row.providers[0]?.label ?? usageText(locale, `quota.type.${row.type}`)
      const w = tightestWindow(snap.windows)
      let line: string | undefined
      if (w?.usedPercent !== undefined) {
        const vars = { name, window: windowName(w, locale), pct: formatPercent(w.usedPercent) }
        line = w.resetsAt !== undefined ? usageText(locale, 'usage.pet.window', { ...vars, left: localCountdown(locale, w.resetsAt - this.now()) }) : usageText(locale, 'usage.pet.windowNoReset', vars)
      } else {
        // Each currency separately, as reported; a missing total is not shown as zero.
        const amounts = snap.balances.filter((b) => b.total !== undefined).map((b) => `${b.total} ${b.currency}`)
        if (amounts.length) line = usageText(locale, 'usage.pet.balance', { name, amount: amounts.join(' / ') })
      }
      if (!line) continue
      lines.push(row.stale ? `${line}${usageText(locale, 'usage.pet.stale')}` : line)
      if (lines.length >= 4) break
    }
    return lines.length ? lines.join('\n') : usageText(locale, 'usage.pet.none')
  }

  // ---------- internals ----------

  /**
   * Consent withdrawn: abort the queries that read the login, and forget every sample, state and
   * cache entry learned from it. A late answer (even from a transport that ignores the abort) lands
   * on a detached state of an older consent generation and is dropped.
   */
  private revokeConsent(): void {
    for (const p of this.plans()) {
      if (p.c.capability !== 'consent') continue
      this.byKey.get(p.row.key)?.abort('consent-revoked')
      this.accounts.delete(p.row.key)
    }
    this.saveCache()
  }

  private queryable(p: RowPlan): boolean {
    if (p.c.capability === 'unsupported') return false
    if (p.c.capability === 'consent' && !this.settings.claudeLoginFile) return false
    if (p.c.binding === 'provider-key' || p.c.binding === 'none') return Boolean(p.key)
    return true
  }

  private state(key: string): AccountState {
    let s = this.accounts.get(key)
    if (!s) {
      s = { failures: 0 }
      this.accounts.set(key, s)
    }
    return s
  }

  /** Rows from the current team: one per account, with every provider and employee on it. */
  private plans(): RowPlan[] {
    const team = this.deps.getTeam()
    const byKey = new Map<string, RowPlan>()
    const providerIds = new Set([...Object.keys(team.providers), ...team.agents.map((a) => a.provider)])
    for (const id of providerIds) {
      const def = team.providers[id] ?? FALLBACK_PROVIDER
      const c = classifyProvider(def)
      const key = accountKey(id, def, c)
      let plan = byKey.get(key)
      if (!plan) {
        const queryKey = (c.capability === 'queryable' && (c.binding === 'provider-key' || c.binding === 'none') && def.apiKey) || undefined
        plan = {
          c,
          ...(queryKey ? { key: queryKey, identity: sha(`${c.endpoint}\0${queryKey}`) } : {}),
          row: {
            key,
            type: c.type,
            ...(c.region ? { region: c.region } : {}),
            capability: c.capability,
            ...(c.source ? { source: c.source } : {}),
            ...(c.endpoint ? { endpoint: c.endpoint } : {}),
            providers: [],
            agents: [],
            binding: { kind: c.binding, ...(c.binding === 'provider-key' ? { providerId: id } : {}) },
            state: 'not-queried',
            stale: false,
            inFlight: false,
          },
        }
        byKey.set(key, plan)
      }
      plan.row.providers.push({ id, label: team.providers[id]?.label ?? id, kind: def.kind })
      for (const a of team.agents) if (a.provider === id) plan.row.agents.push({ id: a.id, name: a.name, model: a.model, providerId: id })
    }
    for (const plan of byKey.values()) this.applyState(plan)
    return [...byKey.values()]
  }

  private applyState(plan: RowPlan): void {
    const { row, c } = plan
    const because = (reason: UsageReason | undefined, vars?: ReasonVars, text?: string) => {
      if (reason) {
        row.reason = reason
        if (vars) row.reasonVars = vars
        row.detail = reasonText(reason, vars)
      } else if (text) row.detail = text
    }
    if (c.capability === 'unsupported') {
      row.state = 'unsupported'
      because(c.reason ?? 'no-source')
      return
    }
    if (c.capability === 'consent' && !this.settings.claudeLoginFile) {
      row.state = 'consent-required'
      because('consent-off')
      return
    }
    if ((c.binding === 'provider-key' || c.binding === 'none') && !plan.key) {
      row.state = 'auth-missing'
      because('no-api-key')
      return
    }
    const s = this.accounts.get(row.key)
    if (!s) return
    // A sample belongs to one account: a changed key is a different account, never relabelled.
    if (plan.identity && s.identity && s.identity !== plan.identity) {
      delete s.snapshot
      delete s.state
      delete s.reason
      delete s.reasonVars
      delete s.detail
      s.identity = plan.identity
      s.failures = 0
      delete s.nextAllowedAt
      delete s.retryAfterUntil
    }
    row.inFlight = Boolean(s.flight)
    if (s.lastAttemptAt !== undefined) row.lastAttemptAt = s.lastAttemptAt
    const next = Math.max(s.nextAllowedAt ?? 0, s.retryAfterUntil ?? 0)
    if (next > this.now()) row.nextAllowedAt = next
    // A CLI / login sample is only known to be this account's once a query of this process has seen
    // the signed-in identity: until then it is withheld, so a previous account is never shown as current.
    if (loginBound(c) && !s.confirmed) {
      if (s.state) row.state = s.state
      if (s.reason || s.detail) because(s.reason, s.reasonVars, s.detail)
      else if (s.snapshot) because('sample-withheld')
      return
    }
    if (s.snapshot) row.snapshot = s.snapshot
    if (s.state) row.state = s.state
    because(s.reason, s.reasonVars, s.detail)
    if (s.snapshot && (s.cached || (s.state && s.state !== 'ok'))) row.stale = true
    if (s.cached && !s.state) {
      row.state = 'stale'
      because('cached-sample')
    }
  }

  private async refreshOne(plan: RowPlan, manual: boolean): Promise<void> {
    const s = this.state(plan.row.key)
    if (s.flight) return s.flight
    if (this.disposed) return
    const now = this.now()
    if (s.retryAfterUntil !== undefined && now < s.retryAfterUntil) return
    if (!manual && s.nextAllowedAt !== undefined && now < s.nextAllowedAt) return
    if (!manual && s.state === 'ok' && s.snapshot && now - s.snapshot.fetchedAt < (this.deps.ttlMs ?? 60_000)) return
    const run = this.query(plan, s).finally(() => {
      delete s.flight
    })
    s.flight = run
    this.changed()
    return run
  }

  private async query(plan: RowPlan, s: AccountState): Promise<void> {
    const controller = new AbortController()
    this.controllers.add(controller)
    this.byKey.set(plan.row.key, controller)
    const timeoutMs = plan.c.type === 'codex-subscription' ? (this.deps.codexTimeoutMs ?? 20_000) : (this.deps.timeoutMs ?? 10_000)
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs)
    s.lastAttemptAt = this.now()
    const prevIdentity = s.identity
    const gen = this.consentGen
    // False once this query no longer speaks for the account: its consent was changed or withdrawn,
    // or its state was replaced. Nothing it learns is then stored, cached or announced.
    const current = () => this.accounts.get(plan.row.key) === s && (plan.c.capability !== 'consent' || (gen === this.consentGen && this.settings.claudeLoginFile))
    let bound = false
    try {
      const { identity, snapshot } = await untilAborted(
        this.fetchSample(plan, controller.signal, (id) => {
          if (!current()) return
          // The credential in use belongs to another account than the stored sample: drop the sample now.
          if (s.identity && s.identity !== id) delete s.snapshot
          s.identity = id
          s.confirmed = true
          bound = true
        }),
        controller.signal,
      )
      if (this.disposed || !current()) return
      // The previous sample of the same account (also a cached one, so a restart does not repeat notices).
      const prev = prevIdentity === identity ? s.snapshot : undefined
      s.identity = identity
      s.snapshot = snapshot
      s.confirmed = true
      s.state = 'ok'
      delete s.reason
      delete s.reasonVars
      delete s.detail
      delete s.cached
      s.failures = 0
      delete s.nextAllowedAt
      delete s.retryAfterUntil
      this.saveCache()
      const low = newlyLow(prev, snapshot, this.settings.lowUsedPercent)
      if (low.length) {
        const row = this.plans().find((p) => p.row.key === plan.row.key)?.row
        if (row) this.deps.onLow?.(row, low)
      }
    } catch (err) {
      if (this.disposed || !current()) return
      // You cancelled it: the account keeps its previous sample and state, and no backoff is added.
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') return
      const f = err instanceof UsageFailure ? err : new UsageFailure('error', 'failed')
      if (loginBound(plan.c) && !bound) {
        // The signed-in account is unknown now, so the last sample cannot be shown as this account's.
        s.confirmed = false
        // Nobody (or only an API key) is signed in: that sample is surely not the current account's.
        if (f.state === 'auth-missing' || f.state === 'unsupported') {
          delete s.snapshot
          delete s.identity
          delete s.cached
          this.saveCache()
        }
      }
      s.state = f.state
      if (f.reason) s.reason = f.reason
      else delete s.reason
      if (f.vars) s.reasonVars = f.vars
      else delete s.reasonVars
      // A failure without a reason id is shown by its state only; its text stays in the English detail.
      if (f.reason) delete s.detail
      else s.detail = f.detail
      s.failures++
      s.nextAllowedAt = this.now() + Math.min(30 * 60_000, 60_000 * 2 ** Math.min(5, s.failures - 1))
      if (f.retryAfterMs !== undefined) s.retryAfterUntil = this.now() + f.retryAfterMs
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
      if (this.byKey.get(plan.row.key) === controller) this.byKey.delete(plan.row.key)
      this.changed()
    }
  }

  private async fetchSample(plan: RowPlan, signal: AbortSignal, bind: (identity: string) => void): Promise<{ identity: string; snapshot: UsageSnapshot }> {
    const fetchImpl = this.deps.fetchImpl ?? ((url, init) => fetch(url, init))
    const now = this.now
    const { c } = plan
    if (c.type === 'codex-subscription') {
      const q = await (this.deps.codex ?? ((sig) => queryCodexAppServer({ signal: sig })))(signal)
      const account = parseCodexAccount(q.account)
      const email = (q.account as { account?: { email?: unknown } } | null)?.account?.email
      if (account.kind === 'none') throw new UsageFailure('auth-missing', 'codex-signed-out')
      if (account.kind === 'apiKey') throw new UsageFailure('unsupported', 'codex-api-key')
      const identity = sha(`codex\0${typeof email === 'string' ? email : ''}\0${account.plan ?? ''}`)
      bind(identity)
      const limits = parseCodexRateLimits(q.rateLimits)
      const plan2 = limits.plan ?? account.plan
      return { identity, snapshot: { fetchedAt: now(), source: 'official-cli', windows: limits.windows, balances: [], ...(plan2 ? { plan: plan2 } : {}), ...(limits.credits ? { credits: limits.credits } : {}), ...(account.label ? { accountLabel: account.label } : {}) } }
    }
    if (c.type === 'claude-subscription') {
      const login = (this.deps.claudeLogin ?? (() => readClaudeLogin()))()
      if (!login.ok) throw new UsageFailure(login.state, login.reason ?? login.detail)
      bind(login.identity)
      if (login.expiresAt !== undefined && login.expiresAt <= now()) throw new UsageFailure('auth-expired', 'claude-expired')
      const body = await getJson(fetchImpl, c.endpoint as string, { Authorization: `Bearer ${login.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal, now)
      const b = body as { error?: unknown } | null
      if (!b || typeof b !== 'object' || b.error) throw new UsageFailure('invalid-response', 'usage-unreadable')
      return { identity: login.identity, snapshot: { fetchedAt: now(), source: 'internal-compat', windows: parseClaudeUsage(body), balances: [], ...(login.plan ? { plan: login.plan } : {}), accountLabel: 'Claude Code login' } }
    }
    const key = plan.key as string
    const identity = plan.identity as string
    bind(identity)
    const body = await getJson(fetchImpl, c.endpoint as string, { Authorization: `Bearer ${key}` }, signal, now)
    if (c.type === 'deepseek-api') {
      const parsed = parseDeepSeekBalance(body)
      if (!parsed) throw new UsageFailure('invalid-response', 'balance-unreadable')
      return { identity, snapshot: { fetchedAt: now(), source: 'official-api', windows: [], balances: parsed.balances, available: parsed.available } }
    }
    if (c.type === 'moonshot-api') {
      const balances = parseMoonshotBalance(body, c.region ?? 'intl')
      if (!balances) throw new UsageFailure('invalid-response', 'balance-unreadable')
      return { identity, snapshot: { fetchedAt: now(), source: 'official-api', windows: [], balances } }
    }
    if (c.type === 'kimi-code') {
      const b = body as { error?: unknown; code?: unknown } | null
      if (!b || typeof b !== 'object' || Array.isArray(b) || b.error) throw new UsageFailure('invalid-response', 'usage-unreadable')
      return { identity, snapshot: { fetchedAt: now(), source: 'official-api', windows: parseKimiUsage(body), balances: [] } }
    }
    throw new UsageFailure('unsupported', 'no-source')
  }

  private schedule(firstMs?: number): void {
    if (this.timer !== undefined) (this.deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)))(this.timer)
    this.timer = undefined
    if (this.disposed || !this.settings.autoRefresh) return
    const ms = Math.min(firstMs ?? Infinity, Math.max(60, this.settings.intervalSec) * 1000)
    const set = this.deps.setTimer ?? ((fn, t) => setTimeout(fn, t).unref())
    this.timer = set(() => {
      this.timer = undefined
      void this.refresh({ manual: false }).finally(() => this.schedule())
    }, ms)
  }

  private changed(): void {
    if (!this.disposed) this.deps.onChange?.(this.report())
  }

  private loadCache(): void {
    const raw = readJson(this.cacheFile) as { version?: unknown; accounts?: Record<string, { identity?: unknown; snapshot?: unknown }> } | undefined
    if (!raw || raw.version !== 1 || !raw.accounts || typeof raw.accounts !== 'object') return
    for (const [key, v] of Object.entries(raw.accounts)) {
      const snap = v?.snapshot as UsageSnapshot | undefined
      if (typeof v?.identity !== 'string' || !/^[a-f0-9]{64}$/.test(v.identity) || !snap || typeof snap.fetchedAt !== 'number' || !Array.isArray(snap.windows) || !Array.isArray(snap.balances)) continue
      // A sample read through the Claude login is not kept once the consent is off.
      if (key === 'claude-subscription' && !this.settings.claudeLoginFile) continue
      // Login samples come back unconfirmed: shown only after a query sees the same signed-in account.
      this.accounts.set(key, { identity: v.identity, snapshot: snap, cached: true, confirmed: false, failures: 0 })
    }
  }

  private saveCache(): void {
    if (this.disposed) return
    const accounts: Record<string, { identity: string; snapshot: UsageSnapshot }> = {}
    const live = new Set(this.plans().filter((p) => p.c.capability !== 'consent' || this.settings.claudeLoginFile).map((p) => p.row.key))
    for (const [key, s] of this.accounts) if (live.has(key) && s.identity && s.snapshot) accounts[key] = { identity: s.identity, snapshot: s.snapshot }
    writeAtomic(this.cacheFile, JSON.stringify({ version: 1, accounts }))
  }
}

/** The stable id of the account a provider runs on (safe for links: letters, digits, - and _). */
export function accountKey(providerId: string, def: ProviderDef, c: Classification): string {
  const safe = providerId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  if (c.type === 'codex-subscription' || c.type === 'claude-subscription' || c.type === 'gemini-account') return c.type
  if (c.type === 'local-endpoint') return `local-${safe}`
  if (def.apiKey) {
    // Same key on the same official endpoint (or the same base URL) = the same account and pool.
    const where = c.endpoint ?? `${def.kind}:${def.baseUrl ?? ''}`
    return `${c.type}-${sha(`${where}\0${def.apiKey}`).slice(0, 12)}`
  }
  return `${c.type}-${safe}`
}

/** Usage strings come from the shared locale resources (English and the escaped zh-CN resource). */
export function usageText(locale: Locale, key: MessageKey, vars: Record<string, string | number> = {}): string {
  return translate(locale, key, vars)
}

/** Localized countdown until reset (e.g. "2d 3h" in English). */
export function localCountdown(locale: Locale, ms: number): string {
  const c = countdownParts(ms)
  return translate(locale, c.key, c.vars)
}

/** A window's name for the pet (localized kind, or the provider's own name, kept literally). */
export function windowName(w: UsageWindow, locale: Locale): string {
  if (w.kind !== 'other') return usageText(locale, `usage.kind.${w.kind}`)
  return w.name ?? (w.durationMinutes ? usageText(locale, 'usage.kind.minutes', { n: w.durationMinutes }) : usageText(locale, 'usage.kind.other'))
}

/** The pet's one-line low-quota notice for an account: provider label, window and share used only. */
export function lowNotice(locale: Locale, row: UsageRow, windows: UsageWindow[]): string {
  const name = row.providers[0]?.label ?? translate(locale, `quota.type.${row.type}`)
  return windows
    .filter((w) => w.usedPercent !== undefined)
    .slice(0, 2)
    .map((w) => translate(locale, 'usage.pet.low', { name, window: windowName(w, locale), pct: formatPercent(w.usedPercent as number) }))
    .join('\n')
}

function readJson(file: string): unknown {
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as unknown) : undefined
  } catch {
    return undefined
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, file)
}

export { DEFAULT_USAGE_SETTINGS }
