// Account usage dashboard: parsers, transport, the meter service, its routes and the pet entry.
// Every provider is mocked (fake keys, a mock fetch, a fake Codex CLI script, a fake Claude login):
// nothing here talks to a real account, a paid model or the network beyond 127.0.0.1.
import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'
import { EN, translate, ZH_CN } from '../shared/i18n.js'
import { parseAppLink, linkToHash } from '../shared/presence.js'
import type { Team } from '../shared/types.js'
import {
  classifyProvider,
  countdownParts,
  parseClaudeUsage,
  parseCodexRateLimits,
  parseDeepSeekBalance,
  parseKimiUsage,
  parseMoonshotBalance,
  parseUsageSettings,
  USAGE_ACCOUNT_TYPES,
  USAGE_ENDPOINTS,
  USAGE_STATES,
  WINDOW_KINDS,
  type UsageReport,
  type UsageRow,
} from '../shared/usage.js'
import { PetBridge } from './petbridge.js'
import { member, mixedTeam, tmp } from './testkit.js'
import { getJson, lowNotice, queryCodexAppServer, UsageFailure, UsageMeter, type ClaudeLogin, type CodexQuery, type FetchLike, type UsageMeterDeps } from './usagemeter.js'
import { parseKeys, usageRouter, usageWriteAllowed } from './usageroutes.js'

const KEY_DS = 'sk-FAKE-deepseek-0001'
const KEY_DS2 = 'sk-FAKE-deepseek-0002'
const KEY_KIMI = 'sk-FAKE-kimi-code-0001'
const KEY_MOON = 'sk-FAKE-moonshot-0001'
const KEY_PROXY = 'sk-FAKE-proxy-0001'
const T0 = Date.UTC(2026, 9, 30, 8, 0, 0)
// CJK Unified Ideographs, built from code points so this file stays ASCII.
const CJK = new RegExp(`[${String.fromCharCode(0x4e00)}-${String.fromCharCode(0x9fff)}]`)

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

interface Call {
  url: string
  headers: Record<string, string>
  redirect: string
}

/** A mock transport: answers by URL; records every request (URL, headers, redirect mode). */
function mockFetch(answer: (url: string, n: number) => Response | Promise<Response>): FetchLike & { calls: Call[] } {
  const calls: Call[] = []
  const f = (async (url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect })
    if (init.signal.aborted) throw new Error('aborted')
    return answer(url, calls.length)
  }) as FetchLike & { calls: Call[] }
  f.calls = calls
  return f
}

/** A request that never answers until it is aborted. */
function hangingFetch(): FetchLike & { calls: Call[]; release: (r: Response) => void } {
  const calls: Call[] = []
  let release: (r: Response) => void = () => {}
  const f = ((url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect })
    return new Promise<Response>((resolve, reject) => {
      release = resolve
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }) as FetchLike & { calls: Call[]; release: (r: Response) => void }
  f.calls = calls
  Object.defineProperty(f, 'release', { get: () => release })
  return f
}

function team(providers: Team['providers'], agents = Object.keys(providers).map((p, i) => member(`emp${i}`, p, ['implementer']))): Team {
  return { ...mixedTeam(tmp()), providers, agents }
}

function meter(t: Team | (() => Team), deps: Partial<UsageMeterDeps> = {}): { m: UsageMeter; changes: UsageReport[]; dataDir: string; clock: { now: number } } {
  const clock = { now: T0 }
  const changes: UsageReport[] = []
  const dataDir = deps.dataDir ?? tmp('ogb-usage-')
  const m = new UsageMeter({
    getTeam: typeof t === 'function' ? t : () => t,
    dataDir,
    now: () => clock.now,
    setTimer: () => 'timer',
    clearTimer: () => {},
    onChange: (r) => changes.push(r),
    codex: async () => ({ account: { account: null } }),
    claudeLogin: () => ({ ok: false, state: 'auth-missing', detail: 'no login (test)' }),
    ...deps,
  })
  return { m, changes, dataDir, clock }
}

const row = (r: UsageReport, pred: (x: UsageRow) => boolean): UsageRow => {
  const hit = r.rows.find(pred)
  assert.ok(hit, 'row exists')
  return hit
}

// ---------- classification: every configured provider, model and employee has a row ----------

test('every built-in account type is classified with an honest capability, and every employee appears exactly once', () => {
  const providers: Team['providers'] = {
    claude: { kind: 'claude', label: 'Claude' },
    'claude-api': { kind: 'claude', label: 'Claude API', apiKey: 'sk-ant-FAKE' },
    codex: { kind: 'codex', label: 'Codex' },
    'codex-key': { kind: 'codex', label: 'Codex key', apiKey: 'sk-FAKE-openai' },
    gemini: { kind: 'gemini', label: 'Gemini' },
    'gemini-key': { kind: 'gemini', label: 'Gemini key', apiKey: 'FAKE-gemini' },
    deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS },
    'moonshot-cn': { kind: 'openai', label: 'Moonshot CN', baseUrl: 'https://api.moonshot.cn/v1', apiKey: KEY_MOON },
    'moonshot-intl': { kind: 'openai', label: 'Moonshot Intl', baseUrl: 'https://api.moonshot.ai/v1', apiKey: 'sk-FAKE-moonshot-intl' },
    'kimi-cn': { kind: 'openai', label: 'Kimi Code', baseUrl: 'https://api.kimi.com/coding/v1', apiKey: KEY_KIMI },
    'kimi-intl': { kind: 'openai', label: 'Kimi Code Intl', baseUrl: 'https://api.kimi.ai/coding/v1', apiKey: 'sk-FAKE-kimi-intl' },
    proxy: { kind: 'openai', label: 'Proxy', baseUrl: 'https://proxy.example/deepseek/v1', apiKey: KEY_PROXY },
    ollama: { kind: 'openai', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    'deepseek-nokey': { kind: 'openai', label: 'DeepSeek no key', baseUrl: 'https://api.deepseek.com' },
  }
  const expected: Record<string, [string, string, string]> = {
    claude: ['claude-subscription', 'consent', 'consent-required'],
    'claude-api': ['anthropic-api', 'unsupported', 'unsupported'],
    codex: ['codex-subscription', 'queryable', 'not-queried'],
    'codex-key': ['openai-api', 'unsupported', 'unsupported'],
    gemini: ['gemini-account', 'unsupported', 'unsupported'],
    'gemini-key': ['gemini-api', 'unsupported', 'unsupported'],
    deepseek: ['deepseek-api', 'queryable', 'not-queried'],
    'moonshot-cn': ['moonshot-api', 'queryable', 'not-queried'],
    'moonshot-intl': ['moonshot-api', 'queryable', 'not-queried'],
    'kimi-cn': ['kimi-code', 'queryable', 'not-queried'],
    'kimi-intl': ['kimi-code', 'queryable', 'not-queried'],
    proxy: ['openai-compatible', 'unsupported', 'unsupported'],
    ollama: ['local-endpoint', 'unsupported', 'unsupported'],
    'deepseek-nokey': ['deepseek-api', 'queryable', 'auth-missing'],
  }
  const t = team(providers)
  const { m } = meter(t)
  const r = m.report()
  for (const [id, [type, capability, state]] of Object.entries(expected)) {
    const x = row(r, (y) => y.providers.some((p) => p.id === id))
    assert.equal(x.type, type, `${id} type`)
    assert.equal(x.capability, capability, `${id} capability`)
    assert.equal(x.state, state, `${id} state`)
    if (capability === 'unsupported') assert.ok(x.detail && x.detail.length > 10, `${id} says why there is no source`)
  }
  assert.equal(row(r, (y) => y.providers.some((p) => p.id === 'moonshot-cn')).region, 'cn')
  assert.equal(row(r, (y) => y.providers.some((p) => p.id === 'kimi-intl')).endpoint, USAGE_ENDPOINTS.kimiIntl)
  // Every employee exactly once, every provider exactly once.
  const agentIds = r.rows.flatMap((x) => x.agents.map((a) => a.id)).sort()
  assert.deepEqual(agentIds, t.agents.map((a) => a.id).sort())
  assert.deepEqual(r.rows.flatMap((x) => x.providers.map((p) => p.id)).sort(), Object.keys(providers).sort())
  // A model name is never an account type; models are listed literally per employee.
  assert.ok(r.rows.every((x) => (USAGE_ACCOUNT_TYPES as string[]).includes(x.type)))
  assert.ok(r.rows.flatMap((x) => x.agents).every((a) => a.model === 'test-model'))
  // No key, masked or not, is in the report.
  const text = JSON.stringify(r)
  for (const k of [KEY_DS, KEY_MOON, KEY_KIMI, KEY_PROXY, 'sk-ant-FAKE', 'FAKE-gemini']) assert.ok(!text.includes(k), `report leaks ${k}`)
})

