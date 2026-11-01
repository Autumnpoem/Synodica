import { parseProviderUpdate } from './provider-config.js'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { claudeEnv } from './providers/claude-env.js'
import { parseProvider } from './team.js'
import { classifyProvider } from '../shared/usage.js'

test('Claude gateway keeps its explicit credential mode without changing the parent environment', () => {
  const base = { KEEP: 'yes', ANTHROPIC_API_KEY: 'parent-key', ANTHROPIC_AUTH_TOKEN: 'parent-token', CLAUDE_CODE_OAUTH_TOKEN: 'parent-oauth' }
  const gateway = parseProvider({ kind: 'claude', label: 'Gateway', baseUrl: 'http://127.0.0.1:8080', apiKey: 'gateway-secret', authMode: 'auth-token' })
  const env = claudeEnv(gateway, base)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'gateway-secret')
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
  assert.equal(env.ANTHROPIC_BASE_URL, gateway.baseUrl)
  assert.equal(env.KEEP, 'yes')
  assert.equal(base.CLAUDE_CODE_OAUTH_TOKEN, 'parent-oauth')
  assert.equal(base.ANTHROPIC_AUTH_TOKEN, 'parent-token')
})

test('a third-party Claude gateway cannot silently use official subscription credentials', () => {
  assert.throws(() => claudeEnv({ kind: 'claude', label: 'Gateway', baseUrl: 'http://127.0.0.1:8080' }, {}), /gateway credential/i)
})

test('official Claude subscription and API-key configurations retain their existing behavior', () => {
  const env = claudeEnv({ kind: 'claude', label: 'Official' }, { ANTHROPIC_API_KEY: 'parent', ANTHROPIC_AUTH_TOKEN: 'parent', CLAUDE_CODE_OAUTH_TOKEN: 'existing-oauth' })
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined)
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'existing-oauth')
  const api = claudeEnv({ kind: 'claude', label: 'Official API', apiKey: 'explicit' }, {})
  assert.equal(api.ANTHROPIC_API_KEY, 'explicit')
  assert.equal(api.ANTHROPIC_AUTH_TOKEN, undefined)
})

test('invalid Claude gateway credential modes fail at provider parsing', () => {
  assert.throws(() => parseProvider({ kind: 'claude', label: 'Gateway', authMode: 'cookie' }), /authMode/)
})

test('gateway usage is never presented as the official Claude subscription quota', () => {
  for (const apiKey of [undefined, 'gateway-secret']) {
    const c = classifyProvider({ kind: 'claude', label: 'Gateway', baseUrl: 'https://gateway.example.test', apiKey })
    assert.equal(c.capability, 'unsupported')
    assert.equal(c.reason, 'generic-endpoint')
    assert.equal(c.endpoint, undefined)
  }
  assert.equal(classifyProvider({ kind: 'claude', label: 'Official' }).type, 'claude-subscription')
})

test('changing a Claude endpoint origin requires a fresh explicit credential, never the stored-key marker', () => {
  const current = { kind: 'claude' as const, label: 'Official', apiKey: 'old-official-secret' }
  assert.throws(() => parseProviderUpdate(current, { baseUrl: 'https://gateway.example.test', apiKey: '••••' }, 'claude'), /new credential/i)
  assert.throws(() => parseProviderUpdate(current, { baseUrl: 'https://gateway.example.test' }, 'claude'), /new credential/i)
  const gateway = parseProviderUpdate(current, { baseUrl: 'https://gateway.example.test', apiKey: 'new-gateway-secret', authMode: 'auth-token' }, 'claude')
  assert.equal(gateway.apiKey, 'new-gateway-secret')
  assert.equal(current.apiKey, 'old-official-secret')
  assert.equal(parseProviderUpdate(current, { apiKey: '••••', label: 'Renamed' }, 'claude').apiKey, 'old-official-secret')
})

test('a same-origin URL edit preserves its stored key, and a malformed old URL can be repaired with a fresh key', () => {
  const current = { kind: 'claude' as const, label: 'Gateway', baseUrl: 'https://gateway.example.test', apiKey: 'old-gateway-secret' }
  const unchanged = parseProviderUpdate(current, { baseUrl: 'https://gateway.example.test', apiKey: '••••' }, 'gateway')
  assert.equal(unchanged.apiKey, 'old-gateway-secret')
  const broken = { ...current, baseUrl: 'not a URL' }
  assert.equal(parseProviderUpdate(broken, { baseUrl: 'https://gateway.example.test', apiKey: 'new-key' }, 'gateway').apiKey, 'new-key')
  assert.throws(() => parseProviderUpdate(current, { baseUrl: 'not a URL', apiKey: 'new-key' }, 'gateway'), /valid HTTP/)
})
