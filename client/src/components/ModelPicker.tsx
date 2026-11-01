import { useEffect, useRef, useState } from 'react'
import type { ProviderDef, ProviderModelCatalog } from '../../../shared/types'
import { getLocale } from '../i18n'
import { modelChoices, modelPickerText, initialCatalogModel } from '../modelPicker'
import { providerModels } from '../api'

interface ModelPickerProps {
  id: string
  providerId: string
  provider: ProviderDef
  model: string
  onChange: (model: string) => void
  initializeEmpty?: boolean
  initialCatalog?: ProviderModelCatalog | null
  required?: boolean
}

export function ModelPicker({ id, providerId, provider, model, onChange, initializeEmpty = false, initialCatalog = null, required = false }: ModelPickerProps) {
  const locale = getLocale()
  const [catalog, setCatalog] = useState<ProviderModelCatalog | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [custom, setCustom] = useState(false)
  const [cooldown, setCooldown] = useState(false)
  const requestId = useRef(0)
  const userTouched = useRef(false)
  const initialized = useRef(false)
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const sequence = ++requestId.current
    setCatalog(null)
    setLoading(!initialCatalog || initialCatalog.provider !== providerId)
    setLoadFailed(false)
    setCustom(false)
    userTouched.current = false
    initialized.current = false
    if (initialCatalog?.provider === providerId) {
      setCatalog(initialCatalog)
      return () => { requestId.current++ }
    }
    void providerModels(providerId).then((result) => {
      if (requestId.current !== sequence) return
      setCatalog(result)
    }).catch(() => {
      if (requestId.current !== sequence) return
      setLoadFailed(true)
    }).finally(() => {
      if (requestId.current === sequence) setLoading(false)
    })
  return () => { requestId.current++ }
  }, [providerId])

  useEffect(() => {
    if (!catalog || !initializeEmpty || model || userTouched.current || initialized.current) return
    const initial = initialCatalogModel(catalog, provider)
    initialized.current = true
    if (initial) onChange(initial)
  }, [catalog, initializeEmpty, model, onChange, provider])

  useEffect(() => () => {
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current)
  }, [])

  const choices = modelChoices(model, provider, catalog)
  const savedValue = model && !choices.some((choice) => choice.id === model) ? '__saved__' : model
  const status = catalog?.source === 'upstream' ? 'sourceUpstream'
    : catalog?.source === 'cli' ? 'sourceCli'
      : catalog?.source === 'configured' ? 'sourceConfigured'
        : catalog?.source === 'unavailable' ? 'sourceUnavailable' : null
  const errorMessage = catalog?.error === 'missing-credential' ? 'errorMissingCredential'
    : catalog?.error === 'unsupported' ? 'errorUnsupported'
      : catalog?.error === 'unavailable' ? 'errorUnavailable'
        : loadFailed ? 'errorGeneric' : null

  const load = async (force: boolean) => {
    const sequence = ++requestId.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const result = await providerModels(providerId, force)
      if (requestId.current === sequence) setCatalog(result)
    } catch {
      if (requestId.current === sequence) setLoadFailed(true)
    } finally {
      if (requestId.current === sequence) setLoading(false)
    }
  }

  const refresh = () => {
    if (cooldown || loading) return
    setCooldown(true)
    cooldownTimer.current = setTimeout(() => setCooldown(false), 30_000)
    void load(true)
  }

  return (
    <div className="model-picker" style={{ display: 'grid', minWidth: 0, gap: 6 }}>
      <div className="model-picker-controls" style={{ display: 'flex', minWidth: 0, alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <select id={id} required={required} aria-required={required || undefined} style={{ flex: '1 1 220px', minWidth: 0 }} value={custom ? '__custom__' : savedValue === '' ? '__choose__' : savedValue === model ? model : '__saved__'} onChange={(event) => {
          const selected = event.target.value
          userTouched.current = true
          if (selected === '__custom__') {
            setCustom(true)
            return
          }
          setCustom(false)
          if (selected === '__choose__') {
            onChange('')
            return
          }
          if (selected === '__saved__') return
          onChange(selected)
        }}>
          <option value="__choose__">{modelPickerText(locale, 'choose')}</option>
          {choices.some((choice) => choice.source === 'upstream') && <optgroup label={modelPickerText(locale, 'upstreamGroup')}>
            {choices.filter((choice) => choice.source === 'upstream').map((choice) => <option key={`up-${choice.id}`} value={choice.id} title={choice.description}>{choice.label}</option>)}
          </optgroup>}
          {choices.some((choice) => choice.source === 'default') && <optgroup label={modelPickerText(locale, catalog?.source === 'cli' ? 'defaultGroupCli' : 'defaultGroup')}>
            {choices.filter((choice) => choice.source === 'default').map((choice) => <option key={`default-${choice.id}`} value={choice.id}>{modelPickerText(locale, catalog?.source === 'cli' ? 'defaultChoiceCli' : 'defaultChoice')}</option>)}
          </optgroup>}
          {choices.some((choice) => choice.source === 'configured' || choice.source === 'saved') && <optgroup label={modelPickerText(locale, 'configuredGroup')}>
            {choices.filter((choice) => choice.source === 'configured' || choice.source === 'saved').map((choice) => <option key={`configured-${choice.id}`} value={choice.id}>{choice.label}{choice.source === 'saved' ? ` · ${modelPickerText(locale, 'saved')}` : ''}</option>)}
          </optgroup>}
          {savedValue === '__saved__' && <option value="__saved__">{model} · {modelPickerText(locale, 'saved')}</option>}
          <option value="__custom__">{modelPickerText(locale, 'custom')}</option>
        </select>
        <button type="button" className="btn btn-small" disabled={loading || cooldown} onClick={refresh} title={cooldown ? modelPickerText(locale, 'cooldown') : modelPickerText(locale, 'refresh')}>
          {loading ? modelPickerText(locale, 'refreshing') : modelPickerText(locale, 'refresh')}
        </button>
      </div>
      {custom && <input style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} aria-label={locale === 'zh-CN' ? '\u81ea\u5b9a\u4e49\u6a21\u578b ID' : 'Custom model ID'} value={model} onChange={(event) => {
        userTouched.current = true
        onChange(event.target.value)
      }} placeholder={locale === 'zh-CN' ? '\u4efb\u610f\u6a21\u578b ID' : 'Any model ID'} />}
      <small className="model-picker-note" style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.5 }}>{loading && !catalog ? modelPickerText(locale, 'loading') : status ? modelPickerText(locale, status) : modelPickerText(locale, 'availability')}</small>
      {errorMessage && <small className="model-picker-error" role="status" style={{ display: 'block', whiteSpace: 'normal', lineHeight: 1.5, color: 'var(--warning)' }}>{modelPickerText(locale, errorMessage)}</small>}
      {custom && <small className="model-picker-note">{modelPickerText(locale, 'customHint')}</small>}
    </div>
  )
}
