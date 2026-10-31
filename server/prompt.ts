import type { Agent, Conversation, Team } from '../shared/types.js'

export const SKIP_TOKEN = '[skip]'

/** What an employee can physically do, in words colleagues and the router understand. */
export function capability(agent: Agent): string {
  const t = agent.tools
  if (t.some((x) => ['Edit', 'Write'].includes(x))) return 'builds files and code'
  if (t.includes('Bash')) return 'runs commands'
  if (t.some((x) => ['Read', 'Glob', 'Grep'].includes(x))) return 'reads code'
  if (t.some((x) => ['WebSearch', 'WebFetch'].includes(x))) return 'researches online'
  return 'chat only'
}

function roster(team: Team, conversation: Conversation, self: Agent): string {
  const lines = conversation.memberIds.map((id) => {
    if (id === 'user') return `- ${team.owner.name} (${team.owner.title}, the boss)`
    const a = team.agents.find((x) => x.id === id)
    if (!a) return null
    const scope = a.scope ? ` — owns: ${a.scope}` : ''
    return `- ${a.name} (${a.role}; ${capability(a)})${scope}${a.id === self.id ? ' ← this is you' : ''}`
  })
  return lines.filter((l): l is string => l !== null).join('\n')
}

/** Exported for tests. Any language other than auto/ar/en is followed as written (e.g. "zh-CN", "Spanish"). */
export function languageRule(team: Team): string {
  const lang = team.settings.language
  switch (lang) {
    case 'auto':
      return `- Language: answer in the language ${team.owner.name} writes in. If they write Arabic, write natural colloquial Egyptian Arabic (not formal Modern Standard Arabic). Keep technical terms, product names and code in English. Colleagues follow the same rule.`
    case 'ar':
      return `- Language: always write natural colloquial Egyptian Arabic (not formal Modern Standard Arabic). Keep technical terms, product names and code in English.`
    case 'en':
      return `- Language: always write English, even if ${team.owner.name} writes another language.`
    default:
      return `- Language: always write in the language "${lang}" (a language name or BCP-47 tag), even if a colleague writes another language. Keep code, identifiers, file names, commands and workflow JSON keys unchanged.`
  }
}

/** Describes the tools an employee has, in provider-neutral words. */
export function toolsNote(agent: Agent, extra = ''): string {
  const hasWorkTools = agent.tools.some((t) => ['Edit', 'Write', 'Bash'].includes(t))
  if (hasWorkTools) {
    return `\nYou have real tools (${agent.tools.join(', ')}) and a working directory.${extra} When the boss or a colleague asks for something small and clear that can be made (a file, a page, a script, a fix), make it with your tools, then reply with the full path of what you created and one or two sentences about it, mentioning any assumption in one clause. For a multi-part project or a request with real trade-offs, do not start building in chat: say so in one line and suggest a project kickoff (plan, critique, tasks). Never claim you changed, ran or verified something you did not.`
  }
  if (agent.tools.length > 0 || extra) {
    return `\nYou have read-only tools (${agent.tools.join(', ') || 'none built in'}).${extra} Use them when a question needs facts from the code, the web or a connected service, then answer in the chat. You cannot create files: if something needs building, hand it in one line to a colleague listed as "builds files and code".`
  }
  return `\nYou have no tools. You cannot create files or look things up: if something needs building or checking, hand it in one line to the colleague who can.`
}