test('a proxy or alias URL never receives the key, and lookalike origins are not official', () => {
  for (const baseUrl of ['https://api.deepseek.com.evil.example/v1', 'http://api.deepseek.com/v1', 'https://api.deepseek.com:8443/v1', 'https://api.kimi.com/v1', 'https://evil.example/coding/v1']) {
    const c = classifyProvider({ kind: 'openai', label: 'x', baseUrl, apiKey: KEY_DS })
    assert.equal(c.capability, 'unsupported', baseUrl)
    assert.equal(c.endpoint, undefined, `${baseUrl} has no query endpoint`)
  }
})

test('providers and employees on one key share one row and one query; different keys stay separate', async () => {
  const providers: Team['providers'] = {
    ds1: { kind: 'openai', label: 'DeepSeek chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS },
    ds2: { kind: 'openai', label: 'DeepSeek reasoner', baseUrl: 'https://api.deepseek.com', apiKey: KEY_DS },
    ds3: { kind: 'openai', label: 'DeepSeek other', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS2 },
  }
  const agents = [member('a', 'ds1', ['implementer'], { model: 'deepseek-chat' }), member('b', 'ds2', ['implementer'], { model: 'deepseek-reasoner' }), member('c', 'ds3', ['implementer'])]
  const fetchImpl = mockFetch(() => json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '10.00', granted_balance: '0.00', topped_up_balance: '10.00' }] }))
  const { m } = meter(team(providers, agents), { fetchImpl })
  const r = await m.refresh({ manual: true })
  const shared = row(r, (x) => x.providers.length === 2)
  assert.deepEqual(shared.providers.map((p) => p.id).sort(), ['ds1', 'ds2'])
  assert.deepEqual(shared.agents.map((a) => `${a.id}:${a.model}`).sort(), ['a:deepseek-chat', 'b:deepseek-reasoner'])
  assert.equal(r.rows.length, 2)
  assert.equal(fetchImpl.calls.length, 2, 'one query per account, not per provider or model')
  assert.deepEqual(fetchImpl.calls.map((c) => c.headers.Authorization).sort(), [`Bearer ${KEY_DS}`, `Bearer ${KEY_DS2}`])
  assert.ok(fetchImpl.calls.every((c) => c.url === USAGE_ENDPOINTS.deepseek && c.redirect === 'manual'))
})

// ---------- parsers ----------

test('Kimi: modern windows win, agreeing legacy counts are kept, conflicts are noted, absent windows stay absent', () => {
  const w = parseKimiUsage({
    usages: { limit_5h: { used_ratio: 0.25, reset_time: '2026-10-30T15:00:00+08:00' }, limit_7d: { used_ratio: 0, reset_time: '2026-11-02T00:00:00Z' } },
    limits: [
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: 100, used: 25, remaining: 75 } },
      { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: 1000, used: 500 } },
    ],
  })
  const five = w.find((x) => x.kind === 'five-hour')
  const week = w.find((x) => x.kind === 'seven-day')
  assert.deepEqual([five?.usedPercent, five?.used, five?.limit, five?.remaining], [25, 25, 100, 75])
  assert.equal(five?.resetsAt, Date.UTC(2026, 9, 30, 7, 0, 0), 'the +08:00 offset is converted exactly')
  assert.equal(week?.usedPercent, 0, 'zero is reported as zero, not as absent')
  assert.deepEqual(week?.notes, ['legacy-conflict'])
  assert.equal(week?.used, undefined, 'conflicting legacy counts are dropped')
  assert.equal(w.some((x) => x.kind === 'monthly-total' || x.kind === 'monthly-coding'), false, 'monthly windows not returned are not invented')
  assert.equal(w.length, 2)
})

test('Kimi: legacy-only, missing, out-of-range ratios and resets without a time zone', () => {
  const legacy = parseKimiUsage({ usage: { limit: 100, used: 40 }, limits: [{ window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 50, remaining: 10, resetTime: '2026-10-30T10:00:00' } }] })
  assert.equal(legacy.length, 1)
  assert.deepEqual([legacy[0]?.kind, legacy[0]?.used, legacy[0]?.usedPercent, legacy[0]?.resetsAt], ['five-hour', 40, 80, undefined])
  assert.deepEqual(legacy[0]?.notes, ['reset-without-timezone'])
  const top = parseKimiUsage({ usage: { limit: 100, remaining: 100 } })
  assert.deepEqual([top[0]?.kind, top[0]?.used, top[0]?.usedPercent], ['other', 0, 0], 'top-level usage has no duration, so it is "other"')
  assert.deepEqual(parseKimiUsage({}), [])
  assert.deepEqual(parseKimiUsage(null), [])
  const odd = parseKimiUsage({ usages: { limit_month_code: { used_ratio: 1.5 }, limit_month_total: { used_ratio: '0.1234' } } })
  assert.deepEqual(odd.find((x) => x.kind === 'monthly-coding')?.notes, ['ratio-out-of-range'])
  assert.equal(odd.find((x) => x.kind === 'monthly-coding')?.usedPercent, undefined)
  assert.equal(odd.find((x) => x.kind === 'monthly-total')?.usedPercent, 12.34, 'ratio units become percent without float noise')
})

