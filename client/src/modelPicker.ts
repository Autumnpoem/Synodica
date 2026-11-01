import type { ProviderModelCatalog, ProviderDef } from '../../shared/types'

export type UiLocale = 'en' | 'zh-CN'

export interface ModelChoice {
  id: string
  label: string
  source: 'upstream' | 'configured' | 'saved' | 'default'
  description?: string
}

/** Keep the selected model visible even when a refreshed list no longer contains it. */
export function modelChoices(model: string, provider: ProviderDef, catalog: ProviderModelCatalog | null): ModelChoice[] {
  const upstream = catalog?.models ?? []
  const listedSource = catalog?.source === 'upstream' || catalog?.source === 'cli' ? 'upstream' : 'configured'
  const upstreamIds = new Set(upstream.map((item) => item.id))
  const choices: ModelChoice[] = upstream.map((item) => ({ id: item.id, label: item.label || item.id, source: listedSource, description: item.description }))

  if (catalog?.supportsDefault && !upstreamIds.has('default')) {
    choices.unshift({ id: 'default', label: 'default', source: 'default' })
  }
  for (const id of provider.models ?? []) {
    if (!upstreamIds.has(id) && !(catalog?.supportsDefault && id === 'default')) choices.push({ id, label: id, source: 'configured' })
  }
  if (model && !choices.some((item) => item.id === model)) {
    choices.push({ id: model, label: model, source: 'saved' })
  }
  return choices
}

/** Explicit provider changes never silently carry an ID from an unrelated provider. */
export function modelForProviderSwitch(next: ProviderDef, currentModel: string, catalog: ProviderModelCatalog | null): string {
  if (currentModel && (next.models?.includes(currentModel) || catalog?.models.some((item) => item.id === currentModel))) return currentModel
  if (catalog?.supportsDefault) return 'default'
  return next.kind === 'openai' ? next.models?.[0] ?? '' : ''
}

/** Pick a safe initial value for a new profile or an explicitly changed provider. */
export function initialCatalogModel(catalog: ProviderModelCatalog, provider: ProviderDef): string {
  if (catalog.supportsDefault) return 'default'
  return provider.kind === 'openai' ? provider.models?.[0] ?? '' : ''
}

export type PickerMessage =
  | 'loading' | 'refresh' | 'refreshing' | 'choose' | 'custom' | 'saved'
  | 'upstreamGroup' | 'configuredGroup' | 'defaultGroup' | 'defaultGroupCli' | 'defaultChoice' | 'defaultChoiceCli' | 'availability'
  | 'sourceUpstream' | 'sourceCli' | 'sourceConfigured' | 'sourceUnavailable'
  | 'errorMissingCredential' | 'errorUnavailable' | 'errorUnsupported' | 'errorGeneric'
  | 'customHint' | 'cooldown'

const EN: Record<PickerMessage, string> = {
  loading: 'Loading model list…',
  refresh: 'Refresh list',
  refreshing: 'Refreshing…',
  choose: 'Choose a model',
  custom: 'Custom model…',
  saved: 'Saved model · not in the latest list',
  upstreamGroup: 'Reported by provider or CLI',
  configuredGroup: 'Configured locally · not verified upstream',
  defaultGroup: 'Provider-configured default',
  defaultGroupCli: 'CLI configured default',
  defaultChoice: 'Use this provider’s configured default (default is not a model name)',
  defaultChoiceCli: 'Use current CLI default (default is not a model name)',
  availability: 'For API providers, choose a concrete model ID. A listed model does not prove your account has access to it.',
  sourceUpstream: 'List received from the provider. Account access is not verified.',
  sourceCli: 'List received from the installed CLI. Account access is not verified.',
  sourceConfigured: 'Showing local presets or configured model IDs; not verified with upstream.',
  sourceUnavailable: 'A live model list is unavailable. Existing and custom model IDs can still be used.',
  errorMissingCredential: 'This provider needs an API credential before its model list can be refreshed. Custom IDs remain allowed.',
  errorUnavailable: 'The provider model list is unavailable right now. Existing and custom IDs remain allowed.',
  errorUnsupported: 'This connection or CLI did not return a readable model catalog right now. Choose a preset or enter any model ID.',
  errorGeneric: 'Could not load the model list. Existing and custom IDs remain allowed.',
  customHint: 'Enter any model ID. The value is saved as entered.',
  cooldown: 'Refresh is available again in 30 seconds.',
}

