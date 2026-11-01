import type { Agent } from '../../shared/types'
import type { UiLocale } from './modelPicker'

export type ProfileIssue = 'name-required' | 'role-required' | 'model-required' | 'name-taken'

export function defaultPersonality(name: string, role: string, scope: string | undefined, locale: UiLocale): string {
  const who = name.trim() || (locale === 'zh-CN' ? '\u961f\u53cb' : 'teammate')
  const job = role.trim() || (locale === 'zh-CN' ? '\u4f60\u7684\u804c\u8d23' : 'your role')
  const lane = scope?.trim()
  if (locale === 'zh-CN') {
    return `\u4f60\u662f ${who}\uff0c\u804c\u8d23\u662f ${job}${lane ? `\uff0c\u4e13\u6ce8\u4e8e ${lane}` : ''}\u3002\u4f60\u7684\u804c\u8d23\u662f\u4e3b\u8981\u5206\u5de5\uff1b\u6709\u4e8b\u5b9e\u4f9d\u636e\u4e14\u53ef\u80fd\u5f71\u54cd\u51b3\u7b56\u65f6\uff0c\u53ef\u5bf9\u4efb\u4f55\u65b9\u6848\u63d0\u51fa\u5efa\u8bbe\u6027\u8d28\u7591\uff0c\u4e0d\u4e3a\u53cd\u5bf9\u800c\u53cd\u5bf9\u3002\u8868\u8fbe\u6e05\u6670\u3001\u52a1\u5b9e\u5e76\u8bda\u5b9e\uff1b\u91cd\u8981\u9700\u6c42\u4e0d\u6e05\u695a\u65f6\u5148\u8be2\u95ee\u3002`
  }
  return `You are ${who}, responsible for ${job}${lane ? `, with a focus on ${lane}` : ''}. Your role is your primary lane; raise constructive, fact-based concerns about any plan when they could change the decision, and do not object just to object. Be clear, practical, and candid. Ask when important requirements are unclear.`
}

export function profileIssue(draft: Agent, agents: Agent[], existingId: string | null): ProfileIssue | null {
  if (!draft.name.trim()) return 'name-required'
  if (!draft.role.trim()) return 'role-required'
  if (!draft.model.trim()) return 'model-required'
  const normalized = draft.name.trim().toLocaleLowerCase()
  if (agents.some((agent) => agent.id !== existingId && agent.name.trim().toLocaleLowerCase() === normalized)) return 'name-taken'
  return null
}

export function profileIssueText(issue: ProfileIssue, locale: UiLocale): string {
  const en: Record<ProfileIssue, string> = {
    'name-required': 'Enter a name.',
    'role-required': 'Enter a role.',
    'model-required': 'Choose or enter a model ID.',
    'name-taken': 'An employee already has this name. Choose a different name.',
  }
  const zh: Record<ProfileIssue, string> = {
    'name-required': '\u8bf7\u586b\u5199\u59d3\u540d\u3002',
    'role-required': '\u8bf7\u586b\u5199\u804c\u8d23\u3002',
    'model-required': '\u8bf7\u9009\u62e9\u6216\u8f93\u5165\u6a21\u578b ID\u3002',
    'name-taken': '\u5df2\u6709\u540c\u540d\u5458\u5de5\uff0c\u8bf7\u66f4\u6362\u59d3\u540d\u3002',
  }
  return (locale === 'zh-CN' ? zh : en)[issue]
}

export function profileSaveFailure(locale: UiLocale): string {
  return locale === 'zh-CN' ? '\u4fdd\u5b58\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5de5\u4f5c\u533a\u670d\u52a1\u5668\u540e\u91cd\u8bd5\u3002' : 'Could not save this employee. Check the office connection and try again.'
}

export function agentIdFor(name: string, agents: Agent[], randomId: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || `agent-${randomId}`
  const used = new Set(agents.map((agent) => agent.id))
  if (!used.has(base)) return base
  let suffix = 2
  while (used.has(`${base}-${suffix}`)) suffix++
  return `${base}-${suffix}`
}

export function prepareAgentForSave(draft: Agent, agents: Agent[], existingId: string | null, locale: UiLocale, randomId: string): { agent: Agent; issue: null } | { agent: null; issue: ProfileIssue } {
  const issue = profileIssue(draft, agents, existingId)
  if (issue) return { agent: null, issue }
  const name = draft.name.trim().toUpperCase()
  const role = draft.role.trim().toUpperCase()
  const agent: Agent = {
    ...draft,
    name,
    role,
    // Custom prompts remain byte-for-byte intact; blank prompts get a useful, visible default.
    personality: draft.personality.trim() ? draft.personality : defaultPersonality(name, role, draft.scope, locale),
  }
  if (!existingId) agent.id = agentIdFor(name, agents, randomId)
  return { agent, issue: null }
}