test('Codex: windows are classified by duration, never by primary / secondary slot; scoped pools keep their names', () => {
  const pool = { limitId: 'codex', primary: { usedPercent: 12.5, windowDurationMins: 10080, resetsAt: 1793000000 }, secondary: null, planType: 'plus', credits: { hasCredits: true, unlimited: false, balance: '12.50' } }
  const r = parseCodexRateLimits({
    rateLimits: pool,
    rateLimitsByLimitId: { codex: pool, spark: { limitId: 'spark', limitName: 'GPT-5.3-Codex-Spark', primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 1, windowDurationMins: 90 } } },
  })
  const main = r.windows.find((w) => w.id === 'codex:primary')
  assert.equal(main?.kind, 'seven-day', 'a weekly primary is weekly')
  assert.equal(main?.resetsAt, 1793000000 * 1000)
  assert.equal(main?.scope, 'codex')
  assert.equal(r.windows.find((w) => w.id === 'spark:primary')?.kind, 'five-hour')
  assert.equal(r.windows.find((w) => w.id === 'spark:primary')?.scope, 'GPT-5.3-Codex-Spark')
  const odd = r.windows.find((w) => w.id === 'spark:secondary')
  assert.deepEqual([odd?.kind, odd?.durationMinutes, odd?.resetsAt], ['other', 90, undefined])
  assert.equal(r.windows.some((w) => w.id === 'codex:secondary'), false, 'a null window is absent, not zero')
  assert.equal(r.windows.length, 3, 'the main pool is not counted twice')
  assert.deepEqual(r.credits, { hasCredits: true, unlimited: false, balance: '12.50' })
  assert.equal(r.plan, 'plus')
})

test('Claude: only returned windows, model-scoped weeks keep their scope, null means no such window', () => {
  const w = parseClaudeUsage({
    five_hour: { utilization: 37.5, resets_at: '2026-10-30T12:00:00.123+00:00' },
    seven_day: { utilization: 0, resets_at: null },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 10, resets_at: '2026-11-01T00:00:00Z' },
    extra_usage: { is_enabled: false },
  })
  assert.deepEqual(w.map((x) => x.id).sort(), ['five_hour', 'seven_day', 'seven_day_sonnet'])
  assert.equal(w.find((x) => x.id === 'five_hour')?.resetsAt, Date.UTC(2026, 9, 30, 12, 0, 0, 123))
  assert.equal(w.find((x) => x.id === 'seven_day')?.usedPercent, 0)
  assert.equal(w.find((x) => x.id === 'seven_day')?.resetsAt, undefined)
  assert.equal(w.find((x) => x.id === 'seven_day_sonnet')?.scope, 'sonnet')
})

test('balances keep decimal text and each currency; nothing is summed or converted', () => {
  const ds = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
      { currency: 'USD', total_balance: '0.10', granted_balance: '0.00', topped_up_balance: '0.10' },
    ],
  })
  assert.deepEqual(ds?.balances, [
    { currency: 'CNY', currencySource: 'reported', total: '110.00', granted: '10.00', paid: '100.00' },
    { currency: 'USD', currencySource: 'reported', total: '0.10', granted: '0.00', paid: '0.10' },
  ])
  assert.equal(parseDeepSeekBalance({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1' }, { currency: 'CNY', total_balance: '2' }] }), undefined, 'conflicting duplicate currencies are invalid')
  assert.equal(parseDeepSeekBalance({ balance_infos: [] }), undefined)
  const moon = parseMoonshotBalance({ code: 0, status: true, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: -3.00001 } }, 'cn')
  assert.deepEqual(moon, [{ currency: 'CNY', currencySource: 'region-documented', total: '49.58894', granted: '46.58893', paid: '-3.00001' }])
  assert.equal(parseMoonshotBalance({ code: 0, data: { available_balance: 1 } }, 'intl')?.[0]?.currency, 'USD')
  assert.equal(parseMoonshotBalance({ code: 401, data: {} }, 'cn'), undefined)
})

// ---------- transport ----------

test('transport: redirects, auth failures, 429 with Retry-After, oversize and non-JSON bodies are classified without echoing them', async () => {
  const signal = new AbortController().signal
  const now = () => T0
  const cases: [Response, string][] = [
    [new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }), 'redirect-refused'],
    [json({ error: `bad key ${KEY_DS}` }, 401), 'auth-failed'],
    [json({ error: 'forbidden' }, 403), 'auth-failed'],
    [json({ error: 'slow down' }, 429, { 'retry-after': '120' }), 'rate-limited'],
    [json({}, 404), 'unsupported'],
    [json({ error: 'boom' }, 503), 'http-error'],
    [new Response('x'.repeat(1024 * 1024 + 10), { status: 200 }), 'invalid-response'],
    [new Response('<html>not json</html>', { status: 200 }), 'invalid-response'],
  ]
  for (const [res, state] of cases) {
    const f = mockFetch(() => res)
    const err = await getJson(f, USAGE_ENDPOINTS.deepseek, { Authorization: `Bearer ${KEY_DS}` }, signal, now).then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(err instanceof UsageFailure, state)
    assert.equal(err.state, state)
    assert.ok(!err.detail.includes(KEY_DS) && !err.detail.includes('evil') && !err.detail.includes('boom') && !err.detail.includes('html'), `${state} detail is sanitized`)
    if (state === 'rate-limited') assert.equal(err.retryAfterMs, 120_000)
    assert.equal(f.calls[0]?.redirect, 'manual')
  }
  const network = mockFetch(() => {
    throw new Error(`connect ECONNREFUSED with ${KEY_DS}`)
  })
  const e = await getJson(network, USAGE_ENDPOINTS.deepseek, {}, signal, now).catch((x: unknown) => x)
  assert.ok(e instanceof UsageFailure && e.state === 'network' && !e.detail.includes(KEY_DS))
  const never = mockFetch(() => json({}))
  for (const url of ['https://evil.example/user/balance', 'http://api.deepseek.com/user/balance']) {
    const refused = await getJson(never, url, { Authorization: `Bearer ${KEY_DS}` }, signal, now).catch((x: unknown) => x)
    assert.ok(refused instanceof UsageFailure, url)
  }
  assert.equal(never.calls.length, 0, 'a non-official origin is refused before any request')
})

// ---------- the meter service ----------

test('a failed refresh keeps the last valid sample marked stale; the cache restores it after a restart without any key', async () => {
  let fail = false
  const fetchImpl = mockFetch(() => (fail ? json({ error: `server exploded for ${KEY_DS}` }, 500) : json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })))
  const t = team({ deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS } })
  const { m, dataDir, clock } = meter(t, { fetchImpl })
  let r = await m.refresh({ manual: true })
  let x = r.rows[0] as UsageRow
  assert.deepEqual([x.state, x.stale, x.snapshot?.source, x.snapshot?.available, x.snapshot?.fetchedAt], ['ok', false, 'official-api', true, T0])
  assert.equal(x.snapshot?.balances[0]?.total, '110.00')
  fail = true
  clock.now += 120_000
  r = await m.refresh({ manual: true })
  x = r.rows[0] as UsageRow
  assert.deepEqual([x.state, x.stale, x.snapshot?.balances[0]?.total, x.snapshot?.fetchedAt], ['http-error', true, '110.00', T0])
  assert.ok(x.nextAllowedAt && x.nextAllowedAt > clock.now, 'automatic queries back off after a failure')
  assert.ok(!JSON.stringify(r).includes(KEY_DS) && !JSON.stringify(r).includes('exploded'))
  const cache = readFileSync(path.join(dataDir, 'usage-cache.json'), 'utf8')
  assert.ok(!cache.includes(KEY_DS), 'the cache holds a hash identity, never the key')
  m.dispose()
  // A restart: the cached sample is shown as stale until a query succeeds.
  const again = meter(t, { fetchImpl, dataDir })
  const y = again.m.report().rows[0] as UsageRow
  assert.deepEqual([y.state, y.stale, y.snapshot?.balances[0]?.total], ['stale', true, '110.00'])
  again.m.dispose()
})

