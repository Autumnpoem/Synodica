import { useRef, useState } from 'react'
import { getTeamPreset, savedPresetMembers, TEAM_PRESET_IDS, type TeamPresetId } from '../../../shared/team-presets'
import type { Team } from '../../../shared/types'
import { getLocale, t } from '../i18n'
import { personFor } from '../people'
import { Avatar } from './Avatar'
import { Profile } from './Profile'
import { TeamTemplate } from './TeamTemplate'

/** Select saved team members without copying or resetting their persona and model. */
export function RolePicker({ team, selected, onChange }: { team: Team; selected: string[]; onChange: (ids: string[]) => void }) {
  const [preset, setPreset] = useState<TeamPresetId | null>(null)
  const presetButtons = useRef<Partial<Record<TeamPresetId, HTMLButtonElement | null>>>({})
  const closePreset = () => { if (preset) presetButtons.current[preset]?.focus(); setPreset(null) }
  const [adding, setAdding] = useState(false)
  const [query, setQuery] = useState('')
  const addButton = useRef<HTMLButtonElement>(null)
  const closeCreator = () => { setAdding(false); addButton.current?.focus() }
  const agents = team.agents.filter((a) => `${a.name} ${a.role} ${a.scope ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <div className="role-picker">
    <div className="role-picker-heading">
      <h3>{t('roles.choose')}</h3>
      <button type="button" className="link" onClick={() => onChange(team.agents.map((a) => a.id))}>{t('newChat.all')}</button>
    </div>
    <p className="hint">{t('roles.reuseHint')}</p>
    <div className="role-preset-choices" aria-label={t('template.choose')}>
      {TEAM_PRESET_IDS.map((id) => <button key={id} ref={(element) => { presetButtons.current[id] = element }} type="button" className="btn" onClick={() => {
        const saved = savedPresetMembers(team, id)
        if (saved.length === getTeamPreset(id).seats.length) { onChange(saved.map((a) => a.id)); setQuery('') } else setPreset(id)
      }}>{getTeamPreset(id, getLocale()).name}</button>)}
    </div>
    <input aria-label={t('roles.search')} placeholder={t('roles.search')} value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="role-picker-list">
      {agents.map((a) => <button key={a.id} type="button" className={`role-pick${selected.includes(a.id) ? ' is-active' : ''}`} aria-pressed={selected.includes(a.id)} onClick={() => onChange(selected.includes(a.id) ? selected.filter((id) => id !== a.id) : [...selected, a.id])}>
        <Avatar person={personFor(team, a.id)} size={36} />
        <span className="role-pick-copy"><strong>{a.name}</strong><span>{a.role}</span><small>{team.providers[a.provider]?.label ?? a.provider} · {a.model}</small></span>
        <span className="role-pick-check" aria-hidden="true">{selected.includes(a.id) ? '✓' : '+'}</span>
      </button>)}
      {agents.length === 0 && <p className="hint">{t('roles.noMatch')}</p>}
    </div>
    <button ref={addButton} type="button" className="btn role-add" onClick={() => setAdding(true)}>+ {t('roles.add')}</button>
    {preset && <TeamTemplate team={team} initialPreset={preset} onClose={closePreset} onApplied={(ids) => { onChange(ids); setQuery('') }} />}
    {adding && <div className="modal-backdrop nested role-creator" onMouseDown={(e) => { if (e.target === e.currentTarget) { e.stopPropagation(); closeCreator() } }} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); closeCreator() } }}>
      <div className="role-creator-dialog" role="dialog" aria-modal="true" aria-label={t('roles.add')}>
        <Profile team={team} agentId={null} onClose={closeCreator} onSaved={(id) => { onChange([...selected, id]); setQuery(''); closeCreator() }} />
      </div>
    </div>}
  </div>
}
