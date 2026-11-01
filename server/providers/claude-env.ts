import type { ProviderDef } from '../../shared/types.js'

/** Per-provider child environment. Never writes Claude's login, settings or the parent environment. */
export function claudeEnv(provider: ProviderDef, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const gateway = Boolean(provider.baseUrl && new URL(provider.baseUrl).origin !== 'https://api.anthropic.com')
  if (gateway && !provider.apiKey) throw new Error('Set an explicit gateway credential before using this Claude gateway')
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && key !== 'ANTHROPIC_API_KEY' && key !== 'ANTHROPIC_AUTH_TOKEN' && !(gateway && key === 'CLAUDE_CODE_OAUTH_TOKEN')) env[key] = value
  }
  if (provider.apiKey) env[provider.authMode === 'auth-token' ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = provider.apiKey
  if (provider.baseUrl) env.ANTHROPIC_BASE_URL = provider.baseUrl
  return env
}