test('a changed key is a different account: the old sample is never relabelled', async () => {
  let current: Team = team({ deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS } })
  const fetchImpl = mockFetch(() => json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '5.00' }] }))
  const { m } = meter(() => current, { fetchImpl })
  await m.refresh({ manual: true })
  assert.equal(m.report().rows[0]?.snapshot?.balances[0]?.total, '5.00')
  current = { ...current, providers: { deepseek: { ...(current.providers.deepseek as Team['providers'][string]), apiKey: KEY_DS2 } } }
  const x = m.report().rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot, x.stale], ['not-queried', undefined, false])
})

test('a different Claude login drops the old sample before a failed query can show it as the new account', async () => {
  let login: ClaudeLogin = { ok: true, accessToken: 'FAKE-oauth-A', identity: 'a'.repeat(64), plan: 'max' }
  let status = 200
  const fetchImpl = mockFetch(() => (status === 200 ? json({ five_hour: { utilization: 91, resets_at: '2026-10-30T10:00:00Z' } }) : json({ error: 'expired' }, status)))
  const lows: string[] = []
  const t = team({ claude: { kind: 'claude', label: 'Claude' } })
  const { m, clock } = meter(t, { fetchImpl, claudeLogin: () => login, onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
  assert.equal(m.report().rows[0]?.state, 'consent-required', 'no consent: nothing is read')
  await m.refresh({ manual: true })
  assert.equal(fetchImpl.calls.length, 0)
  m.updateSettings({ claudeLoginFile: true })
  let x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot?.plan, x.snapshot?.source, x.snapshot?.windows[0]?.usedPercent], ['ok', 'max', 'internal-compat', 91])
  assert.deepEqual(fetchImpl.calls.map((c) => [c.url, c.headers.Authorization, c.headers['anthropic-beta']]), [[USAGE_ENDPOINTS.claude, 'Bearer FAKE-oauth-A', 'oauth-2025-04-20']])
  assert.deepEqual(lows, ['Low quota: Claude 5-hour 91% used'], 'the low-quota notice fires once')
  clock.now += 120_000
  await m.refresh({ manual: true })
  assert.equal(lows.length, 1, 'the same window at the same level does not repeat the notice')
  login = { ok: true, accessToken: 'FAKE-oauth-B', identity: 'b'.repeat(64) }
  status = 401
  x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot], ['auth-failed', undefined])
  login = { ok: true, accessToken: 'FAKE-oauth-B', identity: 'b'.repeat(64), expiresAt: clock.now - 1 }
  const calls = fetchImpl.calls.length
  x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.equal(x.state, 'auth-expired', 'an expired login is reported, never refreshed')
  assert.equal(fetchImpl.calls.length, calls, 'and no request is sent with it')
  assert.ok(!JSON.stringify(m.report()).includes('FAKE-oauth'))
})

/** A transport that ignores AbortSignal entirely: every request waits until the test answers it. */
function deafFetch(): FetchLike & { calls: Call[]; pending: { url: string; answer: (r: Response) => void }[] } {
  const calls: Call[] = []
  const pending: { url: string; answer: (r: Response) => void }[] = []
  const f = ((url, init) => {
    calls.push({ url, headers: init.headers, redirect: init.redirect })
    return new Promise<Response>((resolve) => pending.push({ url, answer: resolve }))
  }) as FetchLike & { calls: Call[]; pending: typeof pending }
  f.calls = calls
  f.pending = pending
  return f
}

const tick = () => new Promise((r) => setImmediate(r))
const CLAUDE_91 = () => json({ five_hour: { utilization: 91, resets_at: '2026-10-30T10:00:00Z' } })
const DS_OK = () => json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '7.00' }] })