const ZH: Record<PickerMessage, string> = {
  loading: '\u6b63\u5728\u52a0\u8f7d\u6a21\u578b\u5217\u8868\u2026',
  refresh: '\u5237\u65b0\u5217\u8868',
  refreshing: '\u6b63\u5728\u5237\u65b0\u2026',
  choose: '\u9009\u62e9\u6a21\u578b',
  custom: '\u81ea\u5b9a\u4e49\u6a21\u578b\u2026',
  saved: '\u5df2\u4fdd\u5b58\u7684\u6a21\u578b\u00b7\u4e0d\u5728\u6700\u65b0\u5217\u8868\u4e2d',
  upstreamGroup: '\u4f9b\u5e94\u5546\u6216 CLI \u8fd4\u56de\u7684\u5217\u8868',
  configuredGroup: '\u672c\u5730\u5df2\u914d\u7f6e\u00b7\u672a\u5411\u4e0a\u6e38\u6838\u5b9e',
  defaultGroup: '\u4f9b\u5e94\u5546\u914d\u7f6e\u7684\u9ed8\u8ba4\u9879',
  defaultGroupCli: 'CLI \u5f53\u524d\u914d\u7f6e\u7684\u9ed8\u8ba4\u503c',
  defaultChoice: '\u4f7f\u7528\u6b64\u4f9b\u5e94\u5546\u914d\u7f6e\u7684\u9ed8\u8ba4\u9879\uff08default \u4e0d\u662f\u5177\u4f53\u6a21\u578b\u540d\uff09',
  defaultChoiceCli: '\u4f7f\u7528\u5f53\u524d CLI \u914d\u7f6e\u7684\u9ed8\u8ba4\u9879\uff08default \u4e0d\u662f\u5177\u4f53\u6a21\u578b\u540d\uff09',
  availability: 'API \u4f9b\u5e94\u5546\u8bf7\u9009\u62e9\u5177\u4f53\u6a21\u578b ID\u3002\u5217\u8868\u4e2d\u51fa\u73b0\u67d0\u4e2a\u6a21\u578b\uff0c\u4e0d\u4ee3\u8868\u4f60\u7684\u8d26\u6237\u4e00\u5b9a\u6709\u6743\u9650\u4f7f\u7528\u5b83\u3002',
  sourceUpstream: '\u6a21\u578b\u5217\u8868\u6765\u81ea\u4f9b\u5e94\u5546\uff1b\u672a\u6838\u5b9e\u8d26\u6237\u6743\u9650\u3002',
  sourceCli: '\u6a21\u578b\u5217\u8868\u6765\u81ea\u5df2\u5b89\u88c5\u7684 CLI\uff1b\u672a\u6838\u5b9e\u8d26\u6237\u6743\u9650\u3002',
  sourceConfigured: '\u663e\u793a\u672c\u5730\u9884\u8bbe\u6216\u5df2\u914d\u7f6e\u7684\u6a21\u578b ID\uff1b\u672a\u4ece\u4e0a\u6e38\u6838\u5b9e\u3002',
  sourceUnavailable: '\u65e0\u6cd5\u83b7\u53d6\u5b9e\u65f6\u6a21\u578b\u5217\u8868\uff1b\u4ecd\u53ef\u4f7f\u7528\u5df2\u6709\u6216\u81ea\u5b9a\u4e49\u7684\u6a21\u578b ID\u3002',
  errorMissingCredential: '\u6b64\u4f9b\u5e94\u5546\u9700\u8981 API \u51ed\u636e\u624d\u80fd\u5237\u65b0\u6a21\u578b\u5217\u8868\uff1b\u4ecd\u53ef\u81ea\u5b9a\u4e49\u6a21\u578b ID\u3002',
  errorUnavailable: '\u76ee\u524d\u65e0\u6cd5\u83b7\u53d6\u4f9b\u5e94\u5546\u6a21\u578b\u5217\u8868\uff1b\u4ecd\u53ef\u4f7f\u7528\u5df2\u6709\u6216\u81ea\u5b9a\u4e49 ID\u3002',
  errorUnsupported: '\u5f53\u524d\u8fde\u63a5\u6216 CLI \u6ca1\u6709\u8fd4\u56de\u53ef\u8bfb\u53d6\u7684\u6a21\u578b\u76ee\u5f55\u3002\u53ef\u9009\u62e9\u672c\u5730\u9884\u8bbe\u6216\u624b\u52a8\u8f93\u5165\u4efb\u610f\u6a21\u578b ID\u3002',
  errorGeneric: '\u65e0\u6cd5\u52a0\u8f7d\u6a21\u578b\u5217\u8868\uff1b\u4ecd\u53ef\u4f7f\u7528\u5df2\u6709\u6216\u81ea\u5b9a\u4e49 ID\u3002',
  customHint: '\u53ef\u8f93\u5165\u4efb\u610f\u6a21\u578b ID\uff0c\u5e76\u4fdd\u6301\u8f93\u5165\u5185\u5bb9\u3002',
  cooldown: '\u8bf7\u7b49\u5f85 30 \u79d2\u540e\u518d\u5237\u65b0\u3002',
}

export function modelPickerText(locale: UiLocale, key: PickerMessage): string {
  return (locale === 'zh-CN' ? ZH : EN)[key]
}
