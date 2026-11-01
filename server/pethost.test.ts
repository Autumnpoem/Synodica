import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PetRuntime } from './petruntime.js'
import { balanceFromUsage } from './petbridge.js'
import { tmp } from './testkit.js'
import type { UsageReport, UsageRow } from '../shared/usage.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = [path.join(here, '..'), path.join(here, '..', '..')].find((dir) => existsSync(path.join(dir, 'pet-runtime', 'node_modules', 'dsh-pet', 'lib', 'index.js')))

test('cached usage mapping keeps real currency and selects only the followed account', () => {
  const row = (id: string, balances: NonNullable<UsageRow['snapshot']>['balances']): UsageRow => ({
    key: id, type: 'deepseek-api', capability: 'queryable', providers: [{ id, label: id, kind: 'openai' }],
    agents: [{ id, name: id, model: 'm', providerId: id }], binding: { kind: 'provider-key', providerId: id },
    state: 'ok', stale: false, inFlight: false,
    snapshot: { fetchedAt: 1, source: 'official-api', windows: [], balances },
  })
  const report: UsageReport = { rows: [
    row('ada', [{ currency: 'CNY', currencySource: 'reported', total: '7.50', granted: '2.50', paid: '5.00' }]),
    row('bo', [{ currency: 'USD', currencySource: 'reported', total: '3.00', granted: '0.00', paid: '3.00' }]),
  ], settings: { autoRefresh: false, intervalSec: 300, lowUsedPercent: 90, petSummary: true, petNotices: false, claudeLoginFile: false }, serverNow: 1, refreshing: false }
  assert.deepEqual(balanceFromUsage(report, { kind: 'agent', id: 'bo' }), { ok: true, provider: 'bo', shape: 'money', data: { wallets: [{ currency: 'USD', total: '3.00', granted: '0.00', toppedUp: '3.00' }] } })
  assert.equal(balanceFromUsage(report, { kind: 'agent', id: 'missing' }).ok, false, 'never borrow another employee account')
  report.rows[0]!.snapshot!.balances = [{ currency: 'CNY', currencySource: 'reported', total: '7.50' }]
  assert.deepEqual(balanceFromUsage(report, { kind: 'team' }), { ok: true, provider: 'bo', shape: 'money', data: { wallets: [{ currency: 'USD', total: '3.00', granted: '0.00', toppedUp: '3.00' }] } }, 'do not make up missing granted/paid amounts')
  report.rows[1]!.snapshot!.balances = [{ currency: 'USD', currencySource: 'reported', total: '0.00', granted: '0.00', paid: '0.00' }]
  assert.deepEqual(balanceFromUsage(report, { kind: 'agent', id: 'bo' }), { ok: true, provider: 'bo', shape: 'points', data: { unit: 'USD', total: '0.00' } }, 'the original money bubble would wrongly label a sole zero USD balance as CNY')
})

test('original pet balance action uses Synodica cached balance through the public registration point', { skip: !root && 'pinned pet package is absent' }, async () => {
  const dataDir = tmp('synodica-pet-balance-')
  const logs: string[] = []
  const rt = new PetRuntime({
    appRoot: root!, dataDir, env: { PATH: process.env.PATH ?? '' }, log: (line) => logs.push(line),
    balance: () => ({ ok: true, provider: 'Synodica fixture', shape: 'money', data: { wallets: [{ currency: 'CNY', total: '7.50', granted: '2.50', toppedUp: '5.00' }] } }),
  })
  try {
    const started = await rt.start()
    assert.equal(started.state, 'running', `${started.reason ?? ''}\n${logs.join('\n')}`)
    assert.equal((await rt.call('POST', '/dsh-pet-7340/balance')).status, 200)
    const state = (await rt.call('GET', '/dsh-pet-7340/state')).json as { sections?: { balance?: { data?: { ok?: boolean; shape?: string; data?: { wallets?: { total?: string }[] } } } } }
    assert.equal(state.sections?.balance?.data?.ok, true)
    assert.equal(state.sections?.balance?.data?.shape, 'money')
    assert.equal(state.sections?.balance?.data?.data?.wallets?.[0]?.total, '7.50')
  } finally {
    await rt.stop()
  }
})

test('pet host rejects a same-character-count non-ASCII capability without exiting', { skip: !root && 'pinned pet package is absent' }, async () => {
  const dataDir = tmp('synodica-pet-token-')
  const rt = new PetRuntime({ appRoot: root!, dataDir, env: { PATH: process.env.PATH ?? '' }, log: () => {}, balance: () => ({ ok: false, provider: 'fixture', reason: 'unsupported' }) })
  try {
    const started = await rt.start()
    assert.equal(started.state, 'running', started.reason)
    const info = JSON.parse(readFileSync(path.join(rt.home, 'dsh-pet', 'standalone-runtime.json'), 'utf8')) as { port: number; token: string }
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: info.port, path: '/health', headers: { host: `127.0.0.1:${info.port}`, 'x-dsh-pet-token': 'é'.repeat(info.token.length) } }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      })
      req.on('error', reject)
      req.end()
    })
    assert.equal(status, 403)
    assert.equal(rt.status().state, 'running')
  } finally { await rt.stop() }
})
