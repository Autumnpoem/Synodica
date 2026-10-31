import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiscussionPanel } from '../client/src/components/DiscussionPanel.tsx'
import { setLocale } from '../client/src/i18n.ts'
globalThis.React = React
const project = { id: 'p', planEpoch: 1, revision: 1, discussions: [{ id: 'r', epoch: 1, revision: 0, startedAt: 1, status: 'complete', participants: [{ agentId: 'writer', status: 'objected', objectionIds: ['O-1'] }] }], objections: [{ id: 'O-1', roundId: 'r', epoch: 1, revision: 0, by: 'writer', claim: 'Keep this dissent visible', reason: 'A concrete reason', basis: 'hypothesis', citations: [], severity: 'blocking', status: 'unresolved', disposition: { by: 'lead', reason: 'Monitor while implementing', at: 1, revision: 0 } }] }
const draw = (p) => renderToStaticMarkup(React.createElement(DiscussionPanel, { project: p, name: (id) => id }))
test('an execution correction keeps current plan dissent visible without opening history', () => {
  setLocale('en')
  const html = draw(project)
  assert.match(html, /discussion-current/)
  assert.doesNotMatch(html, /discussion-earlier/)
  assert.match(html, /Keep this dissent visible/)
  assert.match(html, /Monitor while implementing/)
  assert.match(html, /Round 1/)
})
test('user decisions require a reason; superseded discussion never shows resolution buttons', () => {
  const p = structuredClone(project); p.revision = 0; p.objections[0].status = 'needs-user'
  let html = draw(p)
  assert.match(html, /textarea[^>]*required/)
  assert.equal((html.match(/<button[^>]*disabled/g) ?? []).length, 3)
  p.discussions[0].status = 'superseded'
  html = draw(p)
  assert.doesNotMatch(html, /<textarea/)
  assert.match(html, /discussion-earlier/)
})
