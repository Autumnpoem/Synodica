import { useState } from 'react'
import type { Skill, Team } from '../../../shared/types'
import { deleteSkill, putSkill } from '../api'
import { t } from '../i18n'

interface SkillsProps {
  team: Team
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function Skills({ team }: SkillsProps) {
  const [editing, setEditing] = useState<{ id: string; skill: Skill } | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const entries = Object.entries(team.skills)

  const remove = async (id: string) => {
    try {
      await deleteSkill(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="marketplace-head">
        <h1>{t('settings.nav.skills')}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>
          {t('skills.new')}
        </button>
      </div>
      <p className="lead">
        {t('skills.leadA')} <code>/</code> {t('skills.leadB')} <code>~/.claude/skills</code> {t('skills.leadC')}
      </p>
      {error && <div className="form-error">{error}</div>}
      <div className="card">
        {entries.length === 0 && (
          <div className="row">
            <div className="row-text">
              <div className="row-title">{t('skills.none')}</div>
              <div className="row-hint">{t('skills.noneHint')}</div>
            </div>
          </div>
        )}
        {entries.map(([id, s]) => (
          <div key={id} className="row">
            <div className="row-text">
              <div className="row-title">
                <code>/{id}</code> {s.name}
              </div>
              <div className="row-hint">{s.description || s.body.slice(0, 140)}</div>
            </div>
            <div className="row-control">
              <button type="button" className="btn" onClick={() => setEditing({ id, skill: s })}>
                {t('skills.edit')}
              </button>
              <button type="button" className="btn btn-danger-ghost" onClick={() => void remove(id)}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        ))}
      </div>
      {editing !== undefined && <SkillSheet existing={editing} onDone={() => setEditing(undefined)} />}
    </>
  )
}

function SkillSheet({ existing, onDone }: { existing: { id: string; skill: Skill } | null; onDone: () => void }) {
  const [id, setId] = useState(existing?.id ?? '')
  const [name, setName] = useState(existing?.skill.name ?? '')
  const [description, setDescription] = useState(existing?.skill.description ?? '')
  const [body, setBody] = useState(existing?.skill.body ?? '')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const key = existing?.id ?? slug(id || name)
      if (!key) throw new Error(t('skills.needName'))
      await putSkill(key, { name: name.trim() || key, description: description.trim(), body })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }
  return (
    <div className="modal-backdrop nested" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet" role="dialog">
        <h2>{existing ? t('skills.editTitle', { id: existing.id }) : t('skills.newTitle')}</h2>
        {error && <div className="form-error">{error}</div>}
        <label className="field">
          <span>{t('skills.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('skills.namePh')} autoFocus />
        </label>
        {!existing && (
          <label className="field">
            <span>{t('skills.slash')}</span>
            <input value={id} onChange={(e) => setId(slug(e.target.value))} placeholder={slug(name) || 'standup'} />
          </label>
        )}
        <label className="field">
          <span>{t('skills.description')}</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('skills.descriptionPh')} />
        </label>
        <label className="field">
          <span>{t('skills.instructions')}</span>
          <textarea rows={7} value={body} onChange={(e) => setBody(e.target.value)} placeholder={t('skills.instructionsPh')} />
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !body.trim()} onClick={() => void save()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
