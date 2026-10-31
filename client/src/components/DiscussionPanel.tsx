import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { DiscussionRound, PlanObjection, Project } from '../../../shared/types'
import { resolveObjection } from '../api'
import { t } from '../i18n'

interface DiscussionPanelProps {
  project: Project
  name: (id: string) => string
  disabled?: boolean
}

const statusLabel = (status: string) => t(`discussion.status.${status}` as MessageKey)

export function discussionReason(reason: string): string {
  const key = ({
  "Resolve the objections that need your decision before starting.": "discussion.waitingUser",
  "Muted in group conversations.": "discussion.omittedMuted",
  "This provider cannot enforce read-only discussion with these tools.": "discussion.omittedReadOnly",
  "Discussion participant limit reached.": "discussion.omittedCap",
  "No longer an eligible read-only participant.": "discussion.omittedChanged",
  "Interrupted by a server restart.": "discussion.restarted"
} as Record<string, MessageKey>)[reason]
  return key ? t(key) : reason
}

export function DiscussionPanel({ project, name, disabled = false }: DiscussionPanelProps) {
  const [reasons, setReasons] = useState<Record<string, string>>({})
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const rounds = project.discussions ?? []
  const epoch = project.planEpoch ?? 0
  const current = [...rounds].reverse().find((round) => round.epoch === epoch && round.status !== 'superseded')
  const earlier = [...rounds].filter((round) => round !== current).reverse()
  const objections = project.objections ?? []

  if (rounds.length === 0 && objections.length === 0) return null

  const resolve = async (objection: PlanObjection, disposition: 'accepted' | 'rejected' | 'unresolved') => {
    const reason = (reasons[objection.id] ?? '').trim()
    if (!reason) {
      setError(t('discussion.reasonRequired'))
      return
    }
    setError(null)
    setPendingId(objection.id)
    try {
      await resolveObjection(project.id, objection.id, disposition, reason)
      setReasons((all) => ({ ...all, [objection.id]: '' }))
    } catch (err) {
      setError(t('discussion.resolveFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setPendingId(null)
    }
  }

  const roundContent = (round: DiscussionRound, canResolve: boolean) => {
    const roundObjections = objections.filter((objection) => objection.roundId === round.id)
    return (
      <div className="discussion-round-content">
        <div className="discussion-participants" aria-label={t('discussion.participants')}>
          {round.participants.map((participant) => (
            <div className="discussion-participant" key={participant.agentId}>
              <strong>{name(participant.agentId)}</strong>
              <span className={`discussion-status is-${participant.status}`}>{statusLabel(participant.status)}</span>
              {participant.reason && <p>{discussionReason(participant.reason)}</p>}
              {participant.excerpt && <blockquote>{participant.excerpt}</blockquote>}
            </div>
          ))}
        </div>

        <div className="discussion-objections">
          <h4>{t('discussion.objections')}</h4>
          {roundObjections.length === 0 ? <p className="muted small">{t('discussion.noObjections')}</p> : roundObjections.map((objection) => (
            <article className={`discussion-objection is-${objection.status}`} key={objection.id}>
              <div className="discussion-objection-head">
                <strong>{objection.id}</strong>
                <span className={`discussion-severity is-${objection.severity}`}>{t(`discussion.severity.${objection.severity}` as MessageKey)}</span>
                <span className="discussion-status">{statusLabel(objection.status)}</span>
                <span className="muted">{name(objection.by)} · {t(`discussion.basis.${objection.basis}` as MessageKey)}</span>
              </div>
              <p className="discussion-claim">{objection.claim}{objection.truncated ? ' …' : ''}</p>
              <p><strong>{t('discussion.reason')}:</strong> {objection.reason}</p>
              {objection.citations.length > 0 && (
                <div className="discussion-citations"><strong>{t('discussion.citations')}:</strong> {objection.citations.map((citation, index) => <span key={`${index}-${citation}`}>{citation}</span>)}</div>
              )}
              {objection.proposal && <p><strong>{t('discussion.proposal')}:</strong> {objection.proposal}</p>}
              {objection.disposition && <p className="discussion-disposition"><strong>{t('discussion.disposition')}:</strong> {t('discussion.dispositionBy', { status: statusLabel(objection.status), name: name(objection.disposition.by) })} · {objection.disposition.reason}</p>}
              {canResolve && objection.status === 'needs-user' && (
                <div className="discussion-resolve">
                  <label>
                    {t('discussion.reason')}
                    <textarea rows={2} required value={reasons[objection.id] ?? ''} disabled={disabled || pendingId === objection.id} placeholder={t('discussion.reasonPlaceholder')} onChange={(event) => setReasons((all) => ({ ...all, [objection.id]: event.target.value }))} />
                  </label>
                  <div className="discussion-resolve-actions">
                    <button className="btn btn-primary" type="button" disabled={disabled || pendingId !== null || !(reasons[objection.id] ?? '').trim()} onClick={() => void resolve(objection, 'accepted')}>{t('discussion.accept')}</button>
                    <button className="btn" type="button" disabled={disabled || pendingId !== null || !(reasons[objection.id] ?? '').trim()} onClick={() => void resolve(objection, 'rejected')}>{t('discussion.reject')}</button>
                    <button className="btn" type="button" disabled={disabled || pendingId !== null || !(reasons[objection.id] ?? '').trim()} onClick={() => void resolve(objection, 'unresolved')}>{t('discussion.unresolved')}</button>
                  </div>
                </div>
              )}
            </article>
          ))}
        </div>
      </div>
    )
  }

  return (
    <section className="board-section discussion-panel" aria-labelledby="discussion-title">
      <h3 id="discussion-title">{t('discussion.title')}</h3>
      {error && <div className="form-error" role="alert">{error}</div>}
      {current ? (
        <div className="discussion-current">
          <div className="discussion-round-heading">
            <strong>{t('discussion.round', { n: rounds.indexOf(current) + 1 })}</strong>
            <span className={`discussion-status is-${current.status}`}>{t(`discussion.roundStatus.${current.status}` as MessageKey)}</span>
          </div>
          {roundContent(current, true)}
        </div>
      ) : <p className="muted small">{rounds.length ? t('discussion.noDiscussion') : t('discussion.noObjections')}</p>}
      {earlier.length > 0 && (
        <details className="discussion-earlier">
          <summary>{t('discussion.earlier')} ({earlier.length})</summary>
          {earlier.map((round, index) => (
            <div className="discussion-old-round" key={round.id}>
              <div className="discussion-round-heading"><strong>{t('discussion.round', { n: earlier.length - index })}</strong><span className={`discussion-status is-${round.status}`}>{t(`discussion.roundStatus.${round.status}` as MessageKey)}</span></div>
              {roundContent(round, false)}
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
