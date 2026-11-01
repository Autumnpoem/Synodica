// Account usage, quotas and balances: types, account classification and the pure parsers for each
// provider's read-only usage source. Shared by the server (which queries) and the client (which
// renders). Parts of the parsing and decimal handling are adapted from dsh-model-meter 0.6.1
// (MIT, Copyright (c) 2026 Model Meter contributors); see THIRD_PARTY_NOTICES.md.
//
// Rules that hold everywhere in this file:
// - A field the provider did not return stays absent. It is never shown as zero or unlimited.
// - Windows are classified by their reported duration or identifier, never by position.
// - Money keeps its decimal text and its currency; amounts in different currencies are never summed.
import type { ProviderDef, ProviderKind } from './types.js'

/** What kind of account a provider runs on. A model name is never an account type. */
export type UsageAccountType =
  | 'codex-subscription'
  | 'claude-subscription'
  | 'kimi-code'
  | 'moonshot-api'
  | 'deepseek-api'
  | 'gemini-account'
  | 'gemini-api'
  | 'anthropic-api'
  | 'openai-api'
  | 'openai-compatible'
  | 'local-endpoint'

export const USAGE_ACCOUNT_TYPES: UsageAccountType[] = ['codex-subscription', 'claude-subscription', 'kimi-code', 'moonshot-api', 'deepseek-api', 'gemini-account', 'gemini-api', 'anthropic-api', 'openai-api', 'openai-compatible', 'local-endpoint']

/** Where a number came from. */
export type UsageSourceKind = 'official-api' | 'official-cli' | 'internal-compat' | 'cached' | 'local-estimate'

/** queryable: a verified read-only source exists · consent: it exists but needs your explicit opt-in · unsupported: no verified source. */
export type UsageCapability = 'queryable' | 'consent' | 'unsupported'

export type UsageState =
  | 'ok'
  | 'stale'
  | 'not-queried'
  | 'consent-required'
  | 'auth-missing'
  | 'auth-expired'
  | 'auth-failed'
  | 'unsupported'
  | 'cli-missing'
  | 'network'
  | 'timeout'
  | 'rate-limited'
  | 'invalid-response'
  | 'redirect-refused'
  | 'http-error'
  | 'error'

export const USAGE_STATES: UsageState[] = ['ok', 'stale', 'not-queried', 'consent-required', 'auth-missing', 'auth-expired', 'auth-failed', 'unsupported', 'cli-missing', 'network', 'timeout', 'rate-limited', 'invalid-response', 'redirect-refused', 'http-error', 'error']

export type UsageRegion = 'cn' | 'intl'

export type WindowKind = 'five-hour' | 'seven-day' | 'monthly-total' | 'monthly-coding' | 'other'

export const WINDOW_KINDS: WindowKind[] = ['five-hour', 'seven-day', 'monthly-total', 'monthly-coding', 'other']

/** Notes attached to a window when the provider's data needed a decision. */
export type WindowNote = 'legacy-conflict' | 'reset-without-timezone' | 'ratio-out-of-range'

export interface UsageWindow {
  /** Stable within one account: the provider's identifier plus the slot. */
  id: string
  kind: WindowKind
  /** Window length in minutes, when the provider reported it. */
  durationMinutes?: number
  /** The provider's own name or identifier for the window, shown literally. */
  name?: string
  /** The pool this window belongs to when the provider reports several (a model family, a limit id). */
  scope?: string
  /** Share already used, 0-100 (a provider ratio is multiplied by 100). Absent = not reported. */
  usedPercent?: number
  used?: number
  limit?: number
  remaining?: number
  /** Reset instant (epoch milliseconds). Absent = not reported. */
  resetsAt?: number
  notes?: WindowNote[]
}

export interface UsageBalance {
  /** ISO 4217 code. */
  currency: string
  /** Where the currency came from: the response itself, or the provider's documentation for that regional platform. */
  currencySource: 'reported' | 'region-documented'
  /** Decimal text exactly as reported. Absent = not reported. */
  total?: string
  /** Granted / voucher / bonus money. */
  granted?: string
  /** Paid (topped-up / cash) money. */
  paid?: string
}

export interface UsageCredits {
  hasCredits: boolean
  unlimited: boolean
  /** Credits are not money: shown as credits, never as dollars. */
  balance?: string
}

