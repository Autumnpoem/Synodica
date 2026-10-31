import { useState } from 'react'
import type { MessageKey } from '../../../shared/i18n'
import type { AgentActivity, Conversation, Project, Task, TaskState, Team, TaskTier } from '../../../shared/types'
import { createTask, projectAction, taskAction, updateProject, updateTask, type ProjectAction } from '../api'
import { activityLine, TASK_STATE_LABEL } from '../activity'
import { t } from '../i18n'
import { personFor } from '../people'
import { Avatar } from './Avatar'
import { AttachmentList, attachmentFromPath } from './Preview'
import { DiscussionPanel, discussionReason } from './DiscussionPanel'

interface BoardProps {
  team: Team
  project: Project
  conversation: Conversation
  activity: Map<string, AgentActivity>
  busy: boolean
}

const GROUPS: { title: MessageKey; states: TaskState[] }[] = [
  { title: 'board.group.needsYou', states: ['failed', 'blocked', 'interrupted', 'paused'] },
  { title: 'board.group.inProgress', states: ['running', 'reviewing', 'implemented', 'rework'] },
  { title: 'board.group.ready', states: ['ready'] },
  { title: 'board.group.waiting', states: ['waiting'] },
  { title: 'board.group.accepted', states: ['accepted'] },
  { title: 'board.group.cancelled', states: ['cancelled'] },
]

const TIERS: TaskTier[] = ['routine', 'standard', 'critical']

const lines = (s: string): string[] =>
  s
    .split('\n')
    .map((x) => x.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean)

