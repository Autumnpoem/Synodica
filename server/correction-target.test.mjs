import assert from 'node:assert/strict'
import test from 'node:test'
import { selectCorrectionTarget } from '../client/src/correctionTarget.ts'

const agents = [
  { id: 'gpt', name: 'GPT' },
  { id: 'dsh', name: 'DSH' },
  { id: 'outside', name: 'Outside' },
]
const chat = { kind: 'group', memberIds: ['user', 'gpt', 'dsh'] }
const project = { ...chat, projectId: 'project-1' }

test('a reply to a conversation member targets that agent', () => {
  assert.equal(selectCorrectionTarget('please revise', 'dsh', chat, agents)?.id, 'dsh')
})

test('a single explicit mention takes priority over the reply target', () => {
  assert.equal(selectCorrectionTarget('@GPT please revise', 'dsh', chat, agents)?.id, 'gpt')
})

test('@everyone and multiple distinct mentions remain global', () => {
  assert.equal(selectCorrectionTarget('@everyone please revise', 'dsh', chat, agents), undefined)
  assert.equal(selectCorrectionTarget('@GPT @DSH please revise', 'dsh', chat, agents), undefined)
  assert.equal(selectCorrectionTarget('@GPT and @GPT please revise', 'dsh', chat, agents)?.id, 'gpt')
})

test('a reply to a foreign or user message cannot target an agent', () => {
  assert.equal(selectCorrectionTarget('please revise', 'foreign-agent', chat, agents), undefined)
  assert.equal(selectCorrectionTarget('please revise', 'user', chat, agents), undefined)
  assert.equal(selectCorrectionTarget('@Outside please revise', 'dsh', chat, agents), undefined)
})

test('project corrections always cover the whole project', () => {
  assert.equal(selectCorrectionTarget('@DSH please revise', 'dsh', project, agents), undefined)
})
