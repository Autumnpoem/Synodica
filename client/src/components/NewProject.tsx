import { useEffect, useState } from 'react'
import type { Team } from '../../../shared/types'
import { createProject, suggestWorkspace } from '../api'
import { t } from '../i18n'
import { RolePicker } from './RolePicker'

interface NewProjectProps {
  team: Team
  onDone: (conversationId?: string) => void
  onAddTeam: () => void
}

/** A project: its own chat, its own folder, a decision owner and a critic. */
export function NewProject({ team, onDone, onAddTeam }: NewProjectProps) {
  const workers = team.agents.filter((a) => (a.workflowRoles?.length ?? 0) > 0)
  const [name, setName] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [touched, setTouched] = useState(false)
  const [members, setMembers] = useState<string[]>((workers.length >= 2 ? workers : team.agents).map((a) => a.id))
  const [brief, setBrief] = useState('')
  const [kickoff, setKickoff] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (touched) return
    const timer = setTimeout(() => {
      suggestWorkspace(name || 'project')
        .then(setWorkspace)
        .catch(() => {})
    }, 250)
    return () => clearTimeout(timer)
  }, [name, touched])

  const chosen = team.agents.filter((a) => members.includes(a.id))
  const lead = chosen.find((a) => a.workflowRoles?.includes('lead')) ?? chosen[0]
  const critic = chosen.find((a) => a.id !== lead?.id && a.workflowRoles?.includes('critic')) ?? chosen.find((a) => a.id !== lead?.id && a.workflowRoles?.includes('reviewer'))

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const { conversation } = await createProject({ name: name.trim(), workspace: workspace.trim(), memberIds: members, brief: brief.trim(), kickoff: kickoff && brief.trim().length > 0 })
      onDone(conversation.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet sheet-wide" role="dialog" aria-label={t('nav.newProject')}>
        <h2>{t('nav.newProject')}</h2>
        {error && <div className="form-error">{error}</div>}
        {workers.length < 2 && (
          <div className="hint-box">
            {t('newProject.noRolesBefore')}{' '}
            <button type="button" className="link" onClick={onAddTeam}>
              {t('newProject.template')}
            </button>{' '}
            {t('newProject.noRolesAfter')}
          </div>
        )}
        <label className="field">
          <span>{t('newChat.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('newProject.namePh')} autoFocus />
        </label>
        <label className="field">
          <span>{t('newProject.folder')}</span>
          <input
            value={workspace}
            onChange={(e) => {
              setTouched(true)
              setWorkspace(e.target.value)
            }}
            className="mono"
          />
          <small>{t('newProject.folderHint')}</small>
        </label>
        <div className="field">
          <RolePicker team={team} selected={members} onChange={setMembers} />
          <small>{t('newProject.roles', { lead: lead?.name ?? t('newProject.none'), critic: critic?.name ?? t('newProject.noCritic') })}</small>
        </div>
        <label className="field">
          <span>{t('board.briefAsk')}</span>
          <textarea rows={5} value={brief} onChange={(e) => setBrief(e.target.value)} placeholder={t('newProject.briefPh')} />
        </label>
        <label className="check">
          <input type="checkbox" checked={kickoff} onChange={(e) => setKickoff(e.target.checked)} /> {t('newProject.kickoff')}
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={() => onDone()}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !name.trim() || members.length < 2 || !workspace.trim()} onClick={() => void save()}>
            {busy ? t('newProject.creating') : t('newProject.create')}
          </button>
        </div>
      </div>
    </div>
  )
}
