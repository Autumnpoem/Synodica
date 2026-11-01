import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseAvatarRef } from '../shared/avatar.js'
import { DEFAULT_PROVIDERS, providerEndpointKey } from '../shared/catalog.js'
import { DEV_TEAM_TEMPLATE } from '../shared/templates.js'
import { getTeamPreset, TEAM_PRESET_IDS, type TeamPresetId } from '../shared/team-presets.js'
import type { Locale } from '../shared/i18n.js'
import type { Agent, AutoReviewRule, HelperModel, McpServerDef, ProviderDef, Skill, TaskTier, Team, TeamSettings, WorkflowRole } from '../shared/types.js'

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk'])
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const SHAPES = new Set(['blob', 'round', 'triangle', 'hex', 'drop'])
const PROVIDER_KINDS = new Set(['claude', 'codex', 'gemini', 'openai'])
const WORKFLOW_ROLES = new Set<string>(['lead', 'critic', 'implementer', 'reviewer', 'tester', 'writer'])
const TIERS = new Set<string>(['routine', 'standard', 'critical'])

/**
 * What a team.json written before configurable helpers implicitly used: Claude Haiku on the
 * built-in Claude login for routing and memory. Applied only when the key is absent, and then
 * saved explicitly so it shows (and can be changed) in Settings.
 */
export const LEGACY_HELPER: HelperModel = { mode: 'model', provider: 'claude', model: 'claude-haiku-4-5' }

export const DEFAULT_SETTINGS: TeamSettings = {
  maxMessagesPerRound: 6,
  maxTurnsPerAgentPerRound: 2,
  maxTurnsPerReply: 40,
  groupMode: 'smart',
  language: 'auto',
  notifications: true,
  autoReview: [],
  router: { mode: 'deterministic' },
  memory: { mode: 'off' },
  maxTaskAttempts: 3,
  maxCritiqueRounds: 1,
  planDiscussion: 'auto',
  maxDiscussionParticipants: 6,
  autoStartExecution: false,
}

export class TeamError extends Error {}

function fail(msg: string): never {
  throw new TeamError(`team: ${msg}`)
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(`${field} must be a non-empty string`)
  return v
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string' && t.length > 0) : []
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asStringMap(v: unknown): Record<string, string> | undefined {
  const r = asRecord(v)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(r)) if (typeof val === 'string') out[k] = val
  return Object.keys(out).length > 0 ? out : undefined
}

export function parseAgent(raw: unknown, label = 'agent'): Agent {
  const r = asRecord(raw)
  const id = asString(r.id, `${label}.id`)
  if (!/^[a-z0-9_-]+$/.test(id)) fail(`${label}.id must be lowercase letters, digits, - or _`)
  const permissionMode = r.permissionMode === undefined ? 'dontAsk' : asString(r.permissionMode, `${label}.permissionMode`)
  if (!PERMISSION_MODES.has(permissionMode)) fail(`${label}.permissionMode is invalid`)
  const effort = r.effort === undefined ? 'medium' : asString(r.effort, `${label}.effort`)
  if (!EFFORTS.has(effort)) fail(`${label}.effort is invalid`)
  const shape = r.shape === undefined ? 'blob' : asString(r.shape, `${label}.shape`)
  if (!SHAPES.has(shape)) fail(`${label}.shape must be one of ${[...SHAPES].join(', ')}`)
  const name = asString(r.name, `${label}.name`).trim()
  if (name.includes('@')) fail(`${label}.name must not contain @`)
  const agent: Agent = {
    id,
    name,
    role: asString(r.role, `${label}.role`).trim(),
    shape: shape as Agent['shape'],
    color: asString(r.color, `${label}.color`),
    provider: r.provider === undefined ? 'claude' : asString(r.provider, `${label}.provider`),
    model: r.model === undefined ? 'claude-opus-5' : asString(r.model, `${label}.model`),
    effort: effort as Agent['effort'],
    personality: asString(r.personality, `${label}.personality`),
    tools: asStringList(r.tools),
    permissionMode: permissionMode as Agent['permissionMode'],
    mcpServers: asStringList(r.mcpServers),
    inheritClaudeSettings: r.inheritClaudeSettings === true,
    autoApproveTools: r.autoApproveTools === true,
    muted: r.muted === true,
    approvals: r.approvals === 'ask-dangerous' || r.approvals === 'ask-all' ? r.approvals : 'auto',
  }
  const roles = asStringList(r.workflowRoles).filter((x): x is WorkflowRole => WORKFLOW_ROLES.has(x))
  if (typeof r.templateSeat === 'string' && /^(company|laboratory)-(gpt|claude|gemini|kimi|deepseek)$/.test(r.templateSeat)) agent.templateSeat = r.templateSeat
  if (roles.length > 0) agent.workflowRoles = [...new Set(roles)]
  if (typeof r.tier === 'string' && TIERS.has(r.tier)) agent.tier = r.tier as TaskTier
  if (typeof r.cwd === 'string' && r.cwd.trim().length > 0) agent.cwd = r.cwd.trim()
  if (typeof r.department === 'string' && r.department.trim().length > 0) agent.department = r.department.trim()
  if (typeof r.scope === 'string' && r.scope.trim().length > 0) agent.scope = r.scope.trim()
  // Only a well-formed generated id survives; anything else (paths, URLs) falls back to color and shape.
  const avatar = parseAvatarRef(r.avatar)
  if (avatar) agent.avatar = avatar
  return agent
}

