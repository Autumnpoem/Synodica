import type { Agent } from './types.js'

/** Find @display-name mentions in their order of appearance. */
export function findMentions(text: string, agents: Agent[], exclude?: string): Agent[] {
  if (/(^|[^a-z0-9_])@everyone(?![a-z0-9_])/i.test(text)) return agents.filter((a) => a.id !== exclude)
  const found: { index: number; agent: Agent }[] = []
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length)
  const lower = text.toLowerCase()
  for (const agent of sorted) {
    if (agent.id === exclude) continue
    const needle = `@${agent.name.toLowerCase()}`
    let from = 0
    for (;;) {
      const i = lower.indexOf(needle, from)
      if (i === -1) break
      const after = lower[i + needle.length]
      if ((after === undefined || !/[a-z0-9_]/.test(after)) && !found.some((f) => f.agent.id === agent.id)) found.push({ index: i, agent })
      from = i + needle.length
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.agent)
}