export interface UsageSnapshot {
  fetchedAt: number
  source: UsageSourceKind
  windows: UsageWindow[]
  balances: UsageBalance[]
  /** The plan name as reported (e.g. "plus", "pro"). */
  plan?: string
  credits?: UsageCredits
  /** The provider says the account can currently be used (DeepSeek is_available). */
  available?: boolean
  /** The account this sample belongs to, masked (an e-mail or an account type), never a secret. */
  accountLabel?: string
}

export interface UsageSettings {
  autoRefresh: boolean
  /** Bounded: 60 s to 1 h. */
  intervalSec: number
  /** A window at or above this used share counts as low quota. */
  lowUsedPercent: number
  /** The pet's right-click menu offers a short quota summary. */
  petSummary: boolean
  /** The pet says a short line when a window first crosses the low-quota line. */
  petNotices: boolean
  /** Explicit consent to read Claude Code's own login file for the Claude usage source. Off by default. */
  claudeLoginFile: boolean
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = { autoRefresh: false, intervalSec: 300, lowUsedPercent: 90, petSummary: true, petNotices: true, claudeLoginFile: false }
export const MIN_INTERVAL_SEC = 60
export const MAX_INTERVAL_SEC = 3600

/** Validate a settings patch; anything malformed keeps the current value. */
export function parseUsageSettings(raw: unknown, base: UsageSettings = DEFAULT_USAGE_SETTINGS): UsageSettings {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const bool = (k: keyof UsageSettings): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean))
  const int = (k: 'intervalSec' | 'lowUsedPercent', min: number, max: number): number => {
    const v = r[k]
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : base[k]
  }
  return {
    autoRefresh: bool('autoRefresh'),
    intervalSec: int('intervalSec', MIN_INTERVAL_SEC, MAX_INTERVAL_SEC),
    lowUsedPercent: int('lowUsedPercent', 1, 100),
    petSummary: bool('petSummary'),
    petNotices: bool('petNotices'),
    claudeLoginFile: bool('claudeLoginFile'),
  }
}

export interface UsageRow {
  /** Account key: shared by every provider and employee on the same account / credential / pool. */
  key: string
  type: UsageAccountType
  region?: UsageRegion
  capability: UsageCapability
  /** Source kind of a query (absent for unsupported accounts). */
  source?: Exclude<UsageSourceKind, 'cached' | 'local-estimate'>
  /** The fixed official endpoint queried, for display (no query string, no credential). */
  endpoint?: string
  providers: { id: string; label: string; kind: ProviderKind }[]
  agents: { id: string; name: string; model: string; providerId: string }[]
  /** Where the credential comes from, without any secret. */
  binding: { kind: 'cli-login' | 'provider-key' | 'claude-login-file' | 'none'; providerId?: string }
  state: UsageState
  /** Why the row is in its state, as a fixed id the client translates (`quota.reason.<id>`). */
  reason?: UsageReason
  /** Numbers or short tokens for the reason's placeholders (an HTTP status, an exit code). Never provider text. */
  reasonVars?: ReasonVars
  /** The same reason rendered in English, for API clients and logs (never a body, header, token or key). */
  detail?: string
  /** Last valid sample for this exact account; `stale` when a newer query failed or it came from the cache. */
  snapshot?: UsageSnapshot
  stale: boolean
  lastAttemptAt?: number
  /** No query before this time (provider Retry-After or backoff). */
  nextAllowedAt?: number
  inFlight: boolean
  /** Locally observed usage of these employees (Synodica's own records, never the provider's quota). */
  local?: LocalUsage
}

export interface LocalUsage {
  messages: number
  inputTokens: number
  outputTokens: number
  /** Cost as estimated by the adapters (USD), a local estimate only. */
  costUsd: number
}

export interface UsageReport {
  rows: UsageRow[]
  settings: UsageSettings
  serverNow: number
  refreshing: boolean
}

// ---------- classification ----------

export interface Classification {
  type: UsageAccountType
  region?: UsageRegion
  capability: UsageCapability
  source?: UsageRow['source']
  endpoint?: string
  binding: UsageRow['binding']['kind']
  /** Why there is no source (unsupported). */
  reason?: UsageReason
}

