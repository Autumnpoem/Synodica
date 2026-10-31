import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { EN, translate, ZH_CN, type MessageKey } from '../shared/i18n.js'
import { classifyProvider, isUsageReason, safeReasonVars, USAGE_REASONS } from '../shared/usage.js'
import { mixedTeam, tmp } from './testkit.js'
import { getJson, reasonText, UsageFailure, UsageMeter } from './usagemeter.js'
import type { Team } from '../shared/types.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = [path.join(here, '..'), path.join(here, '..', '..')].find((d) => {
  try {
    readFileSync(path.join(d, 'shared', 'usage.ts'))
    return true
  } catch {
    return false
  }
}) as string
const CJK = new RegExp(`[${String.fromCharCode(0x4e00)}-${String.fromCharCode(0x9fff)}]`)

test('usage reasons: every id has an English and a translated Simplified Chinese text with the same placeholders', () => {
  for (const r of USAGE_REASONS) {
    const key = `quota.reason.${r}` as MessageKey
    assert.ok(key in EN, `${key} in English`)
    const zh = ZH_CN[key]
    assert.ok(zh && CJK.test(zh), `${key} is translated`)
    assert.notEqual(zh, EN[key])
  }
  // The client's Chinese page now shows the Gemini and Claude explanations in Chinese.
  assert.ok(CJK.test(translate('zh-CN', 'quota.reason.gemini-login')))
  assert.ok(CJK.test(translate('zh-CN', 'quota.reason.consent-off')))
  assert.ok(translate('zh-CN', 'quota.reason.http-status', { status: 502 }).includes('502'))
})

test('usage reasons: every account type without a source carries a reason id, and rows render it in English as detail', () => {
  const providers: Team['providers'] = {
    claude: { kind: 'claude', label: 'Claude' },
    'claude-api': { kind: 'claude', label: 'Claude API', apiKey: 'sk-ant-FAKE' },
    'codex-key': { kind: 'codex', label: 'Codex key', apiKey: 'sk-FAKE' },
    gemini: { kind: 'gemini', label: 'Gemini' },
    'gemini-key': { kind: 'gemini', label: 'Gemini key', apiKey: 'FAKE' },
    proxy: { kind: 'openai', label: 'Proxy', baseUrl: 'https://proxy.example/v1', apiKey: 'sk-FAKE-proxy' },
    nourl: { kind: 'openai', label: 'No URL' },
    ollama: { kind: 'openai', label: 'Ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
    'ds-nokey': { kind: 'openai', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  }
  for (const def of Object.values(providers)) {
    const c = classifyProvider(def)
    if (c.capability === 'unsupported') assert.ok(isUsageReason(c.reason), `${def.label} has a reason id`)
  }
  const team = { ...mixedTeam(tmp()), providers, agents: [] }
  const m = new UsageMeter({ getTeam: () => team, dataDir: tmp('ogb-usage-'), setTimer: () => 0, clearTimer: () => {} })
  const rows = m.report().rows
  const want: Record<string, string> = { claude: 'consent-off', 'claude-api': 'anthropic-key', 'codex-key': 'openai-key', gemini: 'gemini-login', 'gemini-key': 'gemini-key', proxy: 'generic-endpoint', nourl: 'no-base-url', ollama: 'local-endpoint', 'ds-nokey': 'no-api-key' }
  for (const [id, reason] of Object.entries(want)) {
    const row = rows.find((r) => r.providers.some((p) => p.id === id))
    assert.equal(row?.reason, reason, `${id} reason`)
    assert.equal(row?.detail, reasonText(reason as never), `${id} detail is the English text of the id`)
  }
  m.dispose()
})

test('usage reasons: transport failures map to fixed ids with numeric parameters only, never response text', async () => {
  const signal = new AbortController().signal
  const cases: [number, string, string][] = [
    [401, 'auth-failed', 'http-401'],
    [403, 'auth-failed', 'http-403'],
    [404, 'unsupported', 'http-404'],
    [429, 'rate-limited', 'http-429'],
    [502, 'http-error', 'http-status'],
    [302, 'redirect-refused', 'redirect-status'],
  ]
  for (const [status, state, reason] of cases) {
    const fetchImpl = async () => new Response(status >= 300 && status < 400 ? null : 'provider says: secret sk-LEAK <html>', { status, headers: { 'retry-after': '5' } })
    const err = await getJson(fetchImpl, 'https://api.deepseek.com/user/balance', { Authorization: 'Bearer sk-LEAK' }, signal, () => 0).then(
      () => undefined,
      (e: unknown) => e,
    )
    assert.ok(err instanceof UsageFailure)
    assert.equal(err.state, state)
    assert.equal(err.reason, reason)
    for (const v of Object.values(err.vars ?? {})) assert.equal(typeof v, 'number')
    assert.ok(!err.detail.includes('sk-LEAK') && !err.detail.includes('html'))
  }
  const bad = await getJson(async () => new Response('not json at all', { status: 200 }), 'https://api.deepseek.com/user/balance', {}, signal, () => 0).catch((e: unknown) => e)
  assert.ok(bad instanceof UsageFailure && bad.reason === 'not-json')
  const net = await getJson(async () => Promise.reject(new Error('ECONNRESET sk-LEAK')), 'https://api.deepseek.com/user/balance', {}, signal, () => 0).catch((e: unknown) => e)
  assert.ok(net instanceof UsageFailure && net.reason === 'network' && !net.detail.includes('sk-LEAK'))
})

test('usage reasons: a failed query stores the id and its parameters on the row; parameters drop free text', async () => {
  const team = { ...mixedTeam(tmp()), providers: { codex: { kind: 'codex' as const, label: 'Codex' } }, agents: [] }
  const m = new UsageMeter({
    getTeam: () => team,
    dataDir: tmp('ogb-usage-'),
    setTimer: () => 0,
    clearTimer: () => {},
    codex: async () => {
      throw new UsageFailure('error', 'codex-exited', { vars: { code: 3 } })
    },
  })
  await m.refresh({ manual: true })
  const row = m.report().rows.find((r) => r.type === 'codex-subscription')
  assert.equal(row?.reason, 'codex-exited')
  assert.deepEqual(row?.reasonVars, { code: 3 })
  assert.ok(CJK.test(translate('zh-CN', 'quota.reason.codex-exited', row?.reasonVars ?? {})))
  m.dispose()
  assert.deepEqual(safeReasonVars({ status: 500, text: 'Error: <html> sk-LEAK', code: 'signal', bad: Number.NaN }), { status: 500, code: 'signal' })
  assert.equal(safeReasonVars({ text: 'Mixed Case Words' }), undefined)
})

test('usage reasons: every failure in the meter source names a reason id, and the page never prints row.detail', () => {
  const src = readFileSync(path.join(root, 'server', 'usagemeter.ts'), 'utf8')
  const literals = [...src.matchAll(/new UsageFailure\([^,]+,\s*'([^']+)'/g)].map((m) => m[1] as string)
  assert.ok(literals.length >= 20)
  for (const l of literals) assert.ok(isUsageReason(l), `"${l}" is a reason id`)
  const page = readFileSync(path.join(root, 'client', 'src', 'components', 'Usage.tsx'), 'utf8')
  assert.ok(!/row\.detail/.test(page), 'the usage page renders the translated reason, not the English detail')
  assert.ok(/quota\.reason\./.test(page))
})
