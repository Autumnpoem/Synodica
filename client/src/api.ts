import type { AccountStatus, Agent, AppState, Attachment, AvatarRef, Conversation, CorrectionMode, CorrectionRecord, McpServerDef, Message, Project, ProviderDef, ProviderModelCatalog, ProviderStatus, Routine, RoutineRun, Skill, Task, TaskKind, TaskTier, TeamSettings } from '../../shared/types'
import type { UsageReport, UsageSettings } from '../../shared/usage'
import { newRequestId, REQUEST_ID_HEADER, versionOf } from '../../shared/sync'

let knownProjects: Project[] = []
export function setKnownProjects(projects: Project[]): void { knownProjects = projects }
function projectVersion(id: string): HeadersInit { const p = knownProjects.find((x) => x.id === id); return p ? { 'If-Match': versionOf(p) } : {} }
function taskVersion(projectId: string, taskId: string): HeadersInit { const t = knownProjects.find((p) => p.id === projectId)?.tasks.find((x) => x.id === taskId); return t ? { 'If-Match': versionOf(t) } : {} }

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message) } }

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  if (init?.method && !['GET', 'HEAD'].includes(init.method) && !headers.has(REQUEST_ID_HEADER)) headers.set(REQUEST_ID_HEADER, newRequestId())
  const res = await fetch(url, { ...init, credentials: 'same-origin', headers })
  const body = (await res.json().catch(() => ({}))) as { error?: string } & T
  if (!res.ok) throw new ApiError(body.error ?? `${res.status} ${res.statusText}`, res.status)
  return body
}

