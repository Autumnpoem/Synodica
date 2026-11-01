import { useEffect, useState } from 'react'
import type { Conversation, Routine, Team } from '../../../shared/types'
import { cronPresets, deleteRoutine, putRoutine, runRoutine } from '../api'
import { formatDuration, formatRelative } from '../format'
import { conversationTitle, personFor } from '../people'
import { Avatar } from './Avatar'
import { getLocale, t } from '../i18n'

interface RoutinesProps {
  team: Team
  conversations: Conversation[]
  routines: Routine[]
}

function slug(): string {
  return `r-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

function relativeLabel(ts: number): string {
  if (getLocale() !== 'zh-CN') return formatRelative(ts)
  const diff = ts - Date.now()
  const abs = Math.abs(diff)
  const unit = abs < 3_600_000 ? ['minutes', 60_000] as const : abs < 86_400_000 ? ['hours', 3_600_000] as const : ['days', 86_400_000] as const
  const duration = t(`time.${unit[0]}` as 'time.minutes', { n: Math.round(abs / unit[1]) })
  return t(diff > 0 ? 'time.in' : 'time.ago', { duration })
}

export function Routines({ team, conversations, routines }: RoutinesProps) {
  const [editing, setEditing] = useState<Routine | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const run = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await runRoutine(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const remove = async (id: string) => {
    try {
      await deleteRoutine(id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const toggle = async (r: Routine) => {
    try {
      await putRoutine(r.id, { name: r.name, agentId: r.agentId, conversationId: r.conversationId, cron: r.cron, instruction: r.instruction, enabled: !r.enabled })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <>
      <div className="marketplace-head">
        <h1>{t('settings.nav.routines')}</h1>
        <button type="button" className="btn btn-primary" onClick={() => setEditing(null)}>
          {t('routines.new')}
        </button>
      </div>
      <p className="lead">{t('routines.lead')}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="card">
        {routines.length === 0 && (
          <div className="row">
            <div className="row-text">
              <div className="row-title">{t('routines.none')}</div>
              <div className="row-hint">{t('routines.noneHint')}</div>
            </div>
          </div>
        )}
        {routines.map((r) => {
          const p = personFor(team, r.agentId)
          const conv = conversations.find((c) => c.id === r.conversationId)
          const last = r.runs[0]
          return (
            <div key={r.id} className="row">
              <Avatar person={p} size={34} />
              <div className="row-text">
                <div className="row-title">
                  {r.name}
                  {!r.enabled && <span className="badge">{t('routines.paused')}</span>}
                </div>
                <div className="row-hint">
                  {p.name} → {conv ? conversationTitle(team, conv) : r.conversationId} · {r.cron ? t('routines.cron', { cron: r.cron }) : t('routines.webhookOnly')}
                  {r.nextRunAt ? t('routines.next', { when: relativeLabel(r.nextRunAt) }) : ''}
                </div>
                <div className="row-hint">
                  {last ? t('routines.lastRun', { when: relativeLabel(last.at), status: t(`routines.status.${last.status}` as 'routines.status.ok'), error: last.error ? ` (${last.error})` : '', duration: formatDuration(last.durationMs) }) : t('routines.never')} · {t('routines.webhook')} <code>POST /api/hooks/{r.id}</code>
                </div>
              </div>
              <div className="row-control">
                <button type="button" className="btn" disabled={busy === r.id} onClick={() => void run(r.id)}>
                  {busy === r.id ? t('routines.running') : t('routines.runNow')}
                </button>
                <button type="button" className="btn" onClick={() => void toggle(r)}>
                  {r.enabled ? t('routines.pause') : t('routines.resume')}
                </button>
                <button type="button" className="btn" onClick={() => setEditing(r)}>
                  {t('routines.edit')}
                </button>
                <button type="button" className="btn btn-danger-ghost" onClick={() => void remove(r.id)}>
                  {t('common.delete')}
                </button>
              </div>
            </div>
          )
        })}
      </div>
      {editing !== undefined && <RoutineSheet team={team} conversations={conversations} routine={editing} onDone={() => setEditing(undefined)} />}
    </>
  )
}

function RoutineSheet({ team, conversations, routine, onDone }: { team: Team; conversations: Conversation[]; routine: Routine | null; onDone: () => void }) {
  const [name, setName] = useState(routine?.name ?? '')
  const [agentId, setAgentId] = useState(routine?.agentId ?? team.agents[0]?.id ?? '')
  const [conversationId, setConversationId] = useState(routine?.conversationId ?? (routine ? '' : `dm-${team.agents[0]?.id ?? ''}`))
  const [cron, setCron] = useState(routine?.cron ?? '0 9 * * 0-4')
  const [instruction, setInstruction] = useState(routine?.instruction ?? '')
  const [presets, setPresets] = useState<{ label: string; cron: string }[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    cronPresets().then(setPresets).catch(() => setPresets([]))
  }, [])
  const eligible = conversations.filter((c) => c.memberIds.includes(agentId))
  useEffect(() => {
    if (!eligible.some((c) => c.id === conversationId)) setConversationId(eligible[0]?.id ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId])

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await putRoutine(routine?.id ?? slug(), { name: name.trim() || 'Routine', agentId, conversationId, cron: cron.trim(), instruction: instruction.trim(), enabled: routine?.enabled ?? true })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop nested" onMouseDown={(e) => e.target === e.currentTarget && onDone()}>
      <div className="modal sheet" role="dialog">
        <h2>{routine ? t('routines.editTitle') : t('routines.newTitle')}</h2>
        {error && <div className="form-error">{error}</div>}
        <label className="field">
          <span>{t('routines.name')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('routines.namePh')} autoFocus />
        </label>
        <label className="field">
          <span>{t('routines.employee')}</span>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
            {team.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} | {a.role}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('routines.postIn')}</span>
          <select value={conversationId} onChange={(e) => setConversationId(e.target.value)}>
            {eligible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.kind === 'group' ? `${t('usageLocal.group')} · ${conversationTitle(team, c)}` : `${t('usageLocal.directMessage')} · ${conversationTitle(team, c)}`}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t('routines.schedule')}</span>
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 9 * * 0-4" />
          <div className="chips">
            {presets.map((p) => {
              const id = ({ '0 * * * *': 'hourly', '0 8 * * *': 'daily-0800', '0 18 * * *': 'daily-1800', '0 9 * * 0-4': 'weekdays-0900', '0 10 * * 1': 'monday-1000', '0 9 1 * *': 'monthly-0900' } as Record<string, string>)[p.cron]
              return <button key={p.cron} type="button" className={`chip${cron === p.cron ? ' is-active' : ''}`} onClick={() => setCron(p.cron)}>{id ? t(`routines.preset.${id}` as 'routines.preset.hourly') : p.label}</button>
            })}
            <button type="button" className={`chip${cron === '' ? ' is-active' : ''}`} onClick={() => setCron('')}>
              {t('routines.webhookChip')}
            </button>
          </div>
        </label>
        <label className="field">
          <span>{t('routines.instruction')}</span>
          <textarea rows={5} value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder={t('routines.instructionPh')} />
          <small>{t('routines.instructionHint')}</small>
        </label>
        <div className="actions">
          <button type="button" className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || !instruction.trim() || !conversationId} onClick={() => void save()}>
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
