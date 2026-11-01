import type { Agent, Conversation } from '../../shared/types.js'
import { findMentions } from '../../shared/mentions.js'

/** Resolve the one employee affected by a chat correction. Project corrections remain global. */
export function selectCorrectionTarget(text: string, replyAuthorId: string | undefined, conversation: Conversation, agents: Agent[]): Agent | undefined {
  if (conversation.projectId) return undefined
  if (/(^|[^a-z0-9_])@everyone(?![a-z0-9_])/i.test(text)) return undefined

  const mentioned = findMentions(text, agents)
  if (mentioned.length > 1 || mentioned.some((agent) => !conversation.memberIds.includes(agent.id))) return undefined
  if (mentioned.length === 1) return mentioned[0]

  return agents.find((agent) => agent.id === replyAuthorId && conversation.memberIds.includes(agent.id))
}