/**
 * Every reason a usage row can carry. The server only ever sends one of these ids plus numeric /
 * token parameters; the text comes from the shared locale resources, so no provider message or raw
 * error reaches the page, and every reason is translated in every locale (tested).
 */
export const USAGE_REASONS = [
  // no verified source for the account type
  'anthropic-key',
  'openai-key',
  'gemini-key',
  'gemini-login',
  'no-base-url',
  'local-endpoint',
  'generic-endpoint',
  // configuration
  'consent-off',
  'no-api-key',
  'sample-withheld',
  'cached-sample',
  // transport and response
  'too-large',
  'no-body',
  'not-json',
  'endpoint-refused',
  'timeout',
  'cancelled',
  'redirect',
  'redirect-status',
  'network',
  'http-401',
  'http-403',
  'http-429',
  'http-404',
  'http-status',
  // Codex CLI
  'codex-missing',
  'codex-talk',
  'codex-timeout',
  'codex-start',
  'codex-no-app-server',
  'codex-exited',
  'codex-too-much',
  'codex-old',
  'codex-refused',
  'codex-refused-code',
  'codex-signed-out',
  'codex-api-key',
  // Claude Code login
  'claude-keychain',
  'claude-no-file',
  'claude-no-subscription',
  'claude-unreadable',
  'claude-expired',
  // payloads
  'usage-unreadable',
  'balance-unreadable',
  'no-source',
  'failed',
] as const

export type UsageReason = (typeof USAGE_REASONS)[number]

export type ReasonVars = Record<string, number | string>

const REASON_SET: ReadonlySet<string> = new Set(USAGE_REASONS)

export function isUsageReason(v: unknown): v is UsageReason {
  return typeof v === 'string' && REASON_SET.has(v)
}

/** Placeholder values a reason may carry: finite numbers, or short lowercase tokens (e.g. "signal"). Anything else is dropped. */
export function safeReasonVars(vars: Record<string, unknown> | undefined): ReasonVars | undefined {
  if (!vars) return undefined
  const out: ReasonVars = {}
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[a-zA-Z]{1,16}$/.test(k)) continue
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v
    else if (typeof v === 'string' && /^[a-z0-9-]{1,16}$/.test(v)) out[k] = v
  }
  return Object.keys(out).length ? out : undefined
}

/** Official origins and their read-only usage endpoints. Only an exact origin match uses the provider's key. */
export const USAGE_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com/user/balance',
  moonshotCn: 'https://api.moonshot.cn/v1/users/me/balance',
  moonshotIntl: 'https://api.moonshot.ai/v1/users/me/balance',
  kimiCn: 'https://api.kimi.com/coding/v1/usages',
  kimiIntl: 'https://api.kimi.ai/coding/v1/usages',
  claude: 'https://api.anthropic.com/api/oauth/usage',
} as const

export const USAGE_ORIGINS = new Set(Object.values(USAGE_ENDPOINTS).map((u) => new URL(u).origin))

function urlOf(raw: string | undefined): URL | undefined {
  if (!raw) return undefined
  try {
    return new URL(raw.trim())
  } catch {
    return undefined
  }
}

function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '[::1]' || /^127\./.test(host) || host === '0.0.0.0'
}

/**
 * What account a configured provider runs on, and whether a verified read-only usage source exists.
 * Derived from the provider kind, whether it has its own key, and the exact official origin of its
 * base URL. A proxy or alias URL never receives the key for a balance query.
 */
