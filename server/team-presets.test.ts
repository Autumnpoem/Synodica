import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_PROVIDERS } from '../shared/catalog.js'
import { getTeamPreset, presetModel, presetProvider, savedPresetMembers, TEAM_PRESET_IDS } from '../shared/team-presets.js'
import type { Team } from '../shared/types.js'
import { applyTemplate, parseTeam, TeamError } from './team.js'
import { mixedTeam, tmp } from './testkit.js'
import { commandAccess } from './workflow.js'

function office(): Team {
  const team = mixedTeam(tmp())
  team.providers = structuredClone(DEFAULT_PROVIDERS)
  team.agents = team.agents.map((a) => a.provider === 'kimi' ? { ...a, provider: 'kimi-code-cn' } : a)
  return team
}

function assignments(team: Team, id: 'company' | 'laboratory') {
  return Object.fromEntries(getTeamPreset(id).seats.map((seat) => {
    const provider = presetProvider(team, seat, [])
    return [seat.agent.id, { provider, model: presetModel(team, provider) }]
  }))
}

test('company and laboratory each provide five distinct roles with the requested vendor defaults', () => {
  const team = office()
  assert.deepEqual(TEAM_PRESET_IDS, ['company', 'laboratory'])
  for (const id of TEAM_PRESET_IDS) {
    const preset = getTeamPreset(id, 'zh-CN')
    assert.equal(preset.seats.length, 5)
    assert.deepEqual(preset.seats.map((seat) => presetProvider(team, seat, [])), ['codex', 'claude', 'gemini', 'kimi-code-cn', 'deepseek'])
    const result = applyTemplate(team, assignments(team, id), id, 'zh-CN')
    const saved = savedPresetMembers(parseTeam(result.team, tmp()), id)
    assert.equal(saved.length, 5)
    const lead = saved.find((a) => a.workflowRoles?.includes('lead'))!
    const critic = saved.find((a) => a.workflowRoles?.includes('critic'))!
    assert.equal(lead.provider, 'codex')
    assert.equal(critic.provider, 'deepseek')
    assert.equal(commandAccess(lead, team.providers[lead.provider]!.kind).ok, true, 'the team can execute independent verification')
    assert.ok(saved.some((a) => a.provider === 'claude' && a.workflowRoles?.includes('implementer')))
    assert.notEqual(saved[0]!.personality, getTeamPreset(id).seats[0]!.agent.personality, 'Chinese prompts are stored in Chinese')
  }
  assert.notEqual(getTeamPreset('company').seats[0]!.agent.personality, getTeamPreset('laboratory').seats[0]!.agent.personality)
})

test('unavailable providers retain their vendor; missing providers are not silently replaced', () => {
  const team = office()
  const seat = getTeamPreset('company').seats[0]!
  assert.equal(presetProvider(team, seat, [
    { id: 'codex', kind: 'codex', ok: false, detail: 'needs login' },
    { id: 'claude', kind: 'claude', ok: true, detail: 'ready' },
  ]), 'codex')
  delete team.providers.codex
  assert.equal(presetProvider(team, seat, []), '')
  assert.equal(presetModel(team, ''), '')
})

test('official Kimi variants and legacy DeepSeek endpoint match; account model choices stay account-specific', () => {
  const team = office()
  team.providers = {
    moon: { kind: 'openai', label: 'Kimi platform', baseUrl: 'https://api.moonshot.cn/v1/', models: ['account-kimi'] },
    coding: { kind: 'openai', label: 'Kimi coding', baseUrl: 'https://api.kimi.ai/coding/v1', models: ['account-code'] },
    ds: { kind: 'openai', label: 'DeepSeek legacy', baseUrl: 'https://api.deepseek.com/v1/', models: ['account-ds'] },
  }
  const kimi = getTeamPreset('company').seats[3]!
  assert.equal(presetProvider(team, kimi, []), 'coding')
  assert.equal(presetProvider(team, kimi, [{ id: 'moon', kind: 'openai', ok: true, detail: 'ready' }]), 'moon')
  assert.equal(presetProvider(team, getTeamPreset('company').seats[4]!, []), 'ds')
  assert.equal(presetModel(team, 'coding'), 'account-code')
  assert.equal(presetModel(team, 'ds'), 'account-ds')
  delete team.providers.coding!.models
  delete team.providers.ds!.models
  assert.equal(presetModel(team, 'coding'), DEFAULT_PROVIDERS['kimi-code-cn']?.models?.[0], 'official product presets supply a default when an older office has no model list')
  assert.equal(presetModel(team, 'ds'), DEFAULT_PROVIDERS.deepseek?.models?.[0])
  delete team.providers.moon!.models
  assert.equal(presetModel(team, 'moon'), '', 'do not copy a DeepSeek or coding model into a platform account')
  assert.equal(presetModel(team, 'moon', [{ id: 'moon', kind: 'openai', ok: true, detail: 'ready', models: ['available-kimi'] }]), 'available-kimi')
})

test('saved presets reuse edited roles and model assignments across reloads without touching providers or old members', () => {
  const base = office()
  const before = structuredClone(base)
  const first = applyTemplate(base, assignments(base, 'company'), 'company', 'zh-CN')
  const lead = first.team.agents.find((a) => a.templateSeat === 'company-gpt')!
  lead.name = 'My renamed lead'
  lead.personality = 'Keep my custom role instructions.'
  lead.provider = 'claude'
  lead.model = 'my-selected-model'
  const reloaded = parseTeam(first.team, tmp())
  const again = applyTemplate(reloaded, assignments(base, 'company'), 'company')
  assert.deepEqual(again.added, [])
  assert.deepEqual(again.memberIds, first.memberIds)
  assert.deepEqual(again.team.agents, reloaded.agents)
  assert.deepEqual(again.team.providers, before.providers)
  assert.deepEqual(again.team.agents.slice(0, before.agents.length), before.agents)
  assert.deepEqual(base, before, 'the pure operation leaves its input intact')
  const both = applyTemplate(again.team, assignments(base, 'laboratory'), 'laboratory', 'zh-CN')
  assert.equal(both.added.length, 5)
  assert.equal(savedPresetMembers(both.team, 'company')[0]!.model, 'my-selected-model')
  assert.equal(savedPresetMembers(both.team, 'laboratory')[0]!.provider, 'codex')
})

test('skipped and colliding seats remain independently reusable; invalid requests do not change the office', () => {
  const team = office()
  team.agents[0]!.id = 'company-gpt'
  const rows = { ...assignments(team, 'company'), 'company-kimi': { ...assignments(team, 'company')['company-kimi'], skip: true } }
  const first = applyTemplate(team, rows, 'company')
  assert.ok(first.added.includes('company-gpt-2'))
  assert.equal(first.memberIds.length, 4)
  const completed = applyTemplate(first.team, assignments(team, 'company'), 'company')
  assert.deepEqual(completed.added, ['company-kimi'])
  assert.equal(completed.memberIds.length, 5)
  const before = structuredClone(team)
  assert.throws(() => applyTemplate(team, assignments(team, 'company'), 'unknown'), TeamError)
  assert.throws(() => applyTemplate(team, { ...assignments(team, 'company'), 'company-deepseek': { provider: 'missing' } }, 'company'), TeamError)
  assert.deepEqual(team, before)
})