export function parseMcpServer(raw: unknown, label = 'mcp server'): McpServerDef {
  const r = asRecord(raw)
  const type = r.type === undefined ? 'stdio' : asString(r.type, `${label}.type`)
  if (type === 'stdio') {
    const def: McpServerDef = { type: 'stdio', command: asString(r.command, `${label}.command`) }
    const args = asStringList(r.args)
    if (args.length > 0) def.args = args
    const env = asStringMap(r.env)
    if (env) def.env = env
    return def
  }
  if (type === 'http' || type === 'sse') {
    const def: McpServerDef = { type, url: asString(r.url, `${label}.url`) }
    const headers = asStringMap(r.headers)
    if (headers) def.headers = headers
    return def
  }
  return fail(`${label}.type must be stdio, http or sse`)
}

export function parseProvider(raw: unknown, label = 'provider'): ProviderDef {
  const r = asRecord(raw)
  const kind = asString(r.kind, `${label}.kind`)
  if (!PROVIDER_KINDS.has(kind)) fail(`${label}.kind must be claude, codex, gemini or openai`)
  const def: ProviderDef = { kind: kind as ProviderDef['kind'], label: typeof r.label === 'string' && r.label.trim() ? r.label.trim() : kind }
  if (typeof r.apiKey === 'string' && r.apiKey.trim()) def.apiKey = r.apiKey.trim()
  if (typeof r.baseUrl === 'string' && r.baseUrl.trim()) def.baseUrl = r.baseUrl.trim().replace(/\/+$/, '')
  if (kind === 'claude' && r.authMode !== undefined) {
    if (r.authMode !== 'api-key' && r.authMode !== 'auth-token') fail(`${label}.authMode must be api-key or auth-token`)
    def.authMode = r.authMode
  }
  if (kind === 'openai' && !def.baseUrl) fail(`${label}.baseUrl is required for an API provider`)
  const models = asStringList(r.models)
  if (models.length > 0) def.models = models
  if (r.echoReasoning === false) def.echoReasoning = false
  return def
}

function parseHelper(raw: unknown, field: string, absent: HelperModel, offMode: 'deterministic' | 'off'): HelperModel {
  if (raw === undefined) return absent
  const r = asRecord(raw)
  if (r.mode === 'model') {
    const provider = typeof r.provider === 'string' ? r.provider.trim() : ''
    const model = typeof r.model === 'string' ? r.model.trim() : ''
    if (!provider) fail(`settings.${field}.provider is required when mode is model`)
    return { mode: 'model', provider, model }
  }
  if (r.mode === undefined || r.mode === offMode) return { mode: offMode }
  return fail(`settings.${field}.mode must be ${offMode} or model`)
}

function parseRules(raw: unknown): AutoReviewRule[] {
  if (!Array.isArray(raw)) return []
  const out: AutoReviewRule[] = []
  for (const item of raw) {
    const r = asRecord(item)
    if (typeof r.tool !== 'string' || !r.tool.trim()) continue
    const rule: AutoReviewRule = { id: typeof r.id === 'string' && r.id ? r.id : Math.random().toString(36).slice(2, 10), action: r.action === 'require' ? 'require' : 'allow', tool: r.tool.trim() }
    if (typeof r.match === 'string' && r.match.trim()) rule.match = r.match.trim()
    out.push(rule)
  }
  return out
}