/** The project's live task board: phase actions, plan, decisions and every task with its evidence. */
export function ProjectBoard({ team, project, conversation, activity, busy }: BoardProps) {
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [request, setRequest] = useState('')
  const [adding, setAdding] = useState(false)
  const [showPlan, setShowPlan] = useState(false)
  const members = team.agents.filter((a) => conversation.memberIds.includes(a.id))
  const name = (id: string) => (id === 'user' ? team.owner.name : id === 'workflow' ? t('common.workflow') : personFor(team, id).name)

  /** Runs an action and shows its error; resolves true on success. */
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    setPending(true)
    try {
      await fn()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setPending(false)
    }
  }
  const act = (action: ProjectAction, body: Record<string, unknown> = {}) => run(() => projectAction(project.id, action, body))

  const needsDecision = (project.objections ?? []).some((o) => o.epoch === (project.planEpoch ?? 0) && o.status === 'needs-user')
  const running = project.runs.filter((r) => r.status === 'running')
  const open = project.tasks.filter((t) => t.state !== 'accepted' && t.state !== 'cancelled')
  // A board filled by hand (no kickoff, or new tasks after delivery) waits for an explicit Start.
  const manualBoard = (project.phase === 'new' || project.phase === 'done') && open.length > 0
  const canKickoff = ['new', 'plan-ready', 'done', 'needs-attention'].includes(project.phase) && running.length === 0 && !manualBoard
  const phaseLabel = manualBoard ? t('board.phase.manual') : t(`board.phase.${project.phase}` as MessageKey)

  return (
    <div className="board">
      <div className="board-head">
        <div className="board-title">{project.name}</div>
        <span className={`phase phase-${manualBoard ? 'plan-ready' : project.phase}`}>{phaseLabel}</span>
        {project.paused && project.phase !== 'done' && <span className="phase phase-paused">{t('task.state.paused')}</span>}
      </div>
      <div className="board-ws" title={t('board.workspaceHint')}>
        {project.workspace}
      </div>
      <div className="board-roles">
        <label>
          {t('board.decisionOwner')}
          <select value={project.decisionOwnerId ?? ''} disabled={pending || busy} onChange={(e) => void run(() => updateProject(project.id, { decisionOwnerId: e.target.value }))}>
            {!project.decisionOwnerId && <option value="">{t('board.none')}</option>}
            {members.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('board.critic')}
          <select value={project.criticId ?? ''} disabled={pending || busy} onChange={(e) => void run(() => updateProject(project.id, { criticId: e.target.value }))}>
            <option value="">{t('board.noCritique')}</option>
            {members
              .filter((a) => a.id !== project.decisionOwnerId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label title={t('board.finalReviewerHint')}>
          {t('board.finalReviewer')}
          <select value={project.finalReviewerId ?? ''} disabled={pending || busy} onChange={(e) => void run(() => updateProject(project.id, { finalReviewerId: e.target.value }))}>
            <option value="">{t('board.autoReviewer')}</option>
            {members.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {error && (
        <div className="form-error" role="alert">
          {discussionReason(error)}
        </div>
      )}
      {project.reason && <div className="board-reason">{discussionReason(project.reason)}</div>}
      {running.map((r) => (
        <div key={r.id} className="board-running">
          <span className="dot" /> {name(r.agentId)} · {r.kind === 'work' ? t('board.workingOn') : r.kind === 'review' ? t('board.reviewing') : r.kind === 'discuss' ? t('board.discussing') : r.kind} {r.ref}
        </div>
      ))}

      <CorrectionsPanel project={project} />
      <DiscussionPanel project={project} name={name} disabled={pending || busy} />

      <div className="board-actions">
        {canKickoff && (
          <div className="kickoff">
            <textarea rows={project.phase === 'new' ? 3 : 2} value={request} onChange={(e) => setRequest(e.target.value)} placeholder={project.brief ? t('board.briefAdd') : t('board.briefAsk')} />
            <button type="button" className="btn btn-primary" disabled={pending || (!request.trim() && !project.brief)} onClick={() => void act('kickoff', { text: request }).then((ok) => ok && setRequest(''))} title={t('board.kickoffHint')}>
              {t('board.kickoff')}
            </button>
          </div>
        )}
        {(project.phase === 'plan-ready' || manualBoard) && (
          <>
            <button type="button" className="btn btn-primary" disabled={pending || running.length > 0 || needsDecision} onClick={() => void act('start')} title={t(needsDecision ? 'discussion.waitingUser' : 'board.startHint')}>
              {t('board.startImpl')}
            </button>
            {project.phase === 'plan-ready' && project.plan && (
              <button type="button" className="btn" disabled={pending || !project.criticId} onClick={() => void act('critique')} title={project.criticId ? t('board.critiqueHint') : t('board.pickCritic')}>
                {t('board.critiqueAgain')}
              </button>
            )}
          </>
        )}
        {(project.phase === 'executing' || project.phase === 'final-review') && !project.paused && (
          <button type="button" className="btn" disabled={pending} onClick={() => void act('pause')} title={t('board.pauseHint')}>
            {t('board.pause')}
          </button>
        )}
        {(project.phase === 'needs-attention' || project.paused) && project.phase !== 'done' && (
          <button type="button" className="btn btn-primary" disabled={pending || running.length > 0} onClick={() => void act('resume')}>
            {t('board.resume')}
          </button>
        )}
        {running.length > 0 && (
          <button type="button" className="btn btn-danger-ghost" disabled={pending} onClick={() => void act('stop')} title={t('board.stopHint')}>
            {t('board.stop')}
          </button>
        )}
      </div>

      <VerificationPanel project={project} name={name} disabled={pending || running.length > 0} onDecide={(state, reason) => act('verification', { state, reason })} />

      {project.plan && (
        <div className="board-section">
          <button type="button" className="board-toggle" onClick={() => setShowPlan((v) => !v)}>
            {showPlan ? '▾' : '▸'} {t('board.planBy', { name: name(project.plan.by), summary: project.plan.summary || t('board.taskCount', { n: project.plan.tasks.length }) })}
          </button>
          {showPlan && (
            <div className="board-plan">
              {project.plan.architecture && (
                <p>
                  <strong>{t('board.architecture')}</strong> {project.plan.architecture}
                </p>
              )}
              {project.critiques.map((c, i) => (
                <p key={i}>
                  <strong>{t('board.critiqueBy', { name: name(c.by) })}</strong> {c.verdict}
                  {c.issues.length > 0 && `: ${c.issues.join('; ')}`}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
      {project.decisions.length > 0 && (
        <div className="board-section">
          <h3>{t('board.decisions')}</h3>
          {project.decisions.slice(-4).map((d, i) => (
            <div key={i} className="decision">
              <strong>{d.decision}</strong>
              <span className="muted">
                {' '}
                — {name(d.by)}
                {d.rationale ? ` · ${d.rationale}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="board-section">
        <div className="board-tasks-head">
          <h3>
            {t('board.tasks')} <span className="muted">{t('board.openCount', { n: open.length })}</span>
          </h3>
          <button type="button" className="link" onClick={() => setAdding((v) => !v)}>
            {adding ? t('common.close') : t('board.addTask')}
          </button>
        </div>
        {adding && <TaskForm project={project} members={members} onDone={() => setAdding(false)} onError={setError} />}
        {project.tasks.length === 0 && !adding && <p className="muted small">{t('board.noTasks')}</p>}
        {GROUPS.map((g) => {
          const tasks = project.tasks.filter((x) => g.states.includes(x.state))
          if (tasks.length === 0) return null
          return (
            <div key={g.title} className="task-group">
              <div className="task-group-title">{t(g.title)}</div>
              {tasks.map((x) => (
                <TaskCard key={x.id} team={team} project={project} task={x} members={members} activity={activity} onError={setError} />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The owner's corrections, newest first, with their truthful status. A scope-changing correction
 * that was applied leaves the explicit choice here: Resume continues with it, Kickoff re-plans.
 */
function CorrectionsPanel({ project }: { project: Project }) {
  const list = project.corrections ?? []
  if (list.length === 0) return null
  const latest = list[list.length - 1]
  const scopeChoice = latest?.mode === 'replan' && latest.status === 'applied' && project.phase === 'needs-attention'
  return (
    <div className="board-section board-corrections">
      <h3>{t('board.corrections')}</h3>
      {scopeChoice && <div className="board-reason">{t('board.correctionScope')}</div>}
      {list
        .slice(-4)
        .reverse()
        .map((c) => (
          <div key={c.id} className={`correction-item is-${c.status}`}>
            <span className="muted small">
              {new Date(c.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {t(`correction.status.${c.status}` as MessageKey)}
              {c.interrupted ? ` · ${t('correction.interrupted', { ref: c.interrupted })}` : ''}
            </span>{' '}
            {c.text}
          </div>
        ))}
    </div>
  )
}

const GATE_LABEL: Record<NonNullable<Project['verification']>['state'], MessageKey> = {
  pending: 'verify.pending',
  passed: 'verify.passed',
  'not-applicable': 'verify.not-applicable',
  overridden: 'verify.overridden',
}

/**
 * The user-flow / test verification gate. When the project is blocked on it, you can add a
 * verification task (kind "test") and Resume, or record a reason why it is not applicable or why
 * you override it. A reason is always required and is kept in the decisions.
 */
function VerificationPanel({ project, name, disabled, onDecide }: { project: Project; name: (id: string) => string; disabled: boolean; onDecide: (state: 'not-applicable' | 'overridden', reason: string) => Promise<boolean> }) {
  const [reason, setReason] = useState('')
  const gate = project.verification
  if (!gate || project.phase === 'new') return null
  const blocked = project.phase === 'needs-attention' && project.pendingStep === 'verification'
  return (
    <div className="board-section">
      <div className="small">
        <strong>{t('verify.title')}</strong> {t(GATE_LABEL[gate.state])}
        {gate.taskIds.length > 0 && ` · ${gate.taskIds.join(', ')}`}
        {gate.by && gate.state !== 'pending' && ` · ${name(gate.by)}`}
      </div>
      {gate.evidence && <div className="muted small">{gate.evidence}</div>}
      {gate.reason && <div className="muted small">{t('verify.reason', { reason: gate.reason })}</div>}
      {blocked && (
        <div className="kickoff">
          <textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('verify.placeholder')} />
          <button type="button" className="btn" disabled={disabled || !reason.trim()} onClick={() => void onDecide('not-applicable', reason).then((ok) => ok && setReason(''))}>
            {t('verify.notApplicable')}
          </button>
          <button type="button" className="btn btn-danger-ghost" disabled={disabled || !reason.trim()} onClick={() => void onDecide('overridden', reason).then((ok) => ok && setReason(''))}>
            {t('verify.override')}
          </button>
        </div>
      )}
    </div>
  )
}

function TaskCard({ team, project, task, members, activity, onError }: { team: Team; project: Project; task: Task; members: Team['agents']; activity: Map<string, AgentActivity>; onError: (e: string | null) => void }) {
  const [open, setOpen] = useState(task.state === 'failed' || task.state === 'blocked' || task.state === 'interrupted')
  const [editing, setEditing] = useState(false)
  const [reasonFor, setReasonFor] = useState<null | 'cancel' | 'accept' | 'reject'>(null)
  const [reason, setReason] = useState('')
  const owner = personFor(team, task.ownerId)
  const reviewer = task.reviewerId ? personFor(team, task.reviewerId) : null
  const name = (id: string) => (id === 'user' ? team.owner.name : id === 'workflow' ? t('common.workflow') : personFor(team, id).name)
  const live = task.state === 'running' || task.state === 'reviewing'
  const canRetry = ['failed', 'blocked', 'interrupted', 'paused'].includes(task.state) && task.blockedOn !== 'dependency'
  const terminal = task.state === 'accepted' || task.state === 'cancelled'

  const go = async (fn: () => Promise<unknown>) => {
    onError(null)
    try {
      await fn()
      setReasonFor(null)
      setReason('')
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    }
  }

  const ownerActivity = activity.get(task.ownerId)
  return (
    <div className={`task task-${task.state}`}>
      <button type="button" className="task-top" onClick={() => setOpen((v) => !v)}>
        <span className="task-id">{task.id}</span>
        <span className="task-title">{task.title}</span>
        <span className={`task-state state-${task.state}`}>{TASK_STATE_LABEL[task.state]}</span>
      </button>
      <div className="task-people">
        <span className="task-person" title={live && task.state === 'running' ? activityLine(ownerActivity) : t('task.owner')}>
          <Avatar person={owner} size={18} /> {owner.name}
        </span>
        <span className="muted">{t('task.toReview')}</span>
        {reviewer ? (
          <span className="task-person" title={t('task.reviewer')}>
            <Avatar person={reviewer} size={18} /> {reviewer.name}
          </span>
        ) : (
          <span className="bad">{t('task.noReviewer')}</span>
        )}
        <span className="muted">
          · {t('task.attempts', { n: task.attempts, max: task.maxAttempts })} · {t(`task.tier.${task.tier}` as MessageKey)}
          {task.dependsOn.length > 0 ? ` · ${t('task.after', { ids: task.dependsOn.join(', ') })}` : ''}
        </span>
      </div>
      {task.reason && <div className="task-reason">{task.reason}</div>}
      {open && !editing && (
        <div className="task-body">
          {task.description && <p className="task-desc">{task.description}</p>}
          <div className="task-label">{t('task.acceptance')}</div>
          <ul>
            {task.acceptance.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
          {task.summary && (
            <>
              <div className="task-label">{t('task.handoff')}</div>
              <p>{task.summary}</p>
            </>
          )}
          {task.evidence && (
            <>
              <div className="task-label">{t('task.evidence')}</div>
              <p className="mono">{task.evidence}</p>
            </>
          )}
          {task.artifacts.length > 0 && (
            <>
              <div className="task-label">{t('task.artifacts')}</div>
              <AttachmentList items={task.artifacts.map(attachmentFromPath)} team={team} />
            </>
          )}
          {task.reviews.length > 0 && (
            <>
              <div className="task-label">{t('task.reviews')}</div>
              {task.reviews.map((r, i) => (
                <div key={i} className={`review review-${r.verdict}`}>
                  <strong>{r.verdict === 'approve' ? t('task.approvedBy', { name: name(r.reviewerId) }) : t('task.rejectedBy', { name: name(r.reviewerId) })}</strong>
                  {r.override ? ` ${t('task.override')}` : ''}
                  {r.findings.length > 0 && (
                    <ul>
                      {r.findings.map((f, j) => (
                        <li key={j}>{f}</li>
                      ))}
                    </ul>
                  )}
                  {r.evidence && <div className="muted small">{r.evidence}</div>}
                </div>
              ))}
            </>
          )}
          <div className="task-label">{t('task.history')}</div>
          <ul className="task-history">
            {task.history.slice(-8).map((h, i) => (
              <li key={i}>
                <span className="muted">{new Date(h.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span> {name(h.by)}: {h.text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {editing && <TaskForm project={project} members={members} task={task} onDone={() => setEditing(false)} onError={onError} />}
      {reasonFor && (
        <div className="task-reason-form">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={reasonFor === 'cancel' ? t('task.cancelReason') : t('task.reasonRequired')} autoFocus />
          <button
            type="button"
            className="btn btn-primary"
            disabled={reasonFor !== 'cancel' && !reason.trim()}
            onClick={() => void go(() => (reasonFor === 'cancel' ? taskAction(project.id, task.id, 'cancel', { reason }) : taskAction(project.id, task.id, 'override', { verdict: reasonFor, reason })))}
          >
            {reasonFor === 'cancel' ? t('task.cancelTask') : reasonFor === 'accept' ? t('task.accept') : t('task.sendBack')}
          </button>
          <button type="button" className="btn" onClick={() => setReasonFor(null)}>
            {t('common.back')}
          </button>
        </div>
      )}
      {!reasonFor && !editing && (
        <div className="task-actions">
          {canRetry && (
            <button type="button" className="link" onClick={() => void go(() => taskAction(project.id, task.id, 'retry'))}>
              {task.state === 'interrupted' ? t('board.resume') : t('board.retry')}
            </button>
          )}
          {!terminal && !live && (
            <button type="button" className="link" onClick={() => setEditing(true)}>
              {t('task.edit')}
            </button>
          )}
          {!live && task.state !== 'cancelled' && task.state !== 'accepted' && (
            <button type="button" className="link" onClick={() => setReasonFor('accept')} title={t('task.overrideAcceptHint')}>
              {t('task.overrideAccept')}
            </button>
          )}
          {!live && (task.state === 'accepted' || task.state === 'failed' || task.state === 'implemented') && (
            <button type="button" className="link" onClick={() => setReasonFor('reject')} title={t('task.overrideReworkHint')}>
              {t('task.overrideRework')}
            </button>
          )}
          {!terminal && (
            <button type="button" className="link danger" onClick={() => setReasonFor('cancel')}>
              {t('board.cancel')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TaskForm({ project, members, task, onDone, onError }: { project: Project; members: Team['agents']; task?: Task; onDone: () => void; onError: (e: string | null) => void }) {
  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [acceptance, setAcceptance] = useState((task?.acceptance ?? []).join('\n'))
  const [ownerId, setOwnerId] = useState(task?.ownerId ?? members.find((a) => a.workflowRoles?.includes('implementer'))?.id ?? members[0]?.id ?? '')
  const [reviewerId, setReviewerId] = useState(task?.reviewerId ?? '')
  const [deps, setDeps] = useState<string[]>(task?.dependsOn ?? [])
  const [tier, setTier] = useState<TaskTier>(task?.tier ?? 'standard')
  const [saving, setSaving] = useState(false)
  const others = project.tasks.filter((t) => t.id !== task?.id && t.state !== 'cancelled')

  const save = async () => {
    setSaving(true)
    onError(null)
    try {
      const body = { title, description, acceptance: lines(acceptance), ownerId, dependsOn: deps, tier, ...(reviewerId ? { reviewerId } : {}) }
      if (task) await updateTask(project.id, task.id, body)
      else await createTask(project.id, body)
      onDone()
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="task-form">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('task.form.title')} />
      <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('task.form.description')} />
      <textarea rows={3} value={acceptance} onChange={(e) => setAcceptance(e.target.value)} placeholder={t('task.form.acceptance')} />
      <div className="task-form-row">
        <label>
          {t('task.owner')}
          <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {members.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('task.form.reviewer')}
          <select value={reviewerId} onChange={(e) => setReviewerId(e.target.value)}>
            <option value="">{task ? t('task.form.keep') : t('task.form.auto')}</option>
            {members
              .filter((a) => a.id !== ownerId)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          {t('task.form.tier')}
          <select value={tier} onChange={(e) => setTier(e.target.value as TaskTier)}>
            {TIERS.map((x) => (
              <option key={x} value={x}>
                {t(`task.tier.${x}` as MessageKey)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {others.length > 0 && (
        <div className="task-deps">
          {t('task.form.after')}
          {others.map((x) => (
            <label key={x.id} className="dep">
              <input type="checkbox" checked={deps.includes(x.id)} onChange={(e) => setDeps((d) => (e.target.checked ? [...d, x.id] : d.filter((y) => y !== x.id)))} /> {x.id}
            </label>
          ))}
        </div>
      )}
      <div className="task-form-row">
        <button type="button" className="btn btn-primary" disabled={saving || !title.trim() || lines(acceptance).length === 0} onClick={() => void save()}>
          {task ? t('common.save') : t('task.form.add')}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          {t('common.cancel')}
        </button>
      </div>
    </div>
  )
}