export function buildSystemPrompt(team: Team, conversation: Conversation, agent: Agent, extraToolsNote = '', notes = '', context = ''): string {
  const project = context.trim() ? `\n\nProject context (shared by the whole team; the task board is the source of truth for who does what):\n${context.trim()}` : ''
  const place = conversation.kind === 'group' ? `the "${conversation.name}" group chat` : `a private direct-message chat with ${team.owner.name}`
  const other = team.agents.find((a) => a.id !== agent.id)?.name ?? 'NAME'
  const boss = team.owner.name.split(/\s+/)[0] ?? team.owner.name
  const lane = agent.scope ? `\n- Your lane: ${agent.scope}. This is your primary responsibility, not a limit on what you may question. Outside it, speak only to raise a concrete, material objection with a reason or evidence that would change the decision; otherwise reply exactly ${SKIP_TOKEN}. If it needs a colleague, one line handing it to them with @NAME.` : ''
  const memory = notes.trim() ? `\n\nYour long-term notes (facts and preferences you learned earlier; trust the conversation over them when they conflict):\n${notes.trim()}` : ''
  return `${agent.personality}${memory}

You work at ${team.company}. You are chatting in ${place}. Members:
${roster(team, conversation, agent)}

Chat protocol:
- The user turn you receive is a transcript of the messages posted since you last spoke, each prefixed with the author's name in brackets. Reply as ${agent.name}, in first person, with the text of ONE chat message only. No name prefix, no quotes around it, no headers.
- Be brief: one to four sentences, one point. Lists only when the boss asks for a list or a plan. Nobody wants ten paragraphs in a chat.
- Add only what is new. Never restate, summarize or agree with what a colleague already said. If you have nothing new, reply exactly ${SKIP_TOKEN}.
- Ask the boss at most one question, only if you truly cannot proceed. Never repeat a question he has not answered; assume something sensible and move on.${lane}
- To address a colleague, mention them exactly as @NAME using their name as listed above (for example @${other}). Mentioning a colleague asks them to respond, so mention only when you want their input or are handing something to them. To address the boss, write @${boss}.
- Disagree when you disagree, in one sentence with the reason or evidence; never agree or object just to be seen.
${languageRule(team)}
- If the latest messages need nothing from you (they were addressed to someone else, or a colleague already covered it), reply with exactly ${SKIP_TOKEN} and nothing else.
- Markdown is fine for code blocks and short lists. Never wrap your whole message in a code block.
- To send a file to the chat (a page you built, a screenshot, a document, a spreadsheet, a PDF, code), write its full absolute path on its own line; the chat attaches it automatically with a preview, so say "attached" rather than "I can't upload". Always do this for anything you created or that the boss should look at.
- Lines from "Workflow" are the project board reporting task changes; they are facts, not requests to you.${toolsNote(agent, extraToolsNote)}${project}`
}

function lastIndexOfOwnMessage(conversation: Conversation, agentId: string): number {
  for (let i = conversation.messages.length - 1; i >= 0; i--) {
    const m = conversation.messages[i]
    if (m && m.authorId === agentId && m.status === 'done') return i
  }
  return -1
}

/**
 * The transcript an employee sees for this turn.
 * With a resumable session: only what was said since they last spoke (their memory has the rest).
 * Without one: the recent transcript including their own earlier messages, marked "(you)".
 * `note` is an optional dispatcher instruction appended to the turn.
 */
export function buildTurnPrompt(team: Team, conversation: Conversation, agent: Agent, hasSession: boolean, note?: string): string {
  const names = new Map<string, string>([['user', team.owner.name], ['workflow', 'Workflow']])
  for (const a of team.agents) names.set(a.id, a.name)
  const since = hasSession ? lastIndexOfOwnMessage(conversation, agent.id) : -1
  const fresh = conversation.messages
    .slice(since + 1)
    .filter((m) => m.status === 'done' && m.text.trim().length > 0 && (hasSession ? m.authorId !== agent.id : true))
  const window = fresh.slice(-40)
  const skipped = fresh.length - window.length
  const lines = window.map((m) => {
    const who = m.authorId === 'routine' ? 'Routine' : (names.get(m.authorId) ?? m.authorId)
    const quote = m.replyTo ? `(replying to ${names.get(m.replyTo.authorId) ?? m.replyTo.authorId}: "${m.replyTo.excerpt}") ` : ''
    const files = m.attachments?.length ? `\n(attached files: ${m.attachments.map((a) => a.path).join(', ')} — read them with your tools)` : ''
    return `[${who}${m.authorId === agent.id ? ' (you)' : ''}]: ${quote}${m.text}${files}`
  })
  const head = skipped > 0 ? `(${skipped} earlier messages omitted)\n` : ''
  const tail = note ? `\n\n(${note})` : ''
  return `${head}${lines.join('\n\n')}${tail}\n\n(Reply now as ${agent.name}.)`
}

export function stripSkip(text: string): string {
  const t = text.trim()
  return t === SKIP_TOKEN ? '' : t
}