test('withdrawing the Claude consent aborts its query; a late answer (transport ignoring the abort) is never stored, cached or announced', async () => {
  const deaf = deafFetch()
  const lows: string[] = []
  const t = team({ claude: { kind: 'claude', label: 'Claude' }, deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS } })
  const { m, dataDir } = meter(t, { fetchImpl: deaf, claudeLogin: () => ({ ok: true, accessToken: 'FAKE-oauth-A', identity: 'a'.repeat(64) }), onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
  m.updateSettings({ claudeLoginFile: true })
  const running = m.refresh({ manual: true })
  await tick()
  assert.deepEqual(deaf.pending.map((p) => p.url).sort(), [USAGE_ENDPOINTS.claude, USAGE_ENDPOINTS.deepseek].sort())
  m.updateSettings({ claudeLoginFile: false })
  const claudeRow = () => row(m.report(), (x) => x.type === 'claude-subscription')
  assert.deepEqual([claudeRow().state, claudeRow().snapshot, claudeRow().inFlight], ['consent-required', undefined, false])
  // The aborted Claude query settles at once, although its transport never rejects.
  for (const p of deaf.pending) p.answer(p.url === USAGE_ENDPOINTS.claude ? CLAUDE_91() : DS_OK())
  await running
  assert.equal(m.report().refreshing, false)
  assert.deepEqual(lows, [], 'no low-quota notice after the opt-out')
  assert.deepEqual([claudeRow().state, claudeRow().snapshot], ['consent-required', undefined])
  const ds = row(m.report(), (x) => x.type === 'deepseek-api')
  assert.deepEqual([ds.state, ds.snapshot?.balances[0]?.total], ['ok', '7.00'], 'another account in the same refresh is unaffected')
  const cache = readFileSync(path.join(dataDir, 'usage-cache.json'), 'utf8')
  assert.ok(!cache.includes('claude-subscription') && cache.includes(ds.key), 'nothing from the Claude login is cached after the opt-out')
  // Consent given again: the late answer was not kept; only a new query fills the row.
  m.updateSettings({ claudeLoginFile: true })
  assert.deepEqual([claudeRow().state, claudeRow().snapshot], ['not-queried', undefined])
  const again = m.refresh({ manual: true, keys: [claudeRow().key] })
  await tick()
  deaf.pending[deaf.pending.length - 1]?.answer(json({ five_hour: { utilization: 40, resets_at: '2026-10-30T10:00:00Z' } }))
  await again
  assert.deepEqual([claudeRow().state, claudeRow().snapshot?.windows[0]?.usedPercent], ['ok', 40])
  assert.deepEqual(lows, [])
  m.dispose()
})

test('a consent withdrawn and given again while a query hangs still voids that older query', async () => {
  const deaf = deafFetch()
  const lows: string[] = []
  const { m, dataDir } = meter(team({ claude: { kind: 'claude', label: 'Claude' } }), { fetchImpl: deaf, claudeLogin: () => ({ ok: true, accessToken: 'FAKE-oauth-A', identity: 'a'.repeat(64) }), onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
  m.updateSettings({ claudeLoginFile: true })
  const stale = m.refresh({ manual: true })
  await tick()
  m.updateSettings({ claudeLoginFile: false })
  m.updateSettings({ claudeLoginFile: true })
  deaf.pending[0]?.answer(CLAUDE_91())
  await stale
  await tick()
  const x = m.report().rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot, x.inFlight, lows], ['not-queried', undefined, false, []])
  assert.ok(!readFileSync(path.join(dataDir, 'usage-cache.json'), 'utf8').includes('claude-subscription'))
  m.dispose()
})

test('a restarted login cache is withheld until the signed-in account is confirmed: same, switched, missing and failing logins', async () => {
  const codexAs = (email: string) => async (): Promise<CodexQuery> => ({
    account: { account: { type: 'chatgpt', email, planType: 'pro' } },
    rateLimits: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793000000 } } },
  })
  const t = team({ codex: { kind: 'codex', label: 'Codex' } })
  const first = meter(t, { codex: codexAs('person@example.com') })
  assert.equal((await first.m.refresh({ manual: true })).rows[0]?.snapshot?.accountLabel, 'p***@example.com')
  first.m.dispose()
  const dataDir = first.dataDir
  const noSecrets = (m: UsageMeter) => {
    const text = JSON.stringify(m.report()) + m.petSummary('en')
    assert.ok(!/[a-f0-9]{64}/.test(text) && !text.includes('person@') && !text.includes('FAKE-oauth'), 'no identity fingerprint, e-mail or token reaches the renderer or the pet')
  }

  // Restart, nothing queried yet: the previous label and limits are not presented as current.
  const restarted = meter(t, { dataDir, codex: codexAs('person@example.com') })
  let x = restarted.m.report().rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot, x.stale], ['not-queried', undefined, false])
  assert.ok(!JSON.stringify(x).includes('p***') && !restarted.m.petSummary('en').includes('Codex'))
  noSecrets(restarted.m)
  // The same account confirmed: its data is shown again.
  x = (await restarted.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot?.accountLabel], ['ok', 'p***@example.com'])
  restarted.m.dispose()

  // The CLI fails before it names the account (after a restart, or later in a running app): withheld.
  let failing = true
  const flaky = meter(t, {
    dataDir,
    codex: async () => {
      if (failing) throw new UsageFailure('cli-missing', 'the Codex CLI is not installed')
      return codexAs('person@example.com')()
    },
  })
  x = (await flaky.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot], ['cli-missing', undefined])
  failing = false
  flaky.clock.now += 120_000
  assert.equal((await flaky.m.refresh({ manual: true })).rows[0]?.snapshot?.accountLabel, 'p***@example.com')
  failing = true
  flaky.clock.now += 120_000
  x = (await flaky.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot], ['cli-missing', undefined], 'an unknown signed-in account never inherits the last sample')
  noSecrets(flaky.m)
  flaky.m.dispose()

  // Another account signed in after the restart: only its own sample is ever shown.
  const switched = meter(t, { dataDir, codex: codexAs('other@example.com') })
  x = (await switched.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot?.accountLabel], ['ok', 'o***@example.com'])
  switched.m.dispose()

  // Signed out after the restart: no sample, and the old one leaves the cache.
  const out = meter(t, { dataDir, codex: async () => ({ account: { account: null } }) })
  x = (await out.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot], ['auth-missing', undefined])
  assert.ok(!readFileSync(path.join(dataDir, 'usage-cache.json'), 'utf8').includes('codex-subscription'))
  out.m.dispose()
})

