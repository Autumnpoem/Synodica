/** HTTP origin of a provider endpoint; an empty Claude endpoint selects its official host. */
export function claudeEndpointOrigin(baseUrl: string | undefined): string | undefined {
  try {
    const url = new URL(baseUrl || 'https://api.anthropic.com')
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined
  } catch { return undefined }
}