export function parseSkill(raw: unknown, label = 'skill'): Skill {
  const r = asRecord(raw)
  return { name: asString(r.name, `${label}.name`).trim(), description: typeof r.description === 'string' ? r.description.trim() : '', body: asString(r.body, `${label}.body`) }
}

function parseSettings(raw: unknown): TeamSettings {
  const r = asRecord(raw)
  const num = (k: 'maxMessagesPerRound' | 'maxTurnsPerAgentPerRound' | 'maxTurnsPerReply' | 'maxTaskAttempts' | 'maxCritiqueRounds' | 'maxDiscussionParticipants', min: number, max: number): number => {
    const v = r[k]
    if (v === undefined) return DEFAULT_SETTINGS[k] ?? min
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`settings.${k} must be a number`)
    return Math.min(max, Math.max(min, Math.round(v)))
  }
  const groupMode = r.groupMode === undefined ? DEFAULT_SETTINGS.groupMode : asString(r.groupMode, 'settings.groupMode')
  if (!(['smart', 'everyone', 'mentions-only'] as string[]).includes(groupMode)) fail('settings.groupMode must be smart, everyone or mentions-only')
  const planDiscussion = r.planDiscussion ?? 'auto'
  if (!['auto', 'on', 'off'].includes(String(planDiscussion))) fail('settings.planDiscussion must be auto, on or off')
  const language = r.language === undefined ? DEFAULT_SETTINGS.language : asString(r.language, 'settings.language').trim()
  // Any language name or tag is allowed; keep it short and printable because it goes into prompts.
  if (!language || language.length > 40 || /[\n\r<>{}`]/.test(language)) fail('settings.language must be auto or a short language name/tag')
  return {
    maxMessagesPerRound: num('maxMessagesPerRound', 1, 30),
    maxTurnsPerAgentPerRound: num('maxTurnsPerAgentPerRound', 1, 10),
    maxTurnsPerReply: num('maxTurnsPerReply', 1, 200),
    groupMode: groupMode as TeamSettings['groupMode'],
    language,
    notifications: r.notifications === undefined ? DEFAULT_SETTINGS.notifications : r.notifications === true,
    autoReview: parseRules(r.autoReview),
    router: parseHelper(r.router, 'router', LEGACY_HELPER, 'deterministic'),
    memory: parseHelper(r.memory, 'memory', LEGACY_HELPER, 'off'),
    maxTaskAttempts: num('maxTaskAttempts', 1, 10),
    maxCritiqueRounds: num('maxCritiqueRounds', 0, 3),
    planDiscussion: planDiscussion as TeamSettings['planDiscussion'],
    maxDiscussionParticipants: num('maxDiscussionParticipants', 1, 12),
    autoStartExecution: r.autoStartExecution === true,
  }
}

export function validateTeam(team: Team): void {
  const ids = new Set(team.agents.map((a) => a.id))
  if (ids.size !== team.agents.length) fail('agent ids must be unique')
  const names = new Set(team.agents.map((a) => a.name.toUpperCase()))
  if (names.size !== team.agents.length) fail('agent names must be unique (case-insensitive)')
  for (const a of team.agents) {
    if (!(a.provider in team.providers)) fail(`${a.name} uses unknown provider "${a.provider}"`)
    for (const s of a.mcpServers) if (!(s in team.mcpServers)) fail(`${a.name} references unknown MCP server "${s}"`)
  }
  for (const key of ['router', 'memory'] as const) {
    const h = team.settings[key]
    if (h?.mode === 'model' && !(h.provider in team.providers)) fail(`settings.${key} uses unknown provider "${h.provider}"`)
  }
}

export function parseTeam(raw: unknown, fallbackWorkspace: string): Team {
  const r = asRecord(raw)
  const owner = asRecord(r.owner)
  const agentsRaw = Array.isArray(r.agents) ? r.agents : fail('agents must be an array')
  const agents = agentsRaw.map((a, i) => parseAgent(a, `agents[${i}]`))
  const mcpServers: Record<string, McpServerDef> = {}
  for (const [name, def] of Object.entries(asRecord(r.mcpServers))) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) fail(`mcpServers name "${name}" must be letters, digits, - or _`)
    mcpServers[name] = parseMcpServer(def, `mcpServers.${name}`)
  }
  const skills: Record<string, Skill> = {}
  for (const [id, def] of Object.entries(asRecord(r.skills))) {
    if (!/^[a-z0-9_-]+$/.test(id)) fail(`skills id "${id}" must be lowercase letters, digits, - or _`)
    skills[id] = parseSkill(def, `skills.${id}`)
  }
  const providers: Record<string, ProviderDef> = {}
  const savedProviders = asRecord(r.providers)
  for (const [id, def] of Object.entries(DEFAULT_PROVIDERS)) {
    const baseUrl = providerEndpointKey(def.baseUrl)
    const alreadyConfigured = id in savedProviders || (baseUrl && Object.entries(savedProviders).some(([, saved]) => {
      const provider = asRecord(saved)
      return providerEndpointKey(typeof provider.baseUrl === 'string' ? provider.baseUrl : undefined) === baseUrl
    }))
    if (!alreadyConfigured) providers[id] = { ...def }
  }
  for (const [id, def] of Object.entries(savedProviders)) {
    if (!/^[a-z0-9_-]+$/.test(id)) fail(`providers id "${id}" must be lowercase letters, digits, - or _`)
    providers[id] = parseProvider(def, `providers.${id}`)
  }
  // A leading ~ means the home folder, so the shipped template can point outside the app checkout.
  const workspace = (typeof r.workspace === 'string' && r.workspace.length > 0 ? r.workspace : fallbackWorkspace).replace(/^~(?=$|[\\/])/, os.homedir())
  const team: Team = {
    company: typeof r.company === 'string' ? r.company : 'My Company',
    owner: {
      id: 'user',
      name: typeof owner.name === 'string' ? owner.name : 'You',
      title: typeof owner.title === 'string' ? owner.title : 'Owner',
      ...(parseAvatarRef(owner.avatar) ? { avatar: parseAvatarRef(owner.avatar) } : {}),
    },
    workspace: path.resolve(workspace),
    agents,
    providers,
    mcpServers,
    skills,
    settings: parseSettings(r.settings),
  }
  validateTeam(team)
  return team
}

/**
 * Save preset seats without overwriting existing employees. Saved company/laboratory seats are
 * reused; unrelated id/name collisions get a numbered id. The legacy development template keeps
 * its additive behavior. Returns the unsaved team, added ids and selected member ids.
 */
export function applyTemplate(team: Team, assignments: Record<string, { provider?: unknown; model?: unknown; skip?: unknown }>, templateId = 'dev-team', locale: Locale = 'en'): { team: Team; added: string[]; memberIds: string[] } {
  if (templateId !== 'dev-team' && !TEAM_PRESET_IDS.includes(templateId as TeamPresetId)) fail('unknown team template')
  const seats = templateId === 'dev-team' ? DEV_TEAM_TEMPLATE : getTeamPreset(templateId as TeamPresetId, locale).seats
  const agents = [...team.agents]
  const added: string[] = []
  const memberIds: string[] = []
  for (const seat of seats) {
    const a = assignments[seat.agent.id] ?? {}
    if (a.skip === true) continue
    const existing = seat.agent.templateSeat && agents.find((x) => x.templateSeat === seat.agent.templateSeat)
    if (existing) {
      memberIds.push(existing.id)
      continue
    }
    const provider = typeof a.provider === 'string' ? a.provider : ''
    const def = team.providers[provider]
    if (!def) fail(`template seat ${seat.agent.name}: pick a configured provider`)
    const model = typeof a.model === 'string' && a.model.trim() ? a.model.trim() : (seat.suggestedModel[def.kind] ?? '')
    if (!model) fail(`template seat ${seat.agent.name}: pick a model for ${def.label}`)
    let id = seat.agent.id
    let name = seat.agent.name
    for (let n = 2; agents.some((x) => x.id === id || x.name.toUpperCase() === name.toUpperCase()); n++) {
      id = `${seat.agent.id}-${n}`
      name = `${seat.agent.name} ${n}`
    }
    agents.push(parseAgent({ ...seat.agent, id, name, provider, model }, `template ${seat.agent.id}`))
    added.push(id)
    memberIds.push(id)
  }
  return { team: { ...team, agents }, added, memberIds }
}

export function loadTeam(file: string): Team {
  return parseTeam(JSON.parse(readFileSync(file, 'utf8')), path.dirname(file))
}

export function saveTeam(file: string, team: Team): void {
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(team, null, 2)}\n`)
  renameSync(tmp, file)
}
