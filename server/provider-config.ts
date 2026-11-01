import { claudeEndpointOrigin } from '../shared/provider-origin.js'
import type { ProviderDef } from '../shared/types.js'
import { parseProvider, TeamError } from './team.js'

/** Resolve the UI's stored-secret marker at the provider update boundary. */
export function parseProviderUpdate(current: ProviderDef | undefined, body: Record<string, unknown>, id: string): ProviderDef {
  const apiKey = body.apiKey === '••••' ? current?.apiKey : body.apiKey
  const next = parseProvider({ ...(current ?? {}), ...body, apiKey }, id)
  if (next.kind === 'claude' && !claudeEndpointOrigin(next.baseUrl)) throw new TeamError('Claude endpoint must be a valid HTTP or HTTPS URL')
  if (next.kind === 'claude' && current) {
    const from = claudeEndpointOrigin(current.baseUrl)
    const to = claudeEndpointOrigin(next.baseUrl)
    if (from !== to && (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey === '••••')) {
      throw new TeamError('Enter a new credential when changing the Claude endpoint origin')
    }
  }
  return next
}