function json(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function fetchState(): Promise<AppState> {
  return call<AppState>('/api/state')
}

export function authStatus(): Promise<{ authenticated: boolean; required: boolean }> { return call('/api/auth/status') }
export function signOut(): Promise<void> { return call('/api/session', { method: 'DELETE' }) }

export async function sendMessage(conversationId: string, text: string): Promise<Message> {
  return sendMessageFull(conversationId, { text })
}

export function stopRound(conversationId: string): Promise<unknown> {
  return call(`/api/conversations/${encodeURIComponent(conversationId)}/stop`, { method: 'POST' })
}

export function clearConversation(conversationId: string): Promise<unknown> {
  return call(`/api/conversations/${encodeURIComponent(conversationId)}/clear`, { method: 'POST' })
}

export function createConversation(name: string, memberIds: string[]): Promise<{ conversation: Conversation }> {
  return call('/api/conversations', json('POST', { name, memberIds }))
}

export function updateConversation(id: string, patch: { name?: string; memberIds?: string[]; pinned?: boolean; hidden?: boolean }): Promise<{ conversation: Conversation }> {
  return call(`/api/conversations/${encodeURIComponent(id)}`, json('PUT', patch))
}

export function deleteConversation(id: string): Promise<unknown> {
  return call(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function exportUrl(id: string): string {
  return `/api/conversations/${encodeURIComponent(id)}/export.md`
}

export type AgentPatch = Partial<Omit<Agent, 'id'>>

export function updateAgent(id: string, patch: AgentPatch): Promise<{ agent: Agent }> {
  return call(`/api/team/agents/${encodeURIComponent(id)}`, json('PUT', patch))
}

export function createAgent(agent: Agent): Promise<{ agent: Agent }> {
  return call('/api/team/agents', json('POST', agent))
}

export function duplicateAgent(id: string): Promise<{ agent: Agent }> {
  return call(`/api/team/agents/${encodeURIComponent(id)}/duplicate`, { method: 'POST' })
}

export function deleteAgent(id: string): Promise<unknown> {
  return call(`/api/team/agents/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function putMcpServer(name: string, def: McpServerDef): Promise<unknown> {
  return call(`/api/team/mcp/${encodeURIComponent(name)}`, json('PUT', def))
}

export function deleteMcpServer(name: string): Promise<unknown> {
  return call(`/api/team/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export function putProvider(id: string, def: Partial<ProviderDef>): Promise<unknown> {
  return call(`/api/team/providers/${encodeURIComponent(id)}`, json('PUT', def))
}

export function deleteProvider(id: string): Promise<unknown> {
  return call(`/api/team/providers/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function providerStatuses(force = false): Promise<ProviderStatus[]> {
  const data = await call<{ statuses: ProviderStatus[] }>(`/api/providers/status${force ? '?force=1' : ''}`)
  return data.statuses
}

/** Loads a model list only when a user opens/selects this provider. */
export function providerModels(providerId: string, force = false): Promise<ProviderModelCatalog> {
  return call(`/api/providers/${encodeURIComponent(providerId)}/models${force ? '?force=1' : ''}`)
}

export interface SettingsPatch {
  company?: string
  workspace?: string
  ownerName?: string
  ownerTitle?: string
  settings?: Partial<TeamSettings>
}

export function putSettings(patch: SettingsPatch): Promise<unknown> {
  return call('/api/team/settings', json('PUT', patch))
}

export function refreshAccount(): Promise<{ account: AccountStatus }> {
  return call('/api/account/refresh', { method: 'POST' })
}

export function openFile(path: string): Promise<unknown> {
  return call('/api/open', json('POST', { path }))
}

/** A stream echo (including a reconnect snapshot) acknowledges a send even if its POST reply was lost. */
export function acknowledgeMessage(message: Message): void {
  if (message.authorId !== 'user' || !message.requestId) return
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const slot = sessionStorage.key(i)
      if (slot?.startsWith(`ogb-pending-message:${message.conversationId}:`) && sessionStorage.getItem(slot) === message.requestId) sessionStorage.removeItem(slot)
    }
  } catch { /* storage may be disabled */ }
}

export async function sendMessageFull(conversationId: string, body: { text: string; attachments?: Attachment[]; replyTo?: Message['replyTo'] }): Promise<Message> {
  // Keep the same request id if this tab reloads or retries after losing the response.
  const slot = `ogb-pending-message:${conversationId}:${versionOf(body)}`
  let requestId = ''
  try { requestId = sessionStorage.getItem(slot) ?? '' } catch { /* private browsing may disable storage */ }
  if (!requestId) requestId = newRequestId()
  try { sessionStorage.setItem(slot, requestId) } catch { /* current request still has its id */ }
  const init = json('POST', body)
  try {
    const data = await call<{ message: Message }>(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, { ...init, headers: { ...init.headers, [REQUEST_ID_HEADER]: requestId } })
    try { sessionStorage.removeItem(slot) } catch { /* no saved request to clear */ }
    return data.message
  } catch (err) {
    // A 4xx is a definitive rejection; a transport failure may have succeeded server-side.
    if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
      try { sessionStorage.removeItem(slot) } catch { /* no saved request to clear */ }
    }
    throw err
  }
}

export async function uploadFile(conversationId: string, file: File): Promise<Attachment> {
  const res = await fetch(`/api/uploads/${encodeURIComponent(conversationId)}/${encodeURIComponent(file.name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': file.type || 'application/octet-stream', [REQUEST_ID_HEADER]: newRequestId() },
    body: file,
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string; attachment?: Attachment }
  if (!res.ok || !body.attachment) throw new Error(body.error ?? `upload ${res.status}`)
  return body.attachment
}

export function fileUrl(path: string): string {
  return `/api/file?path=${encodeURIComponent(path)}`
}

export function resolveApproval(id: string, allow: boolean, always = false): Promise<unknown> {
  return call(`/api/approvals/${encodeURIComponent(id)}`, json('POST', { allow, always }))
}

export async function getMemory(agentId: string): Promise<string> {
  const data = await call<{ notes: string }>(`/api/team/agents/${encodeURIComponent(agentId)}/memory`)
  return data.notes
}

export function putMemory(agentId: string, notes: string): Promise<unknown> {
  return call(`/api/team/agents/${encodeURIComponent(agentId)}/memory`, json('PUT', { notes }))
}

export function putSkill(id: string, skill: Skill): Promise<unknown> {
  return call(`/api/team/skills/${encodeURIComponent(id)}`, json('PUT', skill))
}

export function deleteSkill(id: string): Promise<unknown> {
  return call(`/api/team/skills/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function putRoutine(id: string, body: Pick<Routine, 'name' | 'agentId' | 'conversationId' | 'cron' | 'instruction' | 'enabled'>): Promise<{ routine: Routine }> {
  return call(`/api/routines/${encodeURIComponent(id)}`, json('PUT', body))
}

export function deleteRoutine(id: string): Promise<unknown> {
  return call(`/api/routines/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export function runRoutine(id: string): Promise<{ run: RoutineRun }> {
  return call(`/api/routines/${encodeURIComponent(id)}/run`, { method: 'POST' })
}

export async function cronPresets(): Promise<{ label: string; cron: string }[]> {
  const data = await call<{ presets: { label: string; cron: string }[] }>('/api/routines/presets')
  return data.presets
}

export function exportAgentUrl(id: string): string {
  return `/api/team/agents/${encodeURIComponent(id)}/export.json`
}

export function importAgent(agent: unknown): Promise<{ agent: Agent }> {
  return call('/api/team/agents/import', json('POST', { agent }))
}

// ---- projects ----

export async function suggestWorkspace(name: string): Promise<string> {
  const data = await call<{ workspace: string }>(`/api/projects/suggest-workspace?name=${encodeURIComponent(name)}`)
  return data.workspace
}

export interface NewProjectBody {
  name: string
  workspace: string
  memberIds: string[]
  brief?: string
  kickoff?: boolean
  decisionOwnerId?: string
  criticId?: string
}

export function createProject(body: NewProjectBody): Promise<{ project: Project; conversation: Conversation }> {
  return call('/api/projects', json('POST', body))
}

export function updateProject(id: string, patch: { name?: string; brief?: string; decisionOwnerId?: string; criticId?: string; finalReviewerId?: string }): Promise<{ project: Project }> {
  const init = json('PUT', patch)
  return call(`/api/projects/${encodeURIComponent(id)}`, { ...init, headers: { ...init.headers, ...projectVersion(id) } })
}

/** 'verification' takes { state: 'not-applicable' | 'overridden', reason }. */
export type ProjectAction = 'kickoff' | 'critique' | 'start' | 'pause' | 'stop' | 'resume' | 'verification' | 'archive'

export function projectAction(id: string, action: ProjectAction, body: Record<string, unknown> = {}): Promise<{ project: Project }> {
  const init = json('POST', body)
  return call(`/api/projects/${encodeURIComponent(id)}/${action}`, { ...init, headers: { ...init.headers, ...projectVersion(id) } })
}

export function resolveObjection(projectId: string, objectionId: string, disposition: 'accepted' | 'rejected' | 'unresolved', reason: string): Promise<{ project: Project }> {
  const init = json('POST', { disposition, reason })
  return call(`/api/projects/${encodeURIComponent(projectId)}/objections/${encodeURIComponent(objectionId)}/resolve`, {
    ...init,
    headers: { ...init.headers, ...projectVersion(projectId) },
  })
}

export interface TaskInput {
  title?: string
  description?: string
  ownerId?: string
  reviewerId?: string
  dependsOn?: string[]
  acceptance?: string[]
  kind?: TaskKind
  tier?: TaskTier
}

export function createTask(projectId: string, body: TaskInput): Promise<{ task: Task }> {
  return call(`/api/projects/${encodeURIComponent(projectId)}/tasks`, json('POST', body))
}

export function updateTask(projectId: string, taskId: string, body: TaskInput): Promise<{ task: Task }> {
  const init = json('PUT', body)
  return call(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { ...init, headers: { ...init.headers, ...taskVersion(projectId, taskId) } })
}

export function taskAction(projectId: string, taskId: string, action: 'retry' | 'cancel' | 'override', body: Record<string, unknown> = {}): Promise<{ task: Task }> {
  const init = json('POST', body)
  return call(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/${action}`, { ...init, headers: { ...init.headers, ...taskVersion(projectId, taskId) } })
}

export function applyTeamTemplate(templateId: string, assignments: Record<string, { provider: string; model: string; skip?: boolean }>, locale: string): Promise<{ added: string[]; memberIds: string[] }> {
  return call(`/api/team/templates/${encodeURIComponent(templateId)}`, json('POST', { assignments, locale }))
}

// ---- interrupt and correct ----

export function correct(conversationId: string, text: string, mode: CorrectionMode = 'continue'): Promise<{ correction: CorrectionRecord }> {
  return call(`/api/conversations/${encodeURIComponent(conversationId)}/correct`, json('POST', { text, mode }))
}

export function resumeCorrection(id: string): Promise<{ correction: CorrectionRecord }> {
  return call(`/api/corrections/${encodeURIComponent(id)}/resume`, { method: 'POST' })
}

// ---- avatars: "user" is the owner, anything else an employee id ----

export function uploadAvatar(target: string, file: File, fit: AvatarRef['fit']): Promise<{ avatar: AvatarRef }> {
  return call(`/api/avatars/${encodeURIComponent(target)}?fit=${fit}`, { method: 'PUT', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file })
}

export function refitAvatar(target: string, fit: AvatarRef['fit']): Promise<unknown> {
  return call(`/api/avatars/${encodeURIComponent(target)}/fit`, json('POST', { fit }))
}

export function resetAvatar(target: string): Promise<unknown> {
  return call(`/api/avatars/${encodeURIComponent(target)}`, { method: 'DELETE' })
}

// ---- dsh-pet ----

export interface PetStatusBody {
  /** Account represented by the original pet balance bubble; values come from the usage cache. */
  balanceAccount?: string
  status: { state: string; version: string; reason?: string; command?: string; animations?: number; desktop: string }
  settings: { enabled: boolean; follow: { kind: 'team' } | { kind: 'project' | 'agent'; id: string }; bridge: boolean; bubbles: boolean; overlay: boolean; locale: 'en' | 'zh-CN' }
}

export function petStatus(): Promise<PetStatusBody> {
  return call('/api/pet/status')
}

export function petStart(): Promise<PetStatusBody> {
  return call('/api/pet/start', { method: 'POST' })
}

export function petStop(): Promise<PetStatusBody> {
  return call('/api/pet/stop', { method: 'POST' })
}

export function petSettings(patch: Partial<PetStatusBody['settings']>): Promise<{ settings: PetStatusBody['settings'] }> {
  return call('/api/pet/settings', json('PUT', patch))
}

// ---- account usage (sanitized rows; credentials stay on the server) ----

export function fetchUsage(): Promise<UsageReport> {
  return call('/api/usage/accounts')
}

/** A manual refresh of every account with a source, or only `keys`. */
export function refreshUsage(keys?: string[]): Promise<UsageReport> {
  return call('/api/usage/refresh', json('POST', keys ? { keys } : {}))
}

export function cancelUsage(): Promise<{ cancelled: number }> {
  return call('/api/usage/cancel', json('POST', {}))
}

export function putUsageSettings(patch: Partial<UsageSettings>): Promise<{ settings: UsageSettings }> {
  return call('/api/usage/settings', json('PUT', patch))
}
