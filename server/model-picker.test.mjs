import test from 'node:test'
import assert from 'node:assert/strict'
import { initialCatalogModel, modelChoices, modelForProviderSwitch, modelPickerText } from '../client/src/modelPicker.ts'
import { agentIdFor, defaultPersonality, prepareAgentForSave, profileIssue } from '../client/src/agentProfile.ts'

const catalog = (models, source = 'upstream', supportsDefault = false) => ({ provider: 'p', models, source, supportsDefault, updatedAt: 1 })

test('refreshing a catalog preserves a saved unknown model as a visible choice', () => {
  const choices = modelChoices('legacy-custom-77', { kind: 'openai', label: 'API', models: ['configured-id'] }, catalog([{ id: 'new-upstream', label: 'New upstream' }]))
  assert.deepEqual(choices.map((choice) => [choice.id, choice.source]), [
    ['new-upstream', 'upstream'], ['configured-id', 'configured'], ['legacy-custom-77', 'saved'],
  ])
})

test('catalog arrival never mutates the selected model', () => {
  const selectedModel = 'my-private-model'
  const choicesAfterRefresh = modelChoices(selectedModel, { kind: 'openai', label: 'API' }, catalog([{ id: 'listed', label: 'Listed' }]))
  assert.equal(selectedModel, 'my-private-model')
  assert.equal(choicesAfterRefresh.at(-1)?.id, selectedModel)
})

test('configured IDs are not presented as upstream results and default clearly delegates to CLI', () => {
  const choices = modelChoices('', { kind: 'openai', label: 'API' }, catalog([{ id: 'preset-id', label: 'Preset ID' }], 'configured'))
  assert.equal(choices[0]?.source, 'configured')
  assert.match(modelPickerText('en', 'defaultChoice'), /not a model name/)
  assert.match(modelPickerText('en', 'availability'), /concrete model ID/)
})

test('provider switch uses supported default or configured API model without carrying unrelated IDs', () => {
  const cli = { kind: 'codex', label: 'Codex' }
  const api = { kind: 'openai', label: 'API', models: ['api-configured'] }
  assert.equal(initialCatalogModel(catalog([], 'cli', true), cli), 'default')
  assert.equal(modelForProviderSwitch(cli, 'claude-opus-5', catalog([], 'cli', true)), 'default')
  assert.equal(modelForProviderSwitch(cli, 'shared-model', catalog([{ id: 'shared-model', label: 'Shared' }], 'cli')), 'shared-model')
  assert.equal(modelForProviderSwitch(api, 'claude-opus-5', null), 'api-configured')
})

const agent = (patch = {}) => ({
  id: '', name: '', role: '', color: '#123456', shape: 'round', provider: 'claude', model: 'saved-model', effort: 'medium',
  personality: '', tools: [], permissionMode: 'default', mcpServers: [], inheritClaudeSettings: false, autoApproveTools: false,
  muted: false, approvals: 'auto', ...patch,
})

test('profile save rejects missing role and creates a useful default only for blank custom persona', () => {
  assert.equal(profileIssue(agent({ name: 'Rae' }), [], null), 'role-required')
  assert.equal(profileIssue(agent({ name: 'Rae', role: 'QA', model: '' }), [], null), 'model-required')
  const custom = '  Keep this exact custom prompt.\n'
  const kept = prepareAgentForSave(agent({ name: 'Rae', role: 'QA', personality: custom }), [], null, 'en', 'uuid')
  assert.equal(kept.issue, null)
  assert.equal(kept.agent.personality, custom)
  assert.equal(kept.agent.model, 'saved-model')
  const generated = prepareAgentForSave(agent({ name: 'Rae', role: 'QA', scope: 'release checks' }), [], null, 'en', 'uuid')
  assert.match(generated.agent.personality, /RAE.*QA.*release checks/)
  assert.match(defaultPersonality('Rae', 'QA', undefined, 'zh-CN'), /\u4f60\u662f/)
  assert.match(defaultPersonality('Rae', 'QA', undefined, 'en'), /fact-based concerns about any plan/)
})

test('new staff names are unique while IDs avoid slug collisions', () => {
  const existing = [agent({ id: 'rae', name: 'Rae' }), agent({ id: 'rae-2', name: 'Different Name' })]
  assert.equal(profileIssue(agent({ name: ' RAE ', role: 'QA' }), existing, null), 'name-taken')
  assert.equal(agentIdFor('Rae', existing, 'uuid'), 'rae-3')
  assert.equal(agentIdFor('\u6797\u6c38', [], 'uuid'), 'agent-uuid')
})
