import { useState } from 'react'
import type { ApprovalRequest, Team } from '../../../shared/types'
import { resolveApproval } from '../api'
import { t } from '../i18n'
import { personFor } from '../people'
import { Avatar } from './Avatar'

interface ApprovalProps {
  team: Team
  request: ApprovalRequest
}

/** A tool call waiting for the owner: Allow once / Always allow this tool / Deny. */
export function ApprovalCard({ team, request }: ApprovalProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const p = personFor(team, request.agentId)
  const act = async (allow: boolean, always = false) => {
    setBusy(true)
    setError(null)
    try {
      await resolveApproval(request.id, allow, always)
    } catch (err) {
      // e.g. 409: a correction made this request stale; nothing old runs.
      setError(err instanceof Error && /stale/i.test(err.message) ? t('approval.stale') : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const input = JSON.stringify(request.input, null, 1)
  return (
    <div className="approval">
      <div className="approval-head">
        <Avatar person={p} size={22} />
        <span>
          <strong>{t('approval.needs', { name: p.name })}</strong> <code>{request.tool}</code>
        </span>
      </div>
      <div className="approval-summary" dir="auto">
        {request.summary || input.slice(0, 300)}
      </div>
      {request.summary && input.length > request.summary.length + 20 && (
        <details className="approval-details">
          <summary>{t('approval.input')}</summary>
          <pre>{input.slice(0, 4000)}</pre>
        </details>
      )}
      {error && <div className="form-error">{error}</div>}
      <div className="approval-actions">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(true)}>
          {t('approval.allow')}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => void act(true, true)} title={`${t('approval.always')}: ${request.tool}`}>
          {t('approval.always')} {request.tool}
        </button>
        <button type="button" className="btn btn-danger-ghost" disabled={busy} onClick={() => void act(false)}>
          {t('approval.deny')}
        </button>
      </div>
    </div>
  )
}
