// User-facing catalog text in the UI locale. The English catalog (shared/catalog.ts, shared/templates.ts,
// shared/marketplace.ts) stays the source of ids and English wording; tests keep the English resource
// identical to it. Ids, model ids, tool names, commands and URLs are never translated.
import { API_PRESETS, PROVIDER_CAPABILITIES } from './catalog.js'
import { EN, translate, type Locale, type MessageKey } from './i18n.js'
import type { ProviderKind } from './types.js'

/** Localized text for a catalog key, or the catalog's own English when the key does not exist. */
export function catalogText(locale: Locale, key: string, fallback: string): string {
  return key in EN ? translate(locale, key as MessageKey) : fallback
}

export const toolHint = (locale: Locale, t: { id: string; hint: string }) => catalogText(locale, `catalog.tool.${t.id}`, t.hint)
/** Tool names that are identifiers (Read, Bash...) stay literal; descriptive labels are localized. */
export const toolLabel = (locale: Locale, t: { id: string; label: string }) => catalogText(locale, `catalog.toolLabel.${t.id}`, t.label)
export const permissionLabel = (locale: Locale, p: { id: string; label: string }) => catalogText(locale, `catalog.perm.${p.id}`, p.label)
export const permissionHint = (locale: Locale, p: { id: string; hint: string }) => catalogText(locale, `catalog.permHint.${p.id}`, p.hint)
export const effortLabel = (locale: Locale, e: { id: string; label: string }) => catalogText(locale, `catalog.effort.${e.id}`, e.label)
export const providerKindHint = (locale: Locale, k: { id: string; hint: string }) => catalogText(locale, `catalog.kindHint.${k.id}`, k.hint)
export const modelHint = (locale: Locale, m: { id: string; hint: string }) => catalogText(locale, `catalog.modelHint.${m.id}`, m.hint)
export const rateLimitLabel = (locale: Locale, type: string, label: string) => catalogText(locale, `catalog.rate.${type}`, label)
export const apiKeyHint = (locale: Locale, p: { id: string; keyHint: string }) => catalogText(locale, `catalog.keyHint.${p.id}`, p.keyHint)
export const apiPresetLabel = (locale: Locale, p: { id: string; label: string }) => catalogText(locale, `catalog.apiPreset.${p.id}`, p.label)
export const providerLabel = (locale: Locale, provider: { kind: ProviderKind; label: string; baseUrl?: string }) => {
  const defaultLabel = provider.kind === 'claude' && provider.label === 'Claude (subscription)'
    ? 'claudeSubscription'
    : provider.kind === 'codex' && provider.label === 'Codex (ChatGPT subscription)'
      ? 'codexSubscription'
      : provider.kind === 'gemini' && provider.label === 'Gemini (Google account)'
        ? 'geminiAccount'
        : undefined
  if (defaultLabel) return catalogText(locale, `catalog.defaultProvider.${defaultLabel}`, provider.label)
  const preset = API_PRESETS.find((p) => p.baseUrl === provider.baseUrl && p.label === provider.label)
  return preset ? apiPresetLabel(locale, preset) : provider.label
}
export const seatRationale = (locale: Locale, seat: { agent: { id: string }; why: string }) => catalogText(locale, `template.why.${seat.agent.id}`, seat.why)

export const capabilityNotes = (locale: Locale, kind: ProviderKind) => catalogText(locale, `cap.notes.${kind}`, PROVIDER_CAPABILITIES[kind].notes)

/** What an adapter can really do, as one line, so nobody assumes every provider behaves like Claude Code. */
export function capabilityLine(locale: Locale, kind: ProviderKind): string {
  const c = PROVIDER_CAPABILITIES[kind]
  const tr = (key: MessageKey, vars?: Record<string, string>) => translate(locale, key, vars)
  const scope = catalogText(locale, `cap.writeScope.${kind}`, c.writeScope)
  return `${[
    tr(c.tools === 'native' ? 'cap.native' : 'cap.local'),
    tr(c.sessions ? 'cap.sessions' : 'cap.stateless'),
    tr(c.inChatApprovals ? 'cap.approvals' : 'cap.noApprovals'),
    tr(c.mcp ? 'cap.mcp' : 'cap.noMcp'),
    tr(c.readOnlyReview ? 'cap.readOnly' : 'cap.noReadOnly'),
    tr(c.projectShell ? 'cap.shell' : 'cap.noShell'),
    tr('cap.writes', { scope }),
  ].join(' · ')}. ${capabilityNotes(locale, kind)}`
}
