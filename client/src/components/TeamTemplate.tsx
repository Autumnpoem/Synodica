import { useEffect, useState } from 'react'
import { PROVIDER_CAPABILITIES } from '../../../shared/catalog'
import { getTeamPreset, presetModel, presetProvider, TEAM_PRESET_IDS, type TeamPresetId } from '../../../shared/team-presets'
import { providerLabel } from '../../../shared/catalog-i18n'
import type { ProviderStatus, Team } from '../../../shared/types'
import { applyTeamTemplate, providerStatuses } from '../api'
import { getLocale, t } from '../i18n'

interface Props {
  team: Team
  onClose: () => void
  initialPreset?: TeamPresetId
  onApplied?: (ids: string[]) => void
}

type Assignment = { provider: string; model: string; skip: boolean }

/** Presets create saved members once; later use preserves their edited persona and model. */
export function TeamTemplate({ team, onClose, initialPreset = 'company', onApplied }: Props) {
  const [selected, setSelected] = useState<TeamPresetId>(initialPreset)
  const [statuses, setStatuses] = useState<ProviderStatus[] | null>(null)
  const [rows, setRows] = useState<Record<string, Assignment>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const preset = getTeamPreset(selected, getLocale())

  useEffect(() => {
    let active = true
    providerStatuses().catch(() => [] as ProviderStatus[]).then((s) => {
      if (!active) return
      const next: Record<string, Assignment> = {}
      for (const id of TEAM_PRESET_IDS) {
        for (const seat of getTeamPreset(id).seats) {
          const existing = team.agents.find((a) => a.templateSeat === seat.agent.id)
          const provider = existing?.provider ?? presetProvider(team, seat, s)
          next[seat.agent.id] = { provider, model: existing?.model ?? presetModel(team, provider, s), skip: false }
        }
      }
      setRows(next)
      setStatuses(s)
    })
    return () => { active = false }
    // Initialize once; incoming snapshots must not reset choices in this open dialog.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const set = (id: string, patch: Partial<Assignment>) => setRows((r) => ({ ...r, [id]: { ...r[id]!, ...patch } }))
  const chosen = preset.seats.flatMap((seat) => { const row = rows[seat.agent.id]; return row && !row.skip ? [row] : [] })
  const incomplete = chosen.some((row) => !row.provider || !row.model.trim())
  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await applyTeamTemplate(selected, rows, getLocale())
      onApplied?.(result.memberIds)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop nested team-preset-modal" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) { e.stopPropagation(); onClose() } }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); if (!busy) onClose() } }}>
      <div className="modal sheet sheet-wide" role="dialog" aria-modal="true" aria-label={t('template.title')}>
        <h2>{t('template.title')}</h2>
        <div className="team-preset-tabs" role="group" aria-label={t('template.choose')}>
          {TEAM_PRESET_IDS.map((id, i) => <button key={id} type="button" autoFocus={i === 0} className={`team-preset-tab${id === selected ? ' is-active' : ''}`} aria-pressed={id === selected} disabled={busy} onClick={() => { setSelected(id); setError(null) }}>
            <strong>{getTeamPreset(id, getLocale()).name}</strong>
            <span>{getTeamPreset(id, getLocale()).description}</span>
          </button>)}
        </div>
        <p className="lead">{t('template.lead')}</p>
        {error && <div className="form-error">{error}</div>}
        {!statuses && <p className="muted">{t('template.checking')}</p>}
        {statuses && preset.seats.map((seat) => {
          const row = rows[seat.agent.id]
          if (!row) return null
          const existing = team.agents.find((a) => a.templateSeat === seat.agent.id)
          const agent = existing ?? seat.agent
          const def = team.providers[row.provider]
          const status = statuses.find((s) => s.id === row.provider)
          return <section key={seat.agent.id} className={`seat${row.skip ? ' is-skipped' : ''}`}>
            <div className="seat-head">
              <span className="seat-dot" style={{ background: agent.color }} />
              <strong>{agent.name}</strong><span>{agent.role}</span>
              <label className="check seat-skip"><input type="checkbox" disabled={busy} checked={row.skip} onChange={(e) => set(seat.agent.id, { skip: e.target.checked })} />{t('template.skip')}</label>
            </div>
            <p className="hint">{agent.scope}</p>
            {existing && <p className="hint">{t('template.reuse')}</p>}
            {!row.skip && <>
              <div className="seat-row">
                <label className="field"><span>{t('profile.provider')}</span><select aria-label={`${agent.name} ${t('profile.provider')}`} value={row.provider} disabled={busy || !!existing} onChange={(e) => set(seat.agent.id, { provider: e.target.value, model: presetModel(team, e.target.value, statuses) })}>
                  <option value="">{t('template.chooseProvider')}</option>
                  {Object.entries(team.providers).map(([id, d]) => <option key={id} value={id}>{providerLabel(getLocale(), d)}</option>)}
                </select></label>
                <label className="field"><span>{t('profile.model')}</span><input aria-label={`${agent.name} ${t('profile.model')}`} disabled={busy || !!existing} value={row.model} onChange={(e) => set(seat.agent.id, { model: e.target.value })} placeholder={t('profile.modelPh')} className="mono" /></label>
              </div>
              <span className={status?.ok === false ? 'bad small' : status?.ok ? 'ok small' : 'muted small'}>{!row.provider ? t('template.missingProvider') : status ? (status.ok ? t('template.ready') : t('template.connectionNeeded')) : t('template.notChecked')}</span>
              {!row.model && <span className="bad small">{t('template.modelNeeded')}</span>}
              {def && agent.tools.includes('Bash') && PROVIDER_CAPABILITIES[def.kind].tools === 'local' && <div className="bad small">{t('template.noSandbox')}</div>}
              <details className="preset-prompt"><summary>{t('template.prompt')}</summary><p>{agent.personality}</p></details>
            </>}
          </section>
        })}
        <div className="actions">
          <button type="button" className="btn" disabled={busy} onClick={onClose}>{t('common.cancel')}</button>
          <button type="button" className="btn btn-primary" disabled={busy || !statuses || incomplete || chosen.length === 0} onClick={() => void apply()}>{busy ? t('template.adding') : t('template.add')}</button>
        </div>
      </div>
    </div>
  )
}