export function classifyProvider(def: ProviderDef): Classification {
  if (def.kind === 'claude') {
    if (def.baseUrl && urlOf(def.baseUrl)?.origin !== 'https://api.anthropic.com') return { type: 'openai-compatible', capability: 'unsupported', binding: def.apiKey ? 'provider-key' : 'none', reason: 'generic-endpoint' }
    if (def.apiKey) return { type: 'anthropic-api', capability: 'unsupported', binding: 'provider-key', reason: 'anthropic-key' }
    return { type: 'claude-subscription', capability: 'consent', source: 'internal-compat', endpoint: USAGE_ENDPOINTS.claude, binding: 'claude-login-file' }
  }
  if (def.kind === 'codex') {
    if (def.apiKey) return { type: 'openai-api', capability: 'unsupported', binding: 'provider-key', reason: 'openai-key' }
    return { type: 'codex-subscription', capability: 'queryable', source: 'official-cli', endpoint: 'codex app-server: account/rateLimits/read', binding: 'cli-login' }
  }
  if (def.kind === 'gemini') {
    if (def.apiKey) return { type: 'gemini-api', capability: 'unsupported', binding: 'provider-key', reason: 'gemini-key' }
    return { type: 'gemini-account', capability: 'unsupported', binding: 'cli-login', reason: 'gemini-login' }
  }
  const u = urlOf(def.baseUrl)
  if (!u) return { type: 'openai-compatible', capability: 'unsupported', binding: def.apiKey ? 'provider-key' : 'none', reason: 'no-base-url' }
  if (isLoopback(u.hostname)) return { type: 'local-endpoint', capability: 'unsupported', binding: 'none', reason: 'local-endpoint' }
  const https = u.protocol === 'https:' && (u.port === '' || u.port === '443')
  const binding = def.apiKey ? 'provider-key' : 'none'
  if (https && u.hostname === 'api.deepseek.com') return { type: 'deepseek-api', capability: 'queryable', source: 'official-api', endpoint: USAGE_ENDPOINTS.deepseek, binding }
  if (https && u.hostname === 'api.moonshot.cn') return { type: 'moonshot-api', region: 'cn', capability: 'queryable', source: 'official-api', endpoint: USAGE_ENDPOINTS.moonshotCn, binding }
  if (https && u.hostname === 'api.moonshot.ai') return { type: 'moonshot-api', region: 'intl', capability: 'queryable', source: 'official-api', endpoint: USAGE_ENDPOINTS.moonshotIntl, binding }
  const coding = u.pathname === '/coding' || u.pathname.startsWith('/coding/')
  if (https && coding && u.hostname === 'api.kimi.com') return { type: 'kimi-code', region: 'cn', capability: 'queryable', source: 'official-api', endpoint: USAGE_ENDPOINTS.kimiCn, binding }
  if (https && coding && u.hostname === 'api.kimi.ai') return { type: 'kimi-code', region: 'intl', capability: 'queryable', source: 'official-api', endpoint: USAGE_ENDPOINTS.kimiIntl, binding }
  return { type: 'openai-compatible', capability: 'unsupported', binding, reason: 'generic-endpoint' }
}

// ---------- shared value parsing ----------

/** A non-negative finite number from a number or a plain decimal string. */
export function numeric(value: unknown): number | undefined {
  if (typeof value === 'string') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return undefined
    value = Number(value)
  }
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

/** A decimal amount kept as text (binary floating point is not a money transport). Numbers become their shortest exact text. */
export function decimalText(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return v.length <= 64 && /^[+-]?\d+(?:\.\d+)?$/.test(v) ? v : undefined
}

/** A ratio or percentage without float noise (0.1234 * 100 = 12.34, not 12.340000000000002). */
function cleanPercent(v: number): number {
  return Number(v.toPrecision(12))
}

/**
 * An instant with an explicit time zone (ISO 8601 with Z or an offset) or an explicit epoch. A
 * date-time without a zone is ambiguous, so it is not converted (absent, with a note).
 */
export function parseInstant(value: unknown): { ms?: number; noZone?: boolean } {
  if (typeof value === 'string') {
    const v = value.trim()
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:?\d\d)$/i.test(v)) {
      const ms = Date.parse(v)
      return Number.isFinite(ms) ? { ms } : {}
    }
    if (/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d/.test(v)) return { noZone: true }
    if (/^\d+$/.test(v)) return parseInstant(Number(v))
    return {}
  }
  const n = numeric(value)
  if (n === undefined) return {}
  // Epoch milliseconds (13 digits) or seconds (10 digits); anything else is not an instant.
  const ms = n >= 1e12 ? n : n >= 1e9 ? n * 1000 : undefined
  return ms !== undefined && ms < 8.64e15 ? { ms: Math.round(ms) } : {}
}

