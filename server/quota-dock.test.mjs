import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clampDockPosition } from '../client/src/quotaPosition.ts'

test('quota dock dragged toward the right edge keeps its close and collapse controls visible', () => {
  // Browser reproduction: a 1440px viewport, dock [1102,1422], header dragged +220px.
  const rect = { left: 1102, right: 1422, top: 462, bottom: 982 }
  const next = clampDockPosition({ x: 220, y: 0 }, { x: 0, y: 0 }, rect, { width: 1440, height: 1000 })
  assert.ok(rect.right + next.x <= 1432, `dock right edge was ${rect.right + next.x}`)
})

test('a restored offscreen dock is reachable after the viewport shrinks', () => {
  const current = { x: 220, y: -900 }
  const rect = { left: 232, right: 528, top: -718, bottom: -388 }
  const next = clampDockPosition(current, current, rect, { width: 320, height: 600 })
  assert.ok(rect.left + next.x - current.x >= 8)
  assert.ok(rect.right + next.x - current.x <= 312)
  assert.ok(rect.top + next.y - current.y >= 8)
  assert.ok(rect.bottom + next.y - current.y <= 592)
})
