import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { QuotaAccount } from '../client/src/components/QuotaDock.tsx'

// tsx's Node test loader uses classic JSX; Vite uses the automatic JSX runtime.
globalThis.React = React
const account = (snapshot, overrides = {}) => ({ key: 'fixture', type: 'codex-subscription', providers: [{ id: 'codex', label: 'Codex', kind: 'codex' }], state: 'ok', stale: false, snapshot, ...overrides })
const draw = (row) => renderToStaticMarkup(React.createElement(QuotaAccount, { row, now: 0, locale: 'en' }))

test('quota summaries show available shares for five-hour and weekly windows', () => {
  const html = draw(account({ windows: [{ id: '5h', kind: 'five-hour', usedPercent: 75 }, { id: 'week', kind: 'seven-day', usedPercent: 12.5 }], balances: [] }))
  assert.match(html, /25%/)
  assert.match(html, /87.5%/)
  assert.match(html, /Available/)
  assert.match(html, /value="25"/)
  assert.doesNotMatch(html, /75%|12.5%/)
})

test('zero and fully used windows remain distinct from missing data', () => {
  const html = draw(account({ windows: [{ id: 'free', kind: 'five-hour', usedPercent: 0 }, { id: 'full', kind: 'seven-day', usedPercent: 100 }, { id: 'unknown', kind: 'monthly-total' }], balances: [] }))
  assert.match(html, /100%/)
  assert.match(html, />0%/)
  assert.match(html, /Not reported/)
  assert.equal((html.match(/<meter /g) ?? []).length, 2)
})

test('DeepSeek and Kimi platform display balances and reported currencies without percent conversion', () => {
  for (const type of ['deepseek-api', 'moonshot-api']) {
    const html = draw(account({ windows: [], balances: [{ currency: 'CNY', total: '123.4567' }, { currency: 'USD', total: '-2.50' }] }, { type }))
    assert.match(html, /123.4567/)
    assert.match(html, /CNY/)
    assert.match(html, /-2.50/)
    assert.match(html, /USD/)
    assert.doesNotMatch(html, /%|<meter/)
  }
})

test('Kimi Code uses reported quota windows; resets and scoped limits are collapsed', () => {
  const html = draw(account({ windows: [{ id: 'coding', kind: 'monthly-coding', usedPercent: 60, resetsAt: 3600000 }, { id: 'model', kind: 'seven-day', scope: 'model A', usedPercent: 20 }], balances: [] }, { type: 'kimi-code', stale: true }))
  assert.match(html, /40%/)
  assert.match(html, /Cached/)
  assert.match(html, /<details class="qd-details">/)
  assert.doesNotMatch(html, /<details[^>]*open/)
  assert.match(html, /80%/)
})