test('a restarted Claude cache: kept for the confirmed same login, dropped for another, a missing login or a missing consent', async () => {
  const t = team({ claude: { kind: 'claude', label: 'Claude' } })
  const A: ClaudeLogin = { ok: true, accessToken: 'FAKE-oauth-A', identity: 'a'.repeat(64), plan: 'max' }
  const seed = () => {
    const lows: string[] = []
    const s = meter(t, { fetchImpl: mockFetch(CLAUDE_91), claudeLogin: () => A, onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
    s.m.updateSettings({ claudeLoginFile: true })
    return { ...s, lows }
  }
  const s = seed()
  await s.m.refresh({ manual: true })
  assert.equal(s.lows.length, 1)
  s.m.dispose()

  // Same login, the provider fails after the login was read: the confirmed sample stays, marked stale.
  const lows: string[] = []
  const same = meter(t, { dataDir: s.dataDir, fetchImpl: mockFetch(() => json({}, 500)), claudeLogin: () => A, onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
  assert.deepEqual([same.m.report().rows[0]?.state, same.m.report().rows[0]?.snapshot], ['not-queried', undefined], 'withheld before any query')
  let x = (await same.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.stale, x.snapshot?.windows[0]?.usedPercent], ['http-error', true, 91])
  same.m.dispose()
  // Same login answering the same level: the restart does not repeat the notice.
  const quiet = meter(t, { dataDir: s.dataDir, fetchImpl: mockFetch(CLAUDE_91), claudeLogin: () => A, onLow: (r, w) => lows.push(lowNotice('en', r, w)) })
  await quiet.m.refresh({ manual: true })
  assert.deepEqual(lows, [])
  quiet.m.dispose()

  // Another login (its query rejected): the previous sample is gone, never relabelled.
  const other = meter(t, { dataDir: s.dataDir, fetchImpl: mockFetch(() => json({}, 401)), claudeLogin: () => ({ ok: true, accessToken: 'FAKE-oauth-B', identity: 'b'.repeat(64) }) })
  x = (await other.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot], ['auth-failed', undefined])
  other.m.dispose()

  // No login file any more: nothing is shown and nothing is requested.
  const s2 = seed()
  await s2.m.refresh({ manual: true })
  s2.m.dispose()
  const missingFetch = mockFetch(CLAUDE_91)
  const missing = meter(t, { dataDir: s2.dataDir, fetchImpl: missingFetch })
  x = (await missing.m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot, missingFetch.calls.length], ['auth-missing', undefined, 0])
  missing.m.dispose()

  // The consent is off at restart (its setting changed while the app was closed): the sample is dropped.
  const s3 = seed()
  await s3.m.refresh({ manual: true })
  s3.m.dispose()
  writeFileSync(path.join(s3.dataDir, 'usage-settings.json'), JSON.stringify({ claudeLoginFile: false }))
  const noConsentFetch = mockFetch(CLAUDE_91)
  const noConsent = meter(t, { dataDir: s3.dataDir, fetchImpl: noConsentFetch, claudeLogin: () => A })
  assert.deepEqual([noConsent.m.report().rows[0]?.state, noConsent.m.report().rows[0]?.snapshot], ['consent-required', undefined])
  noConsent.m.updateSettings({ claudeLoginFile: true })
  assert.deepEqual([noConsent.m.report().rows[0]?.state, noConsent.m.report().rows[0]?.snapshot, noConsentFetch.calls.length], ['not-queried', undefined, 0])
  assert.ok(!/[a-f0-9]{64}/.test(JSON.stringify(noConsent.m.report())))
  noConsent.m.dispose()
})

test('429 Retry-After is respected even by a manual refresh', async () => {
  const fetchImpl = mockFetch(() => json({}, 429, { 'retry-after': '300' }))
  const { m, clock } = meter(team({ kimi: { kind: 'openai', label: 'Kimi', baseUrl: 'https://api.kimi.com/coding/v1', apiKey: KEY_KIMI } }), { fetchImpl })
  let x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.equal(x.state, 'rate-limited')
  assert.equal(x.nextAllowedAt, T0 + 300_000)
  clock.now += 60_000
  await m.refresh({ manual: true })
  assert.equal(fetchImpl.calls.length, 1)
  clock.now += 300_000
  x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.equal(fetchImpl.calls.length, 2)
  assert.equal(fetchImpl.calls[0]?.url, USAGE_ENDPOINTS.kimiCn)
})

test('concurrent refreshes share one query; cancel keeps the previous state; dispose aborts and stops everything', async () => {
  const t = team({ moon: { kind: 'openai', label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', apiKey: KEY_MOON } })
  const hang = hangingFetch()
  const { m, changes } = meter(t, { fetchImpl: hang })
  const a = m.refresh({ manual: true })
  const b = m.refresh({ manual: true })
  assert.equal(m.report().rows[0]?.inFlight, true)
  assert.equal(m.report().refreshing, true)
  hang.release(json({ code: 0, status: true, data: { available_balance: '1.50', voucher_balance: '0.50', cash_balance: '1.00' } }))
  await Promise.all([a, b])
  assert.equal(hang.calls.length, 1, 'one request for two concurrent refreshes')
  assert.equal(m.report().rows[0]?.snapshot?.balances[0]?.total, '1.50')
  assert.equal(m.report().rows[0]?.snapshot?.balances[0]?.currencySource, 'region-documented')
  // Cancel: the account keeps its sample and state, and no backoff is added.
  const c = m.refresh({ manual: true })
  assert.equal(m.cancel(), 1)
  await c
  const x = m.report().rows[0] as UsageRow
  assert.deepEqual([x.state, x.stale, x.nextAllowedAt, x.inFlight], ['ok', false, undefined, false])
  // Dispose while a query is in flight: it is aborted, nothing is written or announced afterwards.
  const d = m.refresh({ manual: true })
  const before = changes.length
  m.dispose()
  await d
  assert.equal(changes.length, before, 'no change event after dispose')
  await m.refresh({ manual: true })
  assert.equal(hang.calls.length, 3, 'no query after dispose')
  assert.equal(m.isDisposed(), true)
})

test('the bounded auto-refresh timer starts soon after start, follows the setting and is cleared on dispose', () => {
  const timers: { ms: number; cleared: boolean }[] = []
  const { m } = meter(team({ codex: { kind: 'codex', label: 'Codex' } }), {
    setTimer: (_fn, ms) => {
      timers.push({ ms, cleared: false })
      return timers.length - 1
    },
    clearTimer: (h) => {
      const t = timers[h as number]
      if (t) t.cleared = true
    },
  })
  m.start()
  assert.equal(timers.length, 0, 'auto-refresh is off by default')
  assert.equal(m.updateSettings({ autoRefresh: true, intervalSec: 5 }).intervalSec, 60, 'the interval is clamped to at least 60 s')
  assert.equal(timers[0]?.ms, 60_000)
  m.start()
  assert.equal(timers[1]?.ms, 5_000)
  m.dispose()
  assert.ok(timers.every((t) => t.cleared))
  assert.deepEqual(parseUsageSettings({ intervalSec: 99999, lowUsedPercent: 0, claudeLoginFile: 'yes' }), { autoRefresh: false, intervalSec: 3600, lowUsedPercent: 1, petSummary: true, petNotices: true, claudeLoginFile: false })
})

// ---------- Codex: the official app-server protocol through a fake CLI ----------

function fakeCodex(dir: string, behaviour: 'chatgpt' | 'apikey' | 'old'): string {
  const file = path.join(dir, 'codex.cjs')
  const script = `#!${process.execPath}
const fs = require('fs')
const log = process.env.FAKE_CODEX_LOG
if (process.argv[2] !== 'app-server') process.exit(2)
if (${JSON.stringify(behaviour)} === 'old') { process.stderr.write("error: unrecognized subcommand 'app-server'\\n"); process.exit(2) }
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
let buf = ''
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    const m = JSON.parse(line)
    fs.appendFileSync(log, JSON.stringify({ method: m.method, params: m.params, leaked: Object.keys(process.env).filter((k) => k.startsWith('OPENGROKBOT_')) }) + '\\n')
    if (m.method === 'initialize') out({ id: m.id, result: { userAgent: 'fake' } })
    else if (m.method === 'initialized') {}
    else if (m.method === 'account/read') out({ id: m.id, result: ${behaviour === 'apikey' ? "{ account: { type: 'apiKey' } }" : "{ account: { type: 'chatgpt', email: 'person@example.com', planType: 'pro' }, requiresOpenaiAuth: true }"} })
    else if (m.method === 'account/rateLimits/read') { out({ method: 'account/rateLimits/updated', params: {} }); out({ id: m.id, result: { rateLimits: { limitId: 'codex', primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1793000000 }, secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 1793500000 } } } }) }
    else out({ id: m.id, error: { code: -32601, message: 'unexpected' } })
  }
})
`
  writeFileSync(file, script, { mode: 0o755 })
  return file
}

test('Codex: only initialize, account/read (refreshToken false) and account/rateLimits/read are sent to the installed CLI', async (t) => {
  // Run the fixture with Node on every OS; Windows does not execute POSIX shebangs.
  // Keep the real subprocess and JSON-RPC exchange, including the production spawn arguments.
  const spawn = childProcess.spawn
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const [command, argv, options] = args
    if (command.endsWith('codex.cjs') && existsSync(command)) {
      assert.deepEqual(argv, ['app-server'])
      return spawn(process.execPath, [command, ...argv!], options)
    }
    return spawn(...args)
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
  const dir = tmp('ogb-codex-')
  const log = path.join(dir, 'log.jsonl')
  const env = { ...process.env, FAKE_CODEX_LOG: log, OPENGROKBOT_TOKEN: 'FAKE-app-token' }
  const q = await queryCodexAppServer({ command: fakeCodex(dir, 'chatgpt'), env, signal: new AbortController().signal })
  const sent = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { method: string; params?: { refreshToken?: boolean }; leaked: string[] })
  assert.deepEqual(sent.map((s) => s.method), ['initialize', 'initialized', 'account/read', 'account/rateLimits/read'])
  assert.equal(sent[2]?.params?.refreshToken, false)
  assert.ok(sent.every((s) => s.leaked.length === 0), 'Synodica variables are not passed to the CLI')
  // Through the meter: the e-mail is masked, windows are classified by duration.
  const { m } = meter(team({ codex: { kind: 'codex', label: 'Codex' } }), { codex: async () => q })
  const x = (await m.refresh({ manual: true })).rows[0] as UsageRow
  assert.deepEqual([x.state, x.snapshot?.source, x.snapshot?.plan, x.snapshot?.accountLabel], ['ok', 'official-cli', 'pro', 'p***@example.com'])
  assert.deepEqual(x.snapshot?.windows.map((w) => [w.kind, w.usedPercent]), [['five-hour', 40], ['seven-day', 5]])
  assert.ok(!JSON.stringify(m.report()).includes('person@'))
  // An API-key login has no plan limits; an old CLI and a missing CLI are reported honestly.
  const apikey = await queryCodexAppServer({ command: fakeCodex(tmp('ogb-codex-'), 'apikey'), env: { ...env, FAKE_CODEX_LOG: path.join(dir, 'b.jsonl') }, signal: new AbortController().signal })
  const k = meter(team({ codex: { kind: 'codex', label: 'Codex' } }), { codex: async () => apikey })
  assert.equal((await k.m.refresh({ manual: true })).rows[0]?.state, 'unsupported')
  const old = await queryCodexAppServer({ command: fakeCodex(tmp('ogb-codex-'), 'old'), env, signal: new AbortController().signal }).catch((e: unknown) => e)
  assert.ok(old instanceof UsageFailure && old.state === 'unsupported')
  const missing = await queryCodexAppServer({ command: path.join(dir, 'no-such-codex'), env, signal: new AbortController().signal }).catch((e: unknown) => e)
  assert.ok(missing instanceof UsageFailure && missing.state === 'cli-missing')
  const none = meter(team({ codex: { kind: 'codex', label: 'Codex' } }), { codex: async (): Promise<CodexQuery> => ({ account: { account: null } }) })
  assert.equal((await none.m.refresh({ manual: true })).rows[0]?.state, 'auth-missing')
})

// ---------- routes ----------

test('usage routes: sanitized report, manual refresh, clamped settings, cross-site writes refused', async () => {
  const fetchImpl = mockFetch(() => json({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }))
  const t = team({ deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS }, codex: { kind: 'codex', label: 'Codex' } })
  const { m } = meter(t, { fetchImpl })
  const app = express()
  app.use(express.json())
  app.use('/api/usage', usageRouter(m))
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const get = await fetch(`${base}/api/usage/accounts`)
    assert.equal(get.headers.get('cache-control'), 'no-store')
    const report = (await get.json()) as UsageReport
    assert.equal(report.rows.length, 2)
    const dsKey = report.rows.find((x) => x.type === 'deepseek-api')?.key as string
    const cross = await fetch(`${base}/api/usage/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' })
    assert.equal(cross.status, 403)
    const site = await fetch(`${base}/api/usage/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{"claudeLoginFile":true}' })
    assert.equal(site.status, 403)
    assert.equal(m.getSettings().claudeLoginFile, false, 'a cross-site page cannot grant consent')
    assert.equal(fetchImpl.calls.length, 0)
    const ok = await fetch(`${base}/api/usage/refresh`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body: JSON.stringify({ keys: [dsKey] }) })
    const after = (await ok.json()) as UsageReport
    const ds = after.rows.find((x) => x.key === dsKey)
    assert.deepEqual([ds?.state, ds?.snapshot?.available, ds?.snapshot?.balances[0]?.total], ['ok', false, '0.00'], "zero is shown as reported, with the provider's availability")
    assert.equal(after.rows.find((x) => x.type === 'codex-subscription')?.state, 'not-queried', 'only the requested account was queried')
    assert.ok(!JSON.stringify(after).includes(KEY_DS))
    const put = await fetch(`${base}/api/usage/settings`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://localhost:5180' }, body: JSON.stringify({ intervalSec: 1, lowUsedPercent: 250, autoRefresh: true }) })
    const { settings } = (await put.json()) as { settings: UsageReport['settings'] }
    assert.deepEqual([settings.intervalSec, settings.lowUsedPercent, settings.autoRefresh], [60, 100, true])
  } finally {
    server.close()
    m.dispose()
  }
  assert.equal(usageWriteAllowed({ host: '127.0.0.1:4310' }), true, 'non-browser clients (token-checked) have no Origin')
  assert.equal(usageWriteAllowed({ host: 'office.example:443', origin: 'http://localhost:5180' }), false)
  // A supplied list is valid as a whole or refused as a whole; only an omitted list means "all".
  assert.deepEqual(parseKeys({}), { ok: true })
  assert.deepEqual(parseKeys(undefined), { ok: true })
  assert.deepEqual(parseKeys({ keys: [] }), { ok: true, keys: [] })
  assert.deepEqual(parseKeys({ keys: ['a', 'b', 'a'] }), { ok: true, keys: ['a', 'b'] })
  for (const bad of [{ keys: ['a', 'b c', 7] }, { keys: 'a' }, { keys: null }, { keys: {} }, { keys: ['../evil'] }, { keys: Array.from({ length: 51 }, (_, i) => `k${i}`) }, ['a'], 'keys'])
    assert.deepEqual(parseKeys(bad), { ok: false }, JSON.stringify(bad))
})

async function serve(router: express.Router): Promise<{ base: string; close: () => void }> {
  const app = express()
  app.use(express.json())
  app.use('/api/usage', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

const post = (base: string, route: string, body: string) => fetch(`${base}/api/usage/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base }, body })

test('usage routes: a supplied empty or malformed key list never widens a refresh or a cancel to every account', async () => {
  const fetchImpl = mockFetch((url) => (url === USAGE_ENDPOINTS.deepseek ? json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00' }] }) : json({ code: 0, data: { available_balance: 2 } })))
  const t = team({
    deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS },
    moon: { kind: 'openai', label: 'Moonshot', baseUrl: 'https://api.moonshot.ai/v1', apiKey: KEY_MOON },
  })
  const { m } = meter(t, { fetchImpl })
  const dsKey = row(m.report(), (x) => x.type === 'deepseek-api').key
  const { base, close } = await serve(usageRouter(m))
  try {
    for (const body of [JSON.stringify({ keys: 'deepseek' }), JSON.stringify({ keys: [dsKey, '../evil'] }), JSON.stringify({ keys: [dsKey, 7] }), JSON.stringify({ keys: null }), JSON.stringify([dsKey])]) {
      const res = await post(base, 'refresh', body)
      assert.equal(res.status, 400, body)
      assert.ok(!(await res.text()).includes(dsKey), 'the refusal does not echo the request')
    }
    assert.equal(fetchImpl.calls.length, 0, 'a malformed scope queries nothing')
    const empty = await post(base, 'refresh', JSON.stringify({ keys: [] }))
    assert.equal(empty.status, 200)
    assert.ok(((await empty.json()) as UsageReport).rows.every((x) => x.state === 'not-queried'), 'an empty list is an explicit no-op')
    assert.equal((await post(base, 'refresh', JSON.stringify({ keys: ['unknown-account'] }))).status, 200)
    assert.equal(fetchImpl.calls.length, 0, 'an unknown id matches no account and queries nothing')
    const subset = (await (await post(base, 'refresh', JSON.stringify({ keys: [dsKey] }))).json()) as UsageReport
    assert.deepEqual(fetchImpl.calls.map((c) => c.url), [USAGE_ENDPOINTS.deepseek], 'a valid subset queries only that account')
    assert.equal(row(subset, (x) => x.type === 'moonshot-api').state, 'not-queried')
    await post(base, 'refresh', '{}')
    assert.deepEqual(fetchImpl.calls.map((c) => c.url).sort(), [USAGE_ENDPOINTS.deepseek, USAGE_ENDPOINTS.deepseek, USAGE_ENDPOINTS.moonshotIntl].sort(), 'only an omitted list means every account')
  } finally {
    close()
    m.dispose()
  }

  // Cancel: two queries in flight; malformed or empty scopes abort none of them.
  const hang = hangingFetch()
  const h = meter(t, { fetchImpl: hang })
  const running = h.m.refresh({ manual: true })
  const moonKey = row(h.m.report(), (x) => x.type === 'moonshot-api').key
  assert.equal(hang.calls.length, 2)
  const srv = await serve(usageRouter(h.m))
  try {
    for (const body of [JSON.stringify({ keys: 'x' }), JSON.stringify({ keys: [moonKey, 'a b'] }), JSON.stringify({ keys: [7] })]) assert.equal((await post(srv.base, 'cancel', body)).status, 400, body)
    for (const body of [JSON.stringify({ keys: [] }), JSON.stringify({ keys: ['unknown-account'] })]) assert.deepEqual(await (await post(srv.base, 'cancel', body)).json(), { cancelled: 0 }, body)
    assert.ok(h.m.report().rows.every((x) => x.inFlight), 'both queries still run')
    assert.deepEqual(await (await post(srv.base, 'cancel', JSON.stringify({ keys: [moonKey] }))).json(), { cancelled: 1 })
    assert.deepEqual(
      h.m.report().rows.map((x) => [x.type, x.inFlight]).sort(),
      [
        ['deepseek-api', true],
        ['moonshot-api', false],
      ],
    )
    assert.deepEqual(await (await post(srv.base, 'cancel', '{}')).json(), { cancelled: 1 }, 'an omitted list cancels every query')
    await running
  } finally {
    srv.close()
    h.m.dispose()
  }
})

// ---------- pet entry, localization and deep links ----------

test('the pet menu opens the usage page and says a short localized summary without secrets', async () => {
  const fetchImpl = mockFetch((url) =>
    url === USAGE_ENDPOINTS.deepseek
      ? json({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00' }, { currency: 'USD', total_balance: '0.10' }] })
      : json({ usages: { limit_5h: { used_ratio: 0.955, reset_time: '2026-10-30T10:30:00Z' } } }),
  )
  const t = team({
    deepseek: { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', apiKey: KEY_DS },
    kimi: { kind: 'openai', label: 'Kimi Code', baseUrl: 'https://api.kimi.com/coding/v1', apiKey: KEY_KIMI },
  })
  const { m } = meter(t, { fetchImpl })
  await m.refresh({ manual: true })
  const en = m.petSummary('en')
  assert.ok(en.includes('DeepSeek: balance 110.00 CNY / 0.10 USD'), en)
  assert.ok(en.includes('Kimi Code: 5-hour 95.5% used, resets in 2h 30m'), en)
  const zh = m.petSummary('zh-CN')
  assert.ok(CJK.test(zh) && zh.includes('95.5') && zh.includes('Kimi Code'), 'Chinese summary keeps literal provider names')
  for (const s of [en, zh]) assert.ok(!s.includes('sk-FAKE'))

  const said: string[] = []
  const navigated: string[] = []
  const bridge = new PetBridge({
    runtime: {
      isRunning: () => true,
      call: async (_method: string, url: string, body?: unknown) => {
        if (url.includes('/broadcast')) said.push((body as { text: string }).text)
        return { status: 200, json: url.endsWith('/config') ? { main: { pets: [{ id: 'p1' }] } } : { ok: true } }
      },
    } as unknown as ConstructorParameters<typeof PetBridge>[0]['runtime'],
    snapshot: () => ({ agents: [], providers: {}, projects: [], approvals: [], activity: [], ledger: [], providerChecks: {}, serverNow: T0 }),
    settings: () => ({ enabled: true, follow: { kind: 'team' }, bridge: true, bubbles: true, overlay: true, locale: 'en' }),
    setFollow: () => {},
    navigate: (h) => navigated.push(h),
    extraMenu: () => [
      { label: translate('en', 'pet.menu.openUsage'), hash: '#/usage' },
      { label: translate('en', 'pet.menu.usageSummary'), say: () => m.petSummary('en') },
    ],
  })
  const opened = bridge.handleClicks({ 'Open usage': '1', 'Quota summary': '1' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(opened, ['#/usage'])
  assert.deepEqual(navigated, ['#/usage'])
  assert.equal(said.length, 1)
  assert.ok(said[0]?.includes('DeepSeek: balance') && !said[0]?.includes('sk-FAKE'))
  bridge.stop()
  m.dispose()
})

test('usage deep links are allow-listed and every rendered state, type, kind, source and note has both locales', () => {
  assert.deepEqual(parseAppLink('#/usage'), { view: 'usage' })
  assert.deepEqual(parseAppLink('#/usage/deepseek-api-0123456789ab'), { view: 'usage', focus: 'deepseek-api-0123456789ab' })
  assert.deepEqual(parseAppLink({ view: 'usage', focus: 'emp0' }), { view: 'usage', focus: 'emp0' })
  for (const bad of ['#/usage/../x', '#/usage/a?b', '#/usage/', { view: 'usage', focus: 'a b' }, { view: 'usage', url: 'x' }]) assert.equal(parseAppLink(bad), null, JSON.stringify(bad))
  assert.equal(linkToHash({ view: 'usage', focus: 'codex-subscription' }), '#/usage/codex-subscription')
  const families: [string, readonly string[]][] = [
    ['quota.state.', USAGE_STATES],
    ['quota.type.', USAGE_ACCOUNT_TYPES],
    ['usage.kind.', WINDOW_KINDS],
    ['quota.source.', ['official-api', 'official-cli', 'internal-compat', 'cached', 'local-estimate']],
    ['quota.binding.', ['cli-login', 'provider-key', 'claude-login-file', 'none']],
    ['quota.note.', ['legacy-conflict', 'reset-without-timezone', 'ratio-out-of-range']],
    ['quota.region.', ['cn', 'intl']],
  ]
  for (const [prefix, values] of families) {
    for (const v of values) {
      const key = `${prefix}${v}` as keyof typeof EN
      assert.ok(key in EN, key)
      assert.ok(CJK.test(ZH_CN[key] ?? ''), `${key} is translated`)
    }
  }
  for (const [ms, key] of [[3 * 86400_000 + 3600_000, 'countdown.dh'], [2 * 3600_000 + 5 * 60_000, 'countdown.hm'], [65_000, 'countdown.ms'], [-5, 'countdown.s']] as const) assert.equal(countdownParts(ms).key, key)
  assert.equal(translate('en', countdownParts(2 * 3600_000 + 5 * 60_000).key, countdownParts(2 * 3600_000 + 5 * 60_000).vars), '2h 05m')
  // The page renders every state with a data-state attribute and uses the shared deep link.
  const page = [path.join('client', 'src', 'components', 'Usage.tsx'), path.join('..', 'client', 'src', 'components', 'Usage.tsx'), path.join('..', '..', 'client', 'src', 'components', 'Usage.tsx')].find((p) => existsSync(p))
  assert.ok(page, 'the Usage page exists')
  const src = readFileSync(page, 'utf8')
  for (const needle of ['data-state=', 'quota.state.', 'quota.type.', 'quota.source.', 'refreshUsage', 'quota.claudeConsentHint', 'quota.local']) assert.ok(src.includes(needle), `Usage page uses ${needle}`)
  assert.ok(!/apiKey/.test(src), 'the page never touches credentials')
})
