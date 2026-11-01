import type { MessageKey } from '../../shared/i18n'
import { presenceOf, providerLine, type PresenceView } from '../../shared/presence'
import type { AgentActivity, AgentActivityState, ProviderCheck, TaskState } from '../../shared/types'
import { getLocale, t } from './i18n'

/**
 * A label table that follows the UI language: English keeps these detailed source labels; other
 * locales read the shared resource (key prefix + state). Lookups stay `TABLE[state]`.
 */
function localized<K extends string>(english: Record<K, string>, prefix: string): Record<K, string> {
  const out = {} as Record<K, string>
  for (const k of Object.keys(english) as K[]) {
    Object.defineProperty(out, k, { enumerable: true, get: () => (getLocale() === 'en' ? english[k] : t(`${prefix}${k}` as MessageKey)) })
  }
  return out
}

export const ACTIVITY_LABEL: Record<AgentActivityState, string> = localized<AgentActivityState>({
  idle: 'Idle · nothing assigned',
  queued: 'Queued',
  thinking: 'Thinking',
  tool: 'Working',
  'waiting-approval': 'Waiting for your approval',
  'waiting-dependency': 'Waiting for a prerequisite',
  'waiting-user': 'Waiting for you',
  error: 'Last turn failed',
  interrupted: 'Interrupted',
  offline: 'Provider unavailable',
  replied: 'Replied',
  done: 'Task accepted',
}, 'activity.')

export function since(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return t('time.seconds', { n: s })
  const m = Math.round(s / 60)
  if (m < 60) return t('time.minutes', { n: m })
  return t('time.hours', { n: Math.round(m / 60) })
}

/** Localize only the safe, fixed reasons projected by server/activity.ts. Unknown details stay literal. */
function localizedReason(reason: string): string {
  const http = /^HTTP (\d{3})$/.exec(reason)
  if (http) return t('activity.reason.http', { status: http[1] ?? '' })
  const keys: Record<string, MessageKey> = {
    'Did not start: another writer is using this folder': 'activity.reason.writerBusy',
    'Rate limited by the provider': 'activity.reason.rateLimited',
    'Provider CLI not found': 'activity.reason.cliMissing',
    'Not signed in or not authorized': 'activity.reason.unauthorized',
    'Timed out': 'activity.reason.timeout',
    'Could not reach the provider': 'activity.reason.unreachable',
    'The provider stream broke': 'activity.reason.streamBroken',
    'No base URL configured': 'activity.reason.noBaseUrl',
    'The turn failed · details in the chat': 'activity.reason.turnFailed',
    'Check failed · details on the Providers page': 'activity.reason.checkFailed',
  }
  const key = keys[reason]
  return key ? t(key) : reason
}

/** A duration in the UI language (the same shape as formatDuration in English). */
export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return t('time.seconds', { n: s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('time.minutes', { n: m })
  return t('time.hm', { h: Math.floor(m / 60), m: m % 60 })
}

/** The Office label of a presence view in the UI language (English keeps the shared source text). */
export function presenceLabel(view: PresenceView, a: AgentActivity | undefined, connected: boolean): string {
  if (getLocale() === 'en') return view.label
  if (!connected) return t('presence.connectionLost')
  if (!a && view.presence === 'unknown') return t('presence.noReport')
  if (view.presence === 'stalled' && view.quietFor !== undefined) return t('presence.stalledFor', { d: duration(view.quietFor) })
  return t(`presence.${view.presence}` as MessageKey)
}

/** The detail line: a tool line stays literal; the connection-lost "last known" note is localized. */
export function presenceDetail(view: PresenceView, a: AgentActivity | undefined, now: number, connected: boolean): string | undefined {
  if (getLocale() === 'en' || !a) return view.detail
  if (connected) return view.detail ? localizedReason(view.detail) : undefined
  return t('presence.lastKnown', { label: presenceLabel(presenceOf(a, now), a, true) })
}

/** Provider reachability in the UI language. Not probed is unknown, never assumed reachable. */
export function providerText(check: ProviderCheck | undefined, now: number): { state: 'ok' | 'down' | 'unknown'; text: string } {
  const line = providerLine(check, now)
  if (getLocale() === 'en') return line
  if (!check) return { state: line.state, text: t('provider.notChecked') }
  const ago = duration(now - check.at)
  return { state: line.state, text: check.ok ? t('provider.reachable', { ago }) : t('provider.unavailable', { detail: localizedReason(check.detail), ago }) }
}

/** One honest line: state, task, detail and how long. Unknown when the server has not reported yet. */
export function activityLine(a: AgentActivity | undefined): string {
  if (!a) return t('activity.unknown')
  const parts = [ACTIVITY_LABEL[a.state]]
  if (a.taskRef) parts.push(a.taskRef)
  if (a.detail && a.state !== 'idle') parts.push(getLocale() === 'en' ? a.detail : localizedReason(a.detail))
  parts.push(t('desk.for', { d: since(a.since) }))
  return parts.join(' · ')
}

export const TASK_STATE_LABEL: Record<TaskState, string> = localized<TaskState>({
  waiting: 'Waiting',
  ready: 'Ready',
  running: 'In progress',
  implemented: 'Implemented · review pending',
  reviewing: 'In review',
  rework: 'Rework',
  accepted: 'Accepted',
  failed: 'Failed · needs you',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  paused: 'Paused',
  cancelled: 'Cancelled',
}, 'task.state.')
