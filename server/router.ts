import { oneShot } from './providers/oneshot.js'
import { capability } from './prompt.js'
import type { Agent, Conversation, ProviderDef, Team } from '../shared/types.js'

export type RouteMode = 'build' | 'answer' | 'discuss'

export interface Route {
  speakers: Agent[]
  mode: RouteMode
  /** Why the router chose them; logged. */
  why: string
  /** The owner explicitly invited every available member to contribute. */
  everyone?: boolean
}

/** Model-backed routing call. Injected in tests; defaults to a one-shot on the configured provider. */
export type RouteCall = (provider: ProviderDef, model: string, system: string, prompt: string, signal: AbortSignal, cwd: string) => Promise<string>

const defaultCall: RouteCall = (provider, model, system, prompt, signal, cwd) => oneShot({ provider, model, system, prompt, signal, cwd })

function memberLines(team: Team, members: Agent[]): string {
  return members
    .map((a) => `- id=${a.id} · ${a.name} (${a.role}) · ${capability(a)}${a.scope ? ` · owns: ${a.scope}` : ''}${a.muted ? ' · muted (only if clearly for them)' : ''}`)
    .join('\n')
}

function manager(members: Agent[]): Agent | undefined {
  return members.find((a) => !a.muted && a.workflowRoles?.includes('lead')) ?? members.find((a) => !a.muted) ?? members[0]
}

function systemPrompt(team: Team, members: Agent[]): string {
  const lead = manager(members)
  return `You are the dispatcher of ${team.company}'s group chat. The boss (${team.owner.name}) just posted. Decide which employees should respond, and reply with JSON only:
{"speakers":["id", ...],"mode":"build"|"answer"|"discuss","why":"short reason","everyone":false}

Employees:
${memberLines(team, members)}

Rules:
- One speaker is the norm. Two when the message clearly spans two domains. Three at most unless the boss explicitly asks everyone to contribute.
- "build": the boss wants something small made, written, fixed or shown (a file, page, section, code, document, script, query). Pick exactly ONE employee who "builds files and code" and whose domain fits. If nobody can build, pick the manager.
- "answer": a question or request inside one domain. Pick that domain's owner.
- "discuss": broad strategy, priorities, a multi-part project, a complaint, a greeting, or an unclear message. Pick the manager (${lead?.name ?? 'the first employee'}) only.
- If the boss is replying to a specific employee's question or continuing their thread, pick that employee.
- If the boss explicitly asks everyone, everybody, the whole team or each person to weigh in, discuss, share opinions or raise objections, set "everyone": true. The dispatcher will invite every unmuted member; do not limit the list to three.
- Ignore @mentions; they are handled elsewhere.`
}