/** Window kind from a reported length in minutes. Only exact matches are named; everything else is "other". */
export function kindForMinutes(minutes: number | undefined): WindowKind {
  if (minutes === 300) return 'five-hour'
  if (minutes === 10080) return 'seven-day'
  return 'other'
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

function shortText(v: unknown, max = 60): string | undefined {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v.trim() : undefined
}

function withReset(w: UsageWindow, raw: unknown): UsageWindow {
  if (raw === undefined || raw === null) return w
  const r = parseInstant(raw)
  if (r.ms !== undefined) return { ...w, resetsAt: r.ms }
  if (r.noZone) return { ...w, notes: [...(w.notes ?? []), 'reset-without-timezone'] }
  return w
}

function counts(v: Record<string, unknown>): Pick<UsageWindow, 'used' | 'limit' | 'remaining' | 'usedPercent'> {
  const limit = numeric(v.limit)
  let used = numeric(v.used)
  let remaining = numeric(v.remaining)
  if (used === undefined && limit !== undefined && remaining !== undefined && remaining <= limit) used = limit - remaining
  if (remaining === undefined && limit !== undefined && used !== undefined) remaining = Math.max(0, limit - used)
  return {
    ...(used !== undefined ? { used } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(limit !== undefined && limit > 0 && used !== undefined ? { usedPercent: cleanPercent((used / limit) * 100) } : {}),
  }
}

// ---------- Codex (official app-server JSON-RPC: account/read, account/rateLimits/read) ----------

export interface CodexAccount {
  /** chatgpt: a ChatGPT login with plan limits · apiKey: an API key login (no plan limits) · none: not signed in. */
  kind: 'chatgpt' | 'apiKey' | 'none'
  plan?: string
  label?: string
}

/** Mask an e-mail for display: first letter and the domain. */
export function maskEmail(email: unknown): string | undefined {
  if (typeof email !== 'string' || email.length > 200) return undefined
  const m = /^([^@\s])[^@\s]*@([^@\s]+\.[^@\s]+)$/.exec(email.trim())
  return m ? `${m[1]}***@${m[2]}` : undefined
}

/** The account/read result ({ account: { type, email?, planType? } | null, requiresOpenaiAuth? }). */
export function parseCodexAccount(result: unknown): CodexAccount {
  const r = obj(result)
  const a = obj(r?.account)
  if (!a) return { kind: 'none' }
  const type = typeof a.type === 'string' ? a.type.toLowerCase() : ''
  if (type === 'apikey' || type === 'api_key') return { kind: 'apiKey' }
  if (type !== 'chatgpt') return { kind: 'none' }
  const plan = typeof a.planType === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(a.planType) ? a.planType : undefined
  const label = maskEmail(a.email)
  return { kind: 'chatgpt', ...(plan ? { plan } : {}), ...(label ? { label } : {}) }
}

/**
 * account/rateLimits/read: `rateLimits` (the main pool) and `rateLimitsByLimitId` (every pool). Each
 * pool has primary / secondary windows ({ usedPercent, windowDurationMins, resetsAt }) plus optional
 * limitId, limitName, planType and credits. Windows are classified by their duration; primary is not
 * assumed to be 5 hours and secondary is not assumed to be weekly.
 */
export function parseCodexRateLimits(result: unknown): { windows: UsageWindow[]; plan?: string; credits?: UsageCredits } {
  const r = obj(result)
  const pools: Record<string, unknown>[] = []
  const byId = obj(r?.rateLimitsByLimitId)
  if (byId) for (const v of Object.values(byId)) if (obj(v)) pools.push(v as Record<string, unknown>)
  const main = obj(r?.rateLimits)
  if (main) {
    const id = typeof main.limitId === 'string' ? main.limitId : undefined
    if (!pools.some((p) => (typeof p.limitId === 'string' ? p.limitId : undefined) === id && id !== undefined)) pools.unshift(main)
  }
  const multiple = pools.length > 1
  const windows: UsageWindow[] = []
  let plan: string | undefined
  let credits: UsageCredits | undefined
  pools.forEach((pool, index) => {
    const limitId = shortText(pool.limitId, 64) ?? `pool-${index}`
    const name = shortText(pool.limitName, 64)
    if (!plan && typeof pool.planType === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(pool.planType)) plan = pool.planType
    const c = obj(pool.credits)
    if (!credits && c && typeof c.hasCredits === 'boolean') {
      const balance = decimalText(c.balance)
      credits = { hasCredits: c.hasCredits, unlimited: c.unlimited === true, ...(balance !== undefined ? { balance } : {}) }
    }
    for (const slot of ['primary', 'secondary'] as const) {
      const w = obj(pool[slot])
      if (!w) continue
      const minutes = numeric(w.windowDurationMins)
      const used = numeric(w.usedPercent)
      const base: UsageWindow = {
        id: `${limitId}:${slot}`,
        kind: kindForMinutes(minutes),
        ...(minutes !== undefined ? { durationMinutes: minutes } : {}),
        ...(multiple || name ? { scope: name ?? limitId } : {}),
        ...(used !== undefined ? { usedPercent: cleanPercent(used) } : {}),
      }
      windows.push(withReset(base, w.resetsAt))
    }
  })
  return { windows, ...(plan ? { plan } : {}), ...(credits ? { credits } : {}) }
}

// ---------- Claude (community-documented OAuth usage response; not a stable public API) ----------

/**
 * GET api.anthropic.com/api/oauth/usage: five_hour / seven_day and model-scoped weekly windows
 * ({ utilization: percent, resets_at }), optional scoped `limits` entries, and extra_usage. Only
 * windows that are present are returned; null means "no such window on this plan".
 */
export function parseClaudeUsage(body: unknown): UsageWindow[] {
  const b = obj(body)
  if (!b) return []
  const out: UsageWindow[] = []
  for (const [key, value] of Object.entries(b)) {
    const v = obj(value)
    if (!v || key === 'limits' || key === 'extra_usage') continue
    if (!('utilization' in v) && !('resets_at' in v)) continue
    const pct = numeric(v.utilization)
    let kind: WindowKind = 'other'
    let durationMinutes: number | undefined
    let scope: string | undefined
    if (key === 'five_hour') {
      kind = 'five-hour'
      durationMinutes = 300
    } else if (key === 'seven_day') {
      kind = 'seven-day'
      durationMinutes = 10080
    } else if (key.startsWith('seven_day_')) {
      kind = 'seven-day'
      durationMinutes = 10080
      scope = key.slice('seven_day_'.length)
    }
    out.push(withReset({ id: key, kind, name: key, ...(durationMinutes ? { durationMinutes } : {}), ...(scope ? { scope } : {}), ...(pct !== undefined ? { usedPercent: cleanPercent(pct) } : {}) }, v.resets_at))
  }
  if (Array.isArray(b.limits)) {
    b.limits.forEach((item, i) => {
      const v = obj(item)
      if (!v) return
      const id = shortText(v.id, 64) ?? shortText(v.name, 64) ?? shortText(v.type, 64) ?? `limit-${i}`
      const minutes = numeric(v.window_minutes) ?? (numeric(v.window_seconds) !== undefined ? (numeric(v.window_seconds) as number) / 60 : undefined)
      const pct = numeric(v.utilization)
      const scope = shortText(v.scope, 64) ?? shortText(v.model, 64)
      out.push(withReset({ id: `limits:${id}`, kind: kindForMinutes(minutes), name: id, ...(minutes !== undefined ? { durationMinutes: minutes } : {}), ...(scope ? { scope } : {}), ...(pct !== undefined ? { usedPercent: cleanPercent(pct) } : {}) }, v.resets_at))
    })
  }
  const extra = obj(b.extra_usage)
  if (extra && extra.is_enabled === true) {
    const pct = numeric(extra.utilization)
    out.push({ id: 'extra_usage', kind: 'other', name: 'extra_usage', scope: 'extra usage', ...(pct !== undefined ? { usedPercent: cleanPercent(pct) } : {}) })
  }
  return out
}

// ---------- Kimi Code (official coding usages endpoint) ----------

const KIMI_MODERN: [string, WindowKind, number | undefined][] = [
  ['limit_5h', 'five-hour', 300],
  ['limit_7d', 'seven-day', 10080],
  ['limit_month_total', 'monthly-total', undefined],
  ['limit_month_code', 'monthly-coding', undefined],
]

function kimiMinutes(window: Record<string, unknown> | undefined): number | undefined {
  const duration = numeric(window?.duration)
  const unit = String(window?.timeUnit ?? '').toUpperCase()
  if (duration === undefined) return undefined
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('SECOND')) return duration / 60
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 1440
  return undefined
}

/**
 * Modern schema first: `usages.limit_5h / limit_7d / limit_month_total / limit_month_code`, each
 * { used_ratio (0-1), reset_time }. The legacy schema (`usage` and `limits[].detail` with raw
 * limit / used / remaining / resetTime) only fills windows the modern schema does not report.
 * Deterministic conflict rule: where both describe the same window, the modern ratio wins; legacy
 * counts are kept beside it only when they agree within 0.5 points, else the window gets a
 * "legacy-conflict" note and the legacy counts are dropped. The legacy top-level `usage` has no
 * reported duration, so it is "other" and only used when no modern window exists.
 */
export function parseKimiUsage(body: unknown): UsageWindow[] {
  const b = obj(body)
  if (!b) return []
  const windows: UsageWindow[] = []
  const usages = obj(b.usages)
  if (usages) {
    for (const [key, kind, minutes] of KIMI_MODERN) {
      const v = obj(usages[key])
      if (!v) continue
      const ratio = numeric(v.used_ratio)
      const base: UsageWindow = { id: key, kind, name: key, ...(minutes ? { durationMinutes: minutes } : {}) }
      if (ratio !== undefined && ratio <= 1) base.usedPercent = cleanPercent(ratio * 100)
      else if (ratio !== undefined) base.notes = ['ratio-out-of-range']
      windows.push(withReset(base, v.reset_time))
    }
  }
  const legacy: UsageWindow[] = []
  if (Array.isArray(b.limits)) {
    b.limits.forEach((item, i) => {
      const v = obj(item)
      const detail = obj(v?.detail)
      if (!detail) return
      const minutes = kimiMinutes(obj(v?.window))
      const kind = kindForMinutes(minutes)
      legacy.push(withReset({ id: `limits:${i}`, kind, ...(minutes !== undefined ? { durationMinutes: minutes } : {}), ...counts(detail) }, detail.resetTime))
    })
  }
  for (const l of legacy) {
    const modern = l.kind !== 'other' ? windows.find((w) => w.kind === l.kind) : undefined
    if (!modern) {
      windows.push(l)
      continue
    }
    const legacyCounts = { ...(l.used !== undefined ? { used: l.used } : {}), ...(l.limit !== undefined ? { limit: l.limit } : {}), ...(l.remaining !== undefined ? { remaining: l.remaining } : {}) }
    const agree = modern.usedPercent !== undefined && l.usedPercent !== undefined && Math.abs(modern.usedPercent - l.usedPercent) <= 0.5
    if (agree) Object.assign(modern, legacyCounts)
    // The modern entry exists but reports no ratio: the legacy counts are the only numbers for this window.
    else if (modern.usedPercent === undefined && l.usedPercent !== undefined && !modern.notes?.includes('ratio-out-of-range')) Object.assign(modern, legacyCounts, { usedPercent: l.usedPercent })
    else if (l.usedPercent !== undefined) modern.notes = [...(modern.notes ?? []), 'legacy-conflict']
  }
  const top = obj(b.usage)
  if (top && windows.length === 0) windows.push(withReset({ id: 'usage', kind: 'other', name: 'usage', ...counts(top) }, top.resetTime))
  return windows
}

// ---------- DeepSeek (official GET /user/balance) ----------

/** { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }. */
export function parseDeepSeekBalance(body: unknown): { available: boolean; balances: UsageBalance[] } | undefined {
  const b = obj(body)
  if (!b || typeof b.is_available !== 'boolean' || !Array.isArray(b.balance_infos)) return undefined
  const balances: UsageBalance[] = []
  for (const item of b.balance_infos) {
    const v = obj(item)
    const currency = typeof v?.currency === 'string' && /^[A-Z]{3}$/.test(v.currency) ? v.currency : undefined
    if (!v || !currency || balances.some((x) => x.currency === currency)) return undefined
    const total = decimalText(v.total_balance)
    const granted = decimalText(v.granted_balance)
    const paid = decimalText(v.topped_up_balance)
    balances.push({ currency, currencySource: 'reported', ...(total !== undefined ? { total } : {}), ...(granted !== undefined ? { granted } : {}), ...(paid !== undefined ? { paid } : {}) })
  }
  return { available: b.is_available, balances }
}

// ---------- Moonshot open platform (official GET /v1/users/me/balance) ----------

/**
 * { code: 0, data: { available_balance, voucher_balance, cash_balance }, status: true }. The response
 * carries no currency: the regional platform's documented billing currency is used and labelled as such.
 */
export function parseMoonshotBalance(body: unknown, region: UsageRegion): UsageBalance[] | undefined {
  const b = obj(body)
  const data = obj(b?.data)
  if (!b || !data || (b.code !== undefined && b.code !== 0 && b.code !== '0') || b.status === false) return undefined
  const total = signedDecimal(data.available_balance)
  const granted = signedDecimal(data.voucher_balance)
  const paid = signedDecimal(data.cash_balance)
  if (total === undefined && granted === undefined && paid === undefined) return undefined
  return [{ currency: region === 'cn' ? 'CNY' : 'USD', currencySource: 'region-documented', ...(total !== undefined ? { total } : {}), ...(granted !== undefined ? { granted } : {}), ...(paid !== undefined ? { paid } : {}) }]
}

/** Cash balances can be negative (arrears); keep the sign. */
function signedDecimal(value: unknown): string | undefined {
  return decimalText(value)
}

// ---------- presentation helpers (client and pet) ----------

/** A percentage for display: at most two decimals, trailing zeros dropped, never rounded up to 100 by accident. */
export function formatPercent(p: number): string {
  const floor2 = Math.floor(p * 100 + 1e-9) / 100
  return String(Number(floor2.toFixed(2)))
}

/** Time left until a reset, e.g. "2d 3h", "4h 05m", "12m 30s". Past instants are "0s". */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${s % 60}s`
}

/** The same countdown as a locale key and its numbers (countdown.dh / hm / ms / s), for localized display. */
export function countdownParts(ms: number): { key: 'countdown.dh' | 'countdown.hm' | 'countdown.ms' | 'countdown.s'; vars: Record<string, string> } {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (d > 0) return { key: 'countdown.dh', vars: { d: String(d), h: String(h) } }
  if (h > 0) return { key: 'countdown.hm', vars: { h: String(h), m: pad(m) } }
  if (m > 0) return { key: 'countdown.ms', vars: { m: String(m), s: pad(s % 60) } }
  return { key: 'countdown.s', vars: { s: String(s % 60) } }
}

/** The window closest to its limit (highest used share among those that report one). */
export function tightestWindow(windows: UsageWindow[]): UsageWindow | undefined {
  let best: UsageWindow | undefined
  for (const w of windows) if (w.usedPercent !== undefined && (!best || (best.usedPercent ?? -1) < w.usedPercent)) best = w
  return best
}

/** States that mean a query was attempted and something is wrong (not "no source" or "not asked yet"). */
export const PROBLEM_STATES: UsageState[] = ['auth-expired', 'auth-failed', 'cli-missing', 'network', 'timeout', 'rate-limited', 'invalid-response', 'redirect-refused', 'http-error', 'error']

/** For the sidebar: accounts with a window at or above the low-quota line, and accounts whose last query failed. */
export function usageCounts(report: Pick<UsageReport, 'rows' | 'settings'>): { low: number; attention: number } {
  let low = 0
  let attention = 0
  for (const row of report.rows) {
    const w = row.snapshot ? tightestWindow(row.snapshot.windows) : undefined
    if (w?.usedPercent !== undefined && w.usedPercent >= report.settings.lowUsedPercent) low++
    if (PROBLEM_STATES.includes(row.state)) attention++
  }
  return { low, attention }
}

/** Whether a row matches a deep-link focus id: its account key, one of its providers or one of its employees. */
export function rowMatches(row: Pick<UsageRow, 'key' | 'providers' | 'agents'>, focus: string): boolean {
  return row.key === focus || row.providers.some((p) => p.id === focus) || row.agents.some((a) => a.id === focus)
}

/** Windows at or above the low-quota line in `next` that were below it (or absent) in `prev` for the same account. */
export function newlyLow(prev: UsageSnapshot | undefined, next: UsageSnapshot, threshold: number): UsageWindow[] {
  const before = new Map((prev?.windows ?? []).map((w) => [w.id, w.usedPercent]))
  return next.windows.filter((w) => w.usedPercent !== undefined && w.usedPercent >= threshold && !((before.get(w.id) ?? -1) >= threshold))
}