function context(team: Team, conversation: Conversation): string {
  const names = new Map<string, string>([['user', team.owner.name]])
  for (const a of team.agents) names.set(a.id, a.name)
  const recent = conversation.messages.filter((m) => m.status === 'done' && m.text.trim()).slice(-7)
  return recent.map((m) => `[${names.get(m.authorId) ?? m.authorId}]: ${m.text.replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')
}

function parse(text: string, members: Agent[]): { ids: string[]; mode: RouteMode; why: string; everyone: boolean } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const j = JSON.parse(m[0]) as { speakers?: unknown; mode?: unknown; why?: unknown; everyone?: unknown }
    const ids = Array.isArray(j.speakers) ? j.speakers.filter((s): s is string => typeof s === 'string') : []
    const known = ids.map((id) => members.find((a) => a.id === id || a.name.toLowerCase() === id.toLowerCase())?.id).filter((id): id is string => id !== undefined)
    const mode: RouteMode = j.mode === 'build' || j.mode === 'answer' ? j.mode : 'discuss'
    const everyone = j.everyone === true
    return { ids: [...new Set(known)].slice(0, everyone ? members.length : 3), mode, why: typeof j.why === 'string' ? j.why : '', everyone }
  } catch {
    return null
  }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'you', 'can', 'please', 'our', 'are', 'what', 'how', 'why', 'who', 'not', 'all', 'any', 'from', 'into', 'about', 'have', 'has', 'was', 'will', 'should', 'would', 'could', 'need', 'want', 'make', 'some', 'there', 'their', 'them', 'they', 'also', 'just', 'then', 'than', 'its', 'it', 'is', 'to', 'of', 'in', 'on', 'a', 'an'])
const BUILD = /\b(build|make|create|write|implement|fix|add|generate|code|draft|refactor|scaffold|set ?up|design)\b/i

/** A direct invitation to hear from the whole team, rather than a statement about everyone. */
export function explicitEveryone(text: string): boolean {
  const english = /\b(?:everyone|everybody|whole team|each (?:of you|person|member))\b.{0,40}\b(?:weigh in|discuss|think|thoughts?|opinions?|input|object|concerns?|say|share)\b|\b(?:thoughts?|opinions?|input)\b.{0,40}\b(?:everyone|everybody|whole team|each (?:of you|person|member))\b/i
  const chinese = /(?:\u5927\u5bb6|\u6240\u6709\u4eba|\u5168\u4f53|\u6bcf\u4e2a\u4eba|\u6bcf\u4f4d\u6210\u5458|\u6574\u4e2a\u56e2\u961f).{0,20}(?:\u53d1\u8868\u610f\u89c1|\u8bf4\u8bf4|\u8ba8\u8bba|\u770b\u6cd5|\u60f3\u6cd5|\u63d0\u610f\u89c1|\u63d0\u5efa\u8bae|\u63d0\u51fa\u5f02\u8bae|\u5404\u6292\u5df1\u89c1|\u53d1\u8a00)|(?:\u8bf7|\u8ba9).{0,8}(?:\u5927\u5bb6|\u6240\u6709\u4eba|\u5168\u4f53|\u6bcf\u4e2a\u4eba|\u6bcf\u4f4d\u6210\u5458|\u6574\u4e2a\u56e2\u961f).{0,20}(?:\u804a\u804a|\u8ba8\u8bba|\u8bf4\u8bf4|\u53d1\u8a00)/
  return english.test(text) || chinese.test(text)
}

/** A request for participants to respond to one another, not merely introduce their views. */
export function explicitDebate(text: string): boolean {
  if (/(?:停止|終止|终止|别|別|不要|无需|無需|不必)(?:再|继续|繼續)?(?:辩论|辯論|讨论|討論)|\b(?:do not|don't|dont|stop|no|avoid|without)\s+(?:(?:the|further)\s+)?(?:debate|debating|discuss|discussing|discussion)\b/i.test(text)) return false
  return /\b(?:debate|rebut|argue|discuss|discussion|challenge each other|respond to each other)\b|(?:辩论|辯論|讨论|討論|互相回应|互相回應|继续讨论|繼續討論)/i.test(text)
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 3 && !STOP.has(w))
}

function score(agent: Agent, tokens: string[]): number {
  const hay = new Set(words(`${agent.scope ?? ''} ${agent.role} ${agent.department ?? ''}`))
  let s = 0
  for (const t of tokens) {
    if (hay.has(t)) s += 2
    else if ([...hay].some((h) => h.length >= 4 && t.length >= 4 && (h.startsWith(t) || t.startsWith(h)))) s += 1
  }
  return s
}

const canBuild = (a: Agent): boolean => a.tools.some((t) => ['Edit', 'Write'].includes(t))

/**
 * Routing without any model: keyword overlap with each member's scope, role and department, plus
 * "continue the thread" and "build goes to a builder" rules. Used when no router model is configured,
 * and whenever the configured one fails. Exported for tests.
 */
export function deterministicRoute(team: Team, conversation: Conversation, userText: string): Route {
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  if (members.length <= 1) return { speakers: members, mode: 'answer', why: 'single member' }
  if (explicitEveryone(userText)) return { speakers: members.filter((a) => !a.muted), mode: 'discuss', why: 'explicit whole-team invitation', everyone: true }
  const lead = manager(members)
  // The boss answering an employee's question goes back to that employee.
  const prior = [...conversation.messages].reverse().find((m) => m.status === 'done' && m.authorId !== 'user' && m.authorId !== 'workflow' && m.text.trim())
  const lastUserIdx = conversation.messages.map((m) => m.authorId).lastIndexOf('user')
  const priorIdx = prior ? conversation.messages.indexOf(prior) : -1
  const asker = prior && priorIdx >= lastUserIdx - 1 && /\?\s*$/.test(prior.text.trim()) ? members.find((a) => a.id === prior.authorId) : undefined
  if (asker && !asker.muted) return { speakers: [asker], mode: 'answer', why: `continues ${asker.name}'s question` }
  const tokens = words(userText)
  const ranked = members
    .map((a) => ({ a, s: score(a, tokens) - (a.muted ? 1 : 0) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
  const build = BUILD.test(userText) && userText.length < 600
  if (build) {
    const builder = ranked.find((x) => canBuild(x.a))?.a ?? members.find((a) => canBuild(a) && !a.muted)
    if (builder) return { speakers: [builder], mode: 'build', why: 'build request → best-matching builder' }
  }
  const best = ranked[0]
  if (best) return { speakers: [best.a], mode: 'answer', why: `scope match (${best.s})` }
  return { speakers: lead ? [lead] : [], mode: 'discuss', why: 'no scope match → manager' }
}

/**
 * Picks who should reply to the boss's latest message in a group. Uses the configured helper
 * model (any provider) when there is one, otherwise deterministic routing; any failure falls back
 * to deterministic routing, never to a hidden provider.
 */
export async function routeSpeakers(team: Team, conversation: Conversation, userText: string, signal: AbortSignal, call: RouteCall = defaultCall): Promise<Route> {
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  if (members.length <= 1) return { speakers: members, mode: 'answer', why: 'single member' }
  if (explicitEveryone(userText)) return deterministicRoute(team, conversation, userText)
  const helper = team.settings.router
  const fallback = (why: string): Route => {
    const r = deterministicRoute(team, conversation, userText)
    return { ...r, why: `${why}; ${r.why}` }
  }
  if (!helper || helper.mode !== 'model') return fallback('deterministic router')
  const provider = team.providers[helper.provider]
  if (!provider) return fallback(`router provider "${helper.provider}" is not configured`)

  const abort = new AbortController()
  const onAbort = (): void => abort.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => abort.abort(), 25_000)
  let text = ''
  try {
    text = await call(provider, helper.model, systemPrompt(team, members), `Recent messages:\n${context(team, conversation)}\n\nLatest message from the boss:\n${userText}\n\nJSON:`, abort.signal, team.workspace)
  } catch (err) {
    return fallback(`router model failed (${err instanceof Error ? err.message : String(err)})`)
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
  const parsed = parse(text, members)
  if (!parsed || (!parsed.everyone && parsed.ids.length === 0)) return fallback('router reply unusable')
  const speakers = parsed.everyone ? members.filter((a) => !a.muted) : parsed.ids.map((id) => members.find((a) => a.id === id)).filter((a): a is Agent => a !== undefined)
  return { speakers, mode: parsed.mode, why: parsed.why, ...(parsed.everyone ? { everyone: true } : {}) }
}

export const __test = { parse, systemPrompt }
