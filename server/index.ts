import express from 'express'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, constants as fsConstants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Account } from './account.js'
import { AvatarError, AvatarStore } from './avatars.js'
import { CorrectionLog, Corrector } from './correction.js'
import { PetBridge, PetSettingsStore } from './petbridge.js'
import { browserRoute, PET_PACKAGE, PET_ROUTE, PetRuntime, sameOriginWrite, type HelperLaunch } from './petruntime.js'
import { FAILED_MESSAGE, READY_MESSAGE } from './desktopdata.js'
import { lowNotice, UsageMeter } from './usagemeter.js'
import { usageRouter } from './usageroutes.js'
import { translate } from '../shared/i18n.js'
import { activitySnapshot, ActivityTracker, DONE_MS, streamEventFor } from './activity.js'
import { ActivityLedger } from './ledger.js'
import { Auth, loginPage, parseAllowedOrigins } from './auth.js'
import { EventHub } from './eventhub.js'
import { IdempotencyStore } from './idempotency.js'
import { Approvals } from './approvals.js'
import { CRON_PRESETS, nextRun } from './cron.js'
import { emit, subscribe } from './events.js'
import { mimeOf } from './files.js'
import { Memory } from './memory.js'
import { Orchestrator } from './orchestrator.js'
import { WorkspaceLocks } from './locks.js'
import { allowedRealFile as realFileInRoots, canonicalPath, isInside } from './paths.js'
import { checkWorkspace, parseCommand, suggestWorkspace, writeProjectFiles } from './projectio.js'
import { ProjectStore } from './projects.js'
import { providerStatuses } from './providers/index.js'
import { Routines } from './routines.js'
import { Store } from './store.js'
import { applyTemplate, loadTeam, parseAgent, parseMcpServer, parseProvider, parseSkill, parseTeam, saveTeam, TeamError } from './team.js'
import { summarizeUsage } from './usage.js'
import { projectContext, Workflow, WorkflowError } from './workflow.js'
import type { AppState, Attachment, Project, TaskKind, TaskTier, Team } from '../shared/types.js'
import { versionOf } from '../shared/sync.js'

const here = path.dirname(fileURLToPath(import.meta.url))
// Works both from server/ (tsx) and dist/server/ (built).
const root = existsSync(path.join(here, '..', 'team.example.json')) ? path.join(here, '..') : path.join(here, '..', '..')

const PORT = Number(process.env.PORT ?? 4310)
/** 127.0.0.1 by default. Set HOST=0.0.0.0 plus OPENGROKBOT_TOKEN to reach it from your phone or a VPS. */
const HOST = process.env.HOST ?? '127.0.0.1'
const TOKEN = process.env.OPENGROKBOT_TOKEN?.trim() || null
if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !TOKEN) {
  console.error('[opengrokbot] Refusing to listen on a non-local address without OPENGROKBOT_TOKEN. Set the token, or keep HOST=127.0.0.1.')
  process.exit(1)
}
/** Desktop mode: the Electron shell's per-launch nonce, echoed over IPC once we listen. Not passed on to any child. */
const INSTANCE_NONCE = process.env.OPENGROKBOT_INSTANCE_NONCE
delete process.env.OPENGROKBOT_INSTANCE_NONCE

/** OPENGROKBOT_TEAM / OPENGROKBOT_DATA let you run a second, separate office (demos, tests) from the same install. */
const teamFile = process.env.OPENGROKBOT_TEAM ? path.resolve(process.env.OPENGROKBOT_TEAM) : path.join(root, 'team.json')
if (!existsSync(teamFile)) {
  // A new office: start from the example (never replacing a file that exists); the team file will hold keys, so it is private.
  mkdirSync(path.dirname(teamFile), { recursive: true })
  try {
    copyFileSync(path.join(root, 'team.example.json'), teamFile, fsConstants.COPYFILE_EXCL)
    chmodSync(teamFile, 0o600)
  } catch (err) {
    if (!existsSync(teamFile)) throw err
  }
}
const dataDir = process.env.OPENGROKBOT_DATA ? path.resolve(process.env.OPENGROKBOT_DATA) : path.join(root, 'data')
const uploadsDir = path.join(dataDir, 'uploads')
mkdirSync(uploadsDir, { recursive: true })
let team = loadTeam(teamFile)
{
  // Files written before configurable helpers relied on Claude Haiku implicitly; parseTeam keeps that
  // behaviour, and saving makes it explicit (and changeable) in Settings instead of hidden.
  const raw = JSON.parse(readFileSync(teamFile, 'utf8')) as { settings?: Record<string, unknown> }
  if (!raw.settings || !('router' in raw.settings) || !('memory' in raw.settings)) saveTeam(teamFile, team)
}
mkdirSync(team.workspace, { recursive: true })
if (path.resolve(team.workspace) === path.resolve(root)) {
  console.warn('[opengrokbot] The default workspace is the Synodica app folder, so employees in ordinary chats can edit the app itself. Set a dedicated folder in Settings → General → Workspace folder. Projects always use their own folder.')
}
const store = new Store(dataDir)
store.seed(team)
const account = new Account(path.join(dataDir, 'account.json'))
const approvals = new Approvals()
const memory = new Memory(dataDir)
const projects = new ProjectStore(dataDir)
/** Today's observed working / waiting / idle time per employee (bounded, persisted). */
const ledger = new ActivityLedger(path.join(dataDir, 'activity-ledger.json'))
ledger.startCheckpoints()
const activity = new ActivityTracker(
  () => team,
  () => projects.list(),
  (a, day) => emit({ type: 'activity', activity: a, ...(day ? { ledger: day } : {}) }),
  { ledger, doneMs: DONE_MS },
)
const names = (id: string): string => (id === 'user' ? team.owner.name : (team.agents.find((a) => a.id === id)?.name ?? id))
/** One writer per real folder tree, shared by chat turns and workflow turns in every conversation. */
const locks = new WorkspaceLocks()
/** Project folders never overlap the app, its data or the team file (keys live there). */
const workspaceRules = { appRoot: root, denied: [dataDir, path.dirname(teamFile)] }
const orchestrator = new Orchestrator(() => team, store, account, approvals, memory, (p) => allowedFile(p), {
  activity,
  locks,
  projectFor: (conversationId) => {
    const p = projects.byConversation(conversationId)
    return p && !p.archived ? { id: p.id, workspace: p.workspace, context: projectContext(p, names) } : undefined
  },
  onReply: (conversationId, agentId, text) => {
    workflow.applyChatOps(conversationId, agentId, text)
  },
})
const sharedFileTimers = new Map<string, NodeJS.Timeout>()
const workflow: Workflow = new Workflow({
  getTeam: () => team,
  projects,
  locks,
  runTurn: (req) => orchestrator.runTaskTurn(req),
  members: (conversationId) => store.get(conversationId)?.memberIds.filter((m) => m !== 'user') ?? [],
  note: (conversationId, text) => {
    orchestrator.postNote(conversationId, text)
  },
  changed: (p) => {
    emit({ type: 'project', project: p })
    activity.refresh()
    // Shared brief / decisions / board for employees' tools, debounced.
    clearTimeout(sharedFileTimers.get(p.id))
    sharedFileTimers.set(
      p.id,
      setTimeout(() => {
        sharedFileTimers.delete(p.id)
        writeSharedFiles(p)
      }, 300),
    )
  },
})
for (const id of projects.recovered) {
  const p = projects.get(id)
  if (!p) continue
  const hit = p.tasks.filter((t) => t.state === 'interrupted').map((t) => t.id)
  orchestrator.postNote(p.conversationId, `The server restarted while work was in progress${hit.length ? ` (${hit.join(', ')})` : ''}. Nothing was re-run automatically. Check the workspace, then press Resume on the board.`)
}
const corrections = new CorrectionLog(dataDir)
const corrector = new Corrector({
  log: corrections,
  orchestrator,
  workflow,
  projects,
  approvals,
  emit: (correction) => emit({ type: 'correction', correction }),
})
for (const c of corrections.recovered) {
  orchestrator.postNote(c.conversationId, `Your correction was saved before the server restarted, and nothing old was re-run: "${c.text.slice(0, 200)}". ${c.projectId ? 'Press Resume on the board to continue with it.' : 'Press Continue in the composer to answer it.'}`)
}
const avatars = new AvatarStore(dataDir)

// ---- dsh-pet: the original upstream pet host, behind our access control ----
function ourElectron(): string | undefined {
  if (process.env.OPENGROKBOT_PET_ELECTRON) return path.resolve(process.env.OPENGROKBOT_PET_ELECTRON)
  try {
    const p = createRequire(import.meta.url)('electron') as unknown
    return typeof p === 'string' && existsSync(p) ? p : undefined
  } catch {
    return undefined
  }
}
const petSettings = new PetSettingsStore(dataDir)

// ---- account usage: quotas and balances from read-only sources (no model call), kept on the server ----
let usageEmitTimer: NodeJS.Timeout | undefined
let usagePetSummary: boolean | undefined
const usage = new UsageMeter({
  getTeam: () => team,
  dataDir,
  localUsage: () => summarizeUsage(store.list()),
  onChange: () => {
    // Coalesced: a refresh changes several rows in a burst.
    clearTimeout(usageEmitTimer)
    usageEmitTimer = setTimeout(() => {
      emit({ type: 'usage:account', report: usage.report() })
      // The pet menu shows "Quota summary" only while that setting is on.
      const s = usage.getSettings().petSummary
      if (usagePetSummary !== undefined && s !== usagePetSummary) void petBridge.sync().catch(() => {})
      usagePetSummary = s
    }, 150)
  },
  onLow: (row, windows) => {
    if (!usage.getSettings().petNotices) return
    const text = lowNotice(petSettings.get().locale, row, windows)
    if (text) void petBridge.notice(text).catch(() => {})
  },
})
usagePetSummary = usage.getSettings().petSummary
usage.start()

const pet = new PetRuntime({ appRoot: root, dataDir, ...(process.env.OPENGROKBOT_PET_PACKAGE_DIR ? { packageDir: process.env.OPENGROKBOT_PET_PACKAGE_DIR } : {}), ...(ourElectron() ? { electronPath: ourElectron() as string } : {}) })
const petBridge = new PetBridge({
  runtime: pet,
  snapshot: () => activitySnapshot(team, projects.list(), approvals.list(), activity),
  settings: () => petSettings.get(),
  setFollow: (follow) => {
    petSettings.update({ follow })
  },
  navigate: (hash) => emit({ type: 'pet:navigate', hash }),
  // Upstream third-party menu items: open the usage page, and (optional) say a short quota summary.
  // The summary is built at click time from sanitized rows: provider labels, windows, balances only.
  extraMenu: () => {
    const locale = petSettings.get().locale
    const items: { label: string; hash?: string; say?: () => string }[] = [{ label: translate(locale, 'pet.menu.openUsage'), hash: '#/usage' }]
    if (usage.getSettings().petSummary) items.push({ label: translate(locale, 'pet.menu.usageSummary'), say: () => usage.petSummary(locale) })
    return items
  },
})
let petSyncTimer: NodeJS.Timeout | undefined
subscribe((event) => {
  // Rows follow the team (providers, employees) and the locally observed usage.
  if (event.type === 'team' || event.type === 'usage') {
    clearTimeout(usageEmitTimer)
    usageEmitTimer = setTimeout(() => emit({ type: 'usage:account', report: usage.report() }), 150)
  }
})
subscribe((event) => {
  if (!['activity', 'project', 'approval:request', 'approval:resolved', 'team'].includes(event.type)) return
  clearTimeout(petSyncTimer)
  petSyncTimer = setTimeout(() => void petBridge.sync().catch((err: unknown) => console.warn('[pet] bridge:', err instanceof Error ? err.message : err)), 250)
})
if (petSettings.get().enabled) void pet.start().then((s) => console.log(`[pet] ${s.state}${s.reason ? `: ${s.reason}` : ''}`))
// Start observing every employee now, so today's ledger begins at server start, not at the first page load.
activity.refresh()
const routines = new Routines(dataDir, (r) => orchestrator.runRoutine(r))
routines.start()

function writeSharedFiles(p: Project): void {
  try {
    writeProjectFiles(p, names, workspaceRules)
  } catch (err) {
    console.warn(`[projects] could not write shared notes for ${p.id}:`, err instanceof Error ? err.message : err)
  }
}

const app = express()
app.disable('x-powered-by')

// ---- remote access (optional) ----
const auth = new Auth({ token: TOKEN, file: path.join(dataDir, 'sessions.json'), allowedOrigins: parseAllowedOrigins(process.env.OPENGROKBOT_ALLOWED_ORIGINS), trustProxy: process.env.OPENGROKBOT_TRUST_PROXY === '1' })
if (auth.opts.trustProxy) app.set('trust proxy', 'loopback')
const idempotency = new IdempotencyStore(path.join(dataDir, 'idempotency.json'))
let draining = false
app.use(auth.middleware(loginPage))
app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.get('/readyz', (_req, res) => res.status(draining ? 503 : 200).json({ ready: !draining }))
app.get('/api/auth/status', (req, res) => res.json({ authenticated: !auth.required || !!auth.identify(req), required: auth.required }))
app.get('/api/session', (req, res) => res.json({ authenticated: !auth.required || !!auth.identify(req), required: auth.required }))
app.post('/api/auth/login', express.json({ limit: '16kb' }), (req, res) => auth.login(req, res))
app.post('/api/session', express.json({ limit: '16kb' }), express.urlencoded({ extended: false, limit: '16kb' }), (req, res) => auth.login(req, res))
app.delete('/api/session', (req, res) => auth.logout(req, res))
app.use((req, res, next) => {
  if (draining && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return res.status(503).json({ error: 'server restarting', code: 'draining' })
  next()
})

// The upstream pet's routes, after our access control and before any body parser: the request is
// policy-checked (route, method, path, same origin) and streamed to the loopback pet host.
app.use(PET_ROUTE, (req, res) => {
  const method = req.method ?? 'GET'
  const decision = browserRoute(method, req.originalUrl)
  if (!decision.ok) {
    res.status(decision.status).json(decision.body)
    return
  }
  if (!sameOriginWrite(method, req.headers)) {
    res.status(403).json({ error: 'cross-site pet request refused' })
    return
  }
  pet.forward(req, res, decision)
})

app.use(express.json({ limit: '2mb' }))
app.use(idempotency.middleware())

// ---- pet runtime control (status, start / stop, our settings, the upstream browser half) ----
// An App can keep local work running while viewing another office. This is temporary display state,
// not the user's saved enabled preference; a fresh local server starts active again.
let desktopPetActive = true

app.get('/api/pet/status', (_req, res) => {
  res.json({ status: pet.status(), settings: petSettings.get(), package: PET_PACKAGE })
})

app.post('/api/pet/start', async (_req, res) => {
  petSettings.update({ enabled: true })
  const status = desktopPetActive ? await pet.start() : pet.status()
  if (status.state === 'running') void petBridge.sync().catch(() => {})
  res.json({ status, settings: petSettings.get() })
})

app.post('/api/pet/stop', async (_req, res) => {
  petSettings.update({ enabled: false })
  const status = await pet.stop()
  // Whatever was published belonged to the stopped host; the next host gets the full current state.
  petBridge.invalidate()
  res.json({ status, settings: petSettings.get() })
})

app.post('/api/pet/desktop', async (req, res) => {
  if (!INSTANCE_NONCE) { res.status(404).json({ error: 'desktop office is not running' }); return }
  if (typeof req.body?.active !== 'boolean') { res.status(400).json({ error: 'active must be a boolean' }); return }
  desktopPetActive = req.body.active
  const status = desktopPetActive && petSettings.get().enabled ? await pet.start() : await pet.stop()
  if (status.state === 'running') void petBridge.sync().catch(() => {})
  else petBridge.invalidate()
  res.json({ status, settings: petSettings.get() })
})

app.put('/api/pet/settings', (req, res) => {
  const { enabled: _ignored, ...patch } = (req.body ?? {}) as Record<string, unknown>
  const settings = petSettings.update(patch)
  void petBridge.sync().catch(() => {})
  res.json({ settings })
})

/** lib/client.js of the pinned package, unmodified (the in-page overlay and its settings page). */
app.get('/api/pet/client.js', (_req, res) => {
  const file = pet.clientScript()
  if (!file) {
    res.status(404).json({ error: 'the dsh-pet package is not installed', status: pet.status() })
    return
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'no-cache')
  res.type('text/javascript').sendFile(file)
})

/** API keys never leave the server. */
function publicTeam(t: Team): Team {
  const providers: Team['providers'] = {}
  for (const [id, p] of Object.entries(t.providers)) providers[id] = { ...p, ...(p.apiKey ? { apiKey: '••••' } : {}) }
  return { ...t, providers }
}

function state(): AppState {
  return { team: publicTeam(team), conversations: store.list(), busy: orchestrator.busyIds(), usage: summarizeUsage(store.list()), account: account.get(), routines: routines.list(), approvals: approvals.list(), projects: projects.list(), activity: activity.list(), ledger: activity.ledgers(), providerChecks: activity.providerChecks(), serverNow: Date.now(), corrections: corrections.list().slice(-50) }
}
const eventhub = new EventHub({ subscribe, snapshot: state })

function checkVersion(req: express.Request, res: express.Response, value: unknown): boolean {
  const expected = req.headers['if-match']
  if (expected === undefined) return true
  if (expected === versionOf(value)) return true
  res.status(409).json({ error: 'changed on another device; refresh and try again', code: 'conflict' })
  return false
}

/** Validate a whole new team, persist it, reseed conversations, and broadcast. */
function applyTeam(next: Team): void {
  saveTeam(teamFile, next)
  team = next
  mkdirSync(team.workspace, { recursive: true })
  store.seed(team)
  emit({ type: 'team', team: publicTeam(team), conversations: store.list() })
  ledger.retain(team.agents.map((a) => a.id))
  activity.refresh()
}

function broadcastConversations(): void {
  emit({ type: 'team', team: publicTeam(team), conversations: store.list() })
}

function teamError(res: express.Response, err: unknown): void {
  if (err instanceof TeamError) res.status(400).json({ error: err.message })
  else res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

/**
 * The real path of a file employees may show you, or undefined: it must exist and its *real* path
 * (symlinks resolved) must be inside the real workspace, an employee's folder, a project folder or
 * uploads. The team file and the data folder (other than uploads) are never served, even when the
 * workspace contains them.
 */
function allowedRealFile(p: string): string | undefined {
  const roots = [team.workspace, uploadsDir, ...team.agents.map((a) => a.cwd).filter((c): c is string => typeof c === 'string').map((c) => path.resolve(team.workspace, c)), ...projects.list().map((x) => x.workspace)]
  const real = realFileInRoots(p, roots, [teamFile])
  if (!real) return undefined
  if (isInside(real, canonicalPath(dataDir)) && !isInside(real, canonicalPath(uploadsDir))) return undefined
  return real
}

function allowedFile(p: string): boolean {
  return allowedRealFile(p) !== undefined
}

function workflowError(res: express.Response, err: unknown): void {
  if (err instanceof WorkflowError) res.status(err.status).json({ error: err.message })
  else if (err instanceof TeamError) res.status(400).json({ error: err.message })
  else res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean) : [])

app.get('/api/state', (_req, res) => {
  res.json(state())
})

// ---- conversations ----

app.post('/api/conversations', (req, res) => {
  const body = (req.body ?? {}) as { name?: unknown; memberIds?: unknown }
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'New chat'
  const memberIds = Array.isArray(body.memberIds) ? body.memberIds.filter((m): m is string => typeof m === 'string' && team.agents.some((a) => a.id === m)) : []
  if (memberIds.length === 0) {
    res.status(400).json({ error: 'pick at least one employee' })
    return
  }
  const c = store.createGroup(name, memberIds)
  broadcastConversations()
  res.json({ conversation: c })
})

app.put('/api/conversations/:id', (req, res) => {
  const id = String(req.params.id)
  const body = (req.body ?? {}) as { name?: unknown; memberIds?: unknown; pinned?: unknown; hidden?: unknown }
  const patch: { name?: string; memberIds?: string[]; pinned?: boolean; hidden?: boolean } = {}
  if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
  if (Array.isArray(body.memberIds)) patch.memberIds = body.memberIds.filter((m): m is string => typeof m === 'string' && team.agents.some((a) => a.id === m))
  if (typeof body.pinned === 'boolean') patch.pinned = body.pinned
  if (typeof body.hidden === 'boolean') patch.hidden = body.hidden
  const c = store.update(id, patch)
  if (!c) {
    res.status(404).json({ error: 'unknown conversation' })
    return
  }
  broadcastConversations()
  res.json({ conversation: c })
})

app.delete('/api/conversations/:id', (req, res) => {
  const id = String(req.params.id)
  if (orchestrator.isBusy(id)) {
    res.status(409).json({ error: 'stop the running round first' })
    return
  }
  if (!store.delete(id)) {
    res.status(400).json({ error: 'only extra group chats can be deleted' })
    return
  }
  broadcastConversations()
  emit({ type: 'usage', usage: summarizeUsage(store.list()) })
  res.json({ ok: true })
})

app.post('/api/conversations/:id/messages', (req, res) => {
  const id = String(req.params.id)
  const body = (req.body ?? {}) as { text?: unknown; attachments?: unknown; replyTo?: unknown }
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!store.get(id)) {
    res.status(404).json({ error: 'unknown conversation' })
    return
  }
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter((a): a is Attachment => typeof a === 'object' && a !== null && typeof (a as Attachment).path === 'string' && allowedFile((a as Attachment).path))
    : []
  if (text.length === 0 && attachments.length === 0) {
    res.status(400).json({ error: 'empty message' })
    return
  }
  const rt = body.replyTo as { messageId?: unknown; authorId?: unknown; excerpt?: unknown } | undefined
  const replyTo = rt && typeof rt.messageId === 'string' && typeof rt.authorId === 'string' && typeof rt.excerpt === 'string' ? { messageId: rt.messageId, authorId: rt.authorId, excerpt: rt.excerpt.slice(0, 200) } : undefined
  const requestId = req.get('Idempotency-Key')
  // In a project chat, /kickoff, /critique and /start drive the workflow instead of starting a chat round.
  const project = projects.byConversation(id)
  const command = project && !project.archived ? parseCommand(text) : null
  if (project && command) {
    try {
      const files = attachments.length ? `\n(attached files: ${attachments.map((a) => a.path).join(', ')})` : ''
      if (command.name === 'kickoff') workflow.kickoff(project.id, command.rest + files)
      else if (command.name === 'critique') workflow.critique(project.id)
      else workflow.start(project.id)
      const message = orchestrator.record(id, text, { attachments, requestId })
      res.json({ message })
    } catch (err) {
      workflowError(res, err)
    }
    return
  }
  const message = orchestrator.post(id, text || '(see attached files)', { attachments, requestId, ...(replyTo ? { replyTo } : {}) })
  res.json({ message })
})

app.post('/api/conversations/:id/stop', (req, res) => {
  const id = String(req.params.id)
  orchestrator.stop(id)
  const project = projects.byConversation(id)
  if (project && workflow.isRunning(project.id)) workflow.stop(project.id)
  res.json({ ok: true })
})

/**
 * Interrupt and correct: persist the correction, stop the running turn / workflow step, and continue
 * with the corrected intent once the old run has really stopped. Answers at once with the record
 * (status "stopping" or "stopped"); later status changes arrive as "correction" events.
 */
app.post('/api/conversations/:id/correct', (req, res) => {
  const id = String(req.params.id)
  if (!store.get(id)) {
    res.status(404).json({ error: 'unknown conversation' })
    return
  }
  const b = (req.body ?? {}) as { text?: unknown; mode?: unknown }
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text) {
    res.status(400).json({ error: 'write the correction' })
    return
  }
  if (text.length > 20000) {
    res.status(400).json({ error: 'the correction is too long' })
    return
  }
  try {
    const correction = corrector.correct(id, text, { mode: b.mode === 'replan' ? 'replan' : 'continue' })
    res.json({ correction })
  } catch (err) {
    workflowError(res, err)
  }
})

app.post('/api/corrections/:id/resume', (req, res) => {
  try {
    res.json({ correction: corrector.resume(String(req.params.id)) })
  } catch (err) {
    res.status(409).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.post('/api/conversations/:id/clear', (req, res) => {
  const id = String(req.params.id)
  if (orchestrator.isBusy(id)) {
    res.status(409).json({ error: 'stop the running round first' })
    return
  }
  if (!store.clear(id)) {
    res.status(404).json({ error: 'unknown conversation' })
    return
  }
  broadcastConversations()
  emit({ type: 'usage', usage: summarizeUsage(store.list()) })
  res.json({ ok: true })
})

app.get('/api/conversations/:id/export.md', (req, res) => {
  const c = store.get(String(req.params.id))
  if (!c) {
    res.status(404).send('unknown conversation')
    return
  }
  const names = new Map<string, string>([['user', team.owner.name], ['routine', 'Routine'], ['workflow', 'Workflow']])
  for (const a of team.agents) names.set(a.id, `${a.name} | ${a.role}`)
  const lines = [`# ${c.kind === 'group' ? c.name : `DM with ${names.get(c.memberIds.find((m) => m !== 'user') ?? '') ?? c.name}`}`, '']
  for (const m of c.messages) {
    lines.push(`**${names.get(m.authorId) ?? m.authorId}** · ${new Date(m.createdAt).toLocaleString()}`, '', m.text, '')
  }
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="${c.id}.md"`)
  res.send(lines.join('\n'))
})

// ---- files: uploads, previews, open ----

/** Raw-body upload: PUT the file bytes, get an Attachment back. */
app.put('/api/uploads/:conversationId/:name', express.raw({ type: () => true, limit: '60mb' }), (req, res) => {
  const conv = String(req.params.conversationId).replace(/[^a-z0-9_-]/gi, '')
  const safe = String(req.params.name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 120) || 'file'
  const dir = path.join(uploadsDir, conv)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const file = path.join(dir, `${stamp}-${safe}`)
  const body = req.body as Buffer
  if (!Buffer.isBuffer(body) || body.length === 0) {
    res.status(400).json({ error: 'empty upload' })
    return
  }
  writeFileSync(file, body)
  const headerMime = String(req.headers['content-type'] ?? '')
  const attachment: Attachment = { name: safe, path: file, mime: headerMime && headerMime !== 'application/octet-stream' ? headerMime : mimeOf(file), size: body.length }
  res.json({ attachment })
})

/** Serve a produced or uploaded file for inline preview (images, html, text, pdf). */
app.get('/api/file', (req, res) => {
  const asked = typeof req.query.path === 'string' ? req.query.path : ''
  // Serve the checked real path itself, so a symlink swapped in after the check is not followed.
  const p = allowedRealFile(asked)
  if (!p || !statSync(p).isFile()) {
    res.status(404).send('not found')
    return
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Type', mimeOf(p) + (mimeOf(p).startsWith('text/') || mimeOf(p) === 'application/json' ? '; charset=utf-8' : ''))
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${path.basename(asked)}"`)
  res.sendFile(p)
})

/**
 * Open a file an employee produced with the OS default app (browser for .html). Local app, local
 * disk. Same rule as previews: only real files inside the allowed folders, never arbitrary paths.
 */
app.post('/api/open', (req, res) => {
  const asked = typeof req.body?.path === 'string' ? req.body.path.trim() : ''
  const p = asked ? allowedRealFile(asked) : undefined
  if (!p) {
    res.status(400).json({ error: 'file not found or not inside a workspace, project or uploads folder' })
    return
  }
  const cmd = process.platform === 'win32' ? (['cmd', ['/c', 'start', '', p]] as const) : process.platform === 'darwin' ? (['open', [p]] as const) : (['xdg-open', [p]] as const)
  try {
    spawn(cmd[0], [...cmd[1]], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

// ---- projects ----

app.get('/api/projects/suggest-workspace', (req, res) => {
  res.json({ workspace: suggestWorkspace(typeof req.query.name === 'string' ? req.query.name : 'project') })
})

app.post('/api/projects', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  const name = str(b.name).trim()
  if (!name) {
    res.status(400).json({ error: 'give the project a name' })
    return
  }
  const memberIds = list(b.memberIds).filter((m) => team.agents.some((a) => a.id === m))
  if (memberIds.length < 2) {
    res.status(400).json({ error: 'a project needs at least two employees, so work can be reviewed by someone other than its author' })
    return
  }
  const ws = checkWorkspace(str(b.workspace) || suggestWorkspace(name), workspaceRules)
  if (!ws.ok) {
    res.status(400).json({ error: ws.error })
    return
  }
  try {
    const conversation = store.createGroup(name, memberIds)
    const project = workflow.create({ name, workspace: ws.path, conversationId: conversation.id, brief: str(b.brief), ...(str(b.decisionOwnerId) ? { decisionOwnerId: str(b.decisionOwnerId) } : {}), ...(str(b.criticId) ? { criticId: str(b.criticId) } : {}) })
    store.linkProject(conversation.id, project.id)
    broadcastConversations()
    orchestrator.postNote(conversation.id, `Project "${project.name}" created in ${project.workspace}. Decision owner: ${project.decisionOwnerId ? names(project.decisionOwnerId) : 'none'}; critic: ${project.criticId ? names(project.criticId) : 'none'}. Describe what to build and press Kickoff (or type /kickoff <request>).`)
    let started = project
    if (b.kickoff === true && project.brief) {
      orchestrator.record(conversation.id, project.brief)
      started = workflow.kickoff(project.id, '')
    }
    res.json({ project: started, conversation: store.get(conversation.id) })
  } catch (err) {
    workflowError(res, err)
  }
})

app.put('/api/projects/:id', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const current = projects.get(String(req.params.id))
    if (current && !checkVersion(req, res, current)) return
    const project = workflow.update(String(req.params.id), { ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.brief === 'string' ? { brief: b.brief } : {}), ...(typeof b.decisionOwnerId === 'string' ? { decisionOwnerId: b.decisionOwnerId } : {}), ...(typeof b.criticId === 'string' ? { criticId: b.criticId } : {}), ...(typeof b.finalReviewerId === 'string' ? { finalReviewerId: b.finalReviewerId } : {}) })
    res.json({ project })
  } catch (err) {
    workflowError(res, err)
  }
})

app.post('/api/projects/:id/:action', (req, res, next) => {
  const id = String(req.params.id)
  const action = String(req.params.action)
  if (action === 'tasks') return next()
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const p = projects.get(id)
    if (!p) throw new WorkflowError('unknown project', 404)
    if (action !== 'stop' && action !== 'pause' && !checkVersion(req, res, p)) return
    let project: Project
    switch (action) {
      case 'kickoff': {
        const text = str(b.text).trim()
        if (text) orchestrator.record(p.conversationId, `/kickoff ${text}`)
        project = workflow.kickoff(id, text)
        break
      }
      case 'critique':
        project = workflow.critique(id)
        break
      case 'start':
        project = workflow.start(id)
        break
      case 'pause':
        project = workflow.pause(id)
        break
      case 'stop':
        orchestrator.stop(p.conversationId)
        project = workflow.stop(id)
        break
      case 'resume':
        project = workflow.resume(id)
        break
      case 'verification': {
        const state = str(b.state)
        if (state !== 'not-applicable' && state !== 'overridden') throw new WorkflowError('state must be "not-applicable" or "overridden"')
        project = workflow.setVerification(id, state, str(b.reason))
        break
      }
      case 'archive':
        if (workflow.isRunning(id)) workflow.stop(id)
        project = projects.update(id, (x) => {
          x.archived = true
          x.paused = true
        })
        store.update(p.conversationId, { hidden: true })
        emit({ type: 'project', project })
        broadcastConversations()
        break
      default:
        throw new WorkflowError(`unknown project action ${action}`, 404)
    }
    res.json({ project })
  } catch (err) {
    workflowError(res, err)
  }
})

const KINDS = new Set(['implement', 'test', 'docs', 'design', 'research', 'fix'])
const TIERS = new Set(['routine', 'standard', 'critical'])

app.post('/api/projects/:id/objections/:objectionId/resolve', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const current = projects.get(String(req.params.id))
    if (current && !checkVersion(req, res, current)) return
    const disposition = str(b.disposition)
    if (disposition !== 'accepted' && disposition !== 'rejected' && disposition !== 'unresolved') throw new WorkflowError('disposition must be accepted, rejected or unresolved')
    res.json({ project: workflow.resolveObjection(String(req.params.id), String(req.params.objectionId), disposition, str(b.reason)) })
  } catch (err) { workflowError(res, err) }
})

app.post('/api/projects/:id/tasks', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const task = workflow.createTask(String(req.params.id), {
      title: str(b.title),
      description: str(b.description),
      ownerId: str(b.ownerId),
      ...(str(b.reviewerId) ? { reviewerId: str(b.reviewerId) } : {}),
      dependsOn: list(b.dependsOn),
      acceptance: list(b.acceptance),
      ...(KINDS.has(str(b.kind)) ? { kind: str(b.kind) as TaskKind } : {}),
      ...(TIERS.has(str(b.tier)) ? { tier: str(b.tier) as TaskTier } : {}),
    })
    res.json({ task })
  } catch (err) {
    workflowError(res, err)
  }
})

app.put('/api/projects/:id/tasks/:taskId', (req, res) => {
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const current = projects.get(String(req.params.id))?.tasks.find((t) => t.id === String(req.params.taskId))
    if (current && !checkVersion(req, res, current)) return
    const task = workflow.updateTask(String(req.params.id), String(req.params.taskId), {
      ...(typeof b.title === 'string' ? { title: b.title } : {}),
      ...(typeof b.description === 'string' ? { description: b.description } : {}),
      ...(typeof b.ownerId === 'string' && b.ownerId ? { ownerId: b.ownerId } : {}),
      ...(typeof b.reviewerId === 'string' && b.reviewerId ? { reviewerId: b.reviewerId } : {}),
      ...(Array.isArray(b.dependsOn) ? { dependsOn: list(b.dependsOn) } : {}),
      ...(Array.isArray(b.acceptance) ? { acceptance: list(b.acceptance) } : {}),
      ...(TIERS.has(str(b.tier)) ? { tier: str(b.tier) as TaskTier } : {}),
    })
    res.json({ task })
  } catch (err) {
    workflowError(res, err)
  }
})

app.post('/api/projects/:id/tasks/:taskId/:action', (req, res) => {
  const id = String(req.params.id)
  const taskId = String(req.params.taskId)
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const current = projects.get(id)?.tasks.find((t) => t.id === taskId)
    if (req.params.action !== 'cancel' && current && !checkVersion(req, res, current)) return
    let task
    switch (String(req.params.action)) {
      case 'retry':
      case 'resume':
        task = workflow.retryTask(id, taskId)
        break
      case 'cancel':
        task = workflow.cancelTask(id, taskId, str(b.reason))
        break
      case 'override': {
        const verdict = str(b.verdict)
        if (verdict !== 'accept' && verdict !== 'reject') throw new WorkflowError('verdict must be accept or reject')
        task = workflow.overrideTask(id, taskId, verdict, str(b.reason))
        break
      }
      default:
        throw new WorkflowError('unknown task action', 404)
    }
    res.json({ task })
  } catch (err) {
    workflowError(res, err)
  }
})

// ---- team template ----

/** Save or reuse a preset with the chosen providers. Existing employees and settings stay intact. */
app.post('/api/team/templates/:templateId', (req, res) => {
  const b = (req.body ?? {}) as { assignments?: unknown; locale?: unknown }
  try {
    const assignments = (typeof b.assignments === 'object' && b.assignments !== null ? b.assignments : {}) as Record<string, { provider?: unknown; model?: unknown; skip?: unknown }>
    const { team: next, added, memberIds } = applyTemplate(team, assignments, String(req.params.templateId), b.locale === 'zh-CN' ? 'zh-CN' : 'en')
    applyTeam(parseTeam(next, root))
    res.json({ added, memberIds })
  } catch (err) {
    teamError(res, err)
  }
})

// ---- approvals ----

app.post('/api/approvals/:id', (req, res) => {
  const id = String(req.params.id)
  const body = (req.body ?? {}) as { allow?: unknown; always?: unknown }
  const allow = body.allow === true
  const request = approvals.resolve(id, allow)
  if (!request) {
    const stale = approvals.staleReason(id)
    if (stale) res.status(409).json({ error: `This approval is stale: ${stale}`, stale: true, code: 'conflict' })
    else res.status(409).json({ error: 'This approval is no longer pending', code: 'conflict' })
    return
  }
  if (allow && body.always === true) {
    const rule = { id: randomUUID().slice(0, 8), action: 'allow' as const, tool: request.tool }
    try {
      applyTeam(parseTeam({ ...team, settings: { ...team.settings, autoReview: [...team.settings.autoReview, rule] } }, root))
    } catch (err) {
      teamError(res, err)
      return
    }
  }
  res.json({ ok: true })
})

// ---- memory ----

/** ?project=<id> selects that project's notes; without it, the notes used in ordinary chats. */
function memoryScope(req: express.Request): string | undefined {
  const p = typeof req.query.project === 'string' ? req.query.project : ''
  return p && projects.get(p) ? p : undefined
}

app.get('/api/team/agents/:id/memory', (req, res) => {
  res.json({ notes: memory.read(String(req.params.id), memoryScope(req)) })
})

app.put('/api/team/agents/:id/memory', (req, res) => {
  const id = String(req.params.id)
  if (!team.agents.some((a) => a.id === id)) {
    res.status(404).json({ error: 'unknown employee' })
    return
  }
  const notes = typeof req.body?.notes === 'string' ? req.body.notes : ''
  const scope = memoryScope(req)
  if (notes.trim()) memory.write(id, notes, scope)
  else memory.clear(id, scope)
  res.json({ ok: true })
})

// ---- avatars (employees and the owner "user") ----

/** Raw image bytes (PUT) upload or replace; the type is decided from the bytes, never the header. */
app.put('/api/avatars/:target', express.raw({ type: () => true, limit: '2100kb' }), (req, res) => {
  const target = String(req.params.target)
  try {
    const body = req.body as Buffer
    if (!Buffer.isBuffer(body) || body.length === 0) throw new AvatarError('empty upload')
    const next = avatars.assign(team, target, body, req.query.fit)
    applyTeam(parseTeam(next.team, root))
    next.commit()
    res.json({ avatar: next.ref })
  } catch (err) {
    if (err instanceof AvatarError) res.status(err.status).json({ error: err.message })
    else teamError(res, err)
  }
})

/** Change how the image fits (cover = crop to fill, contain = whole image). */
app.post('/api/avatars/:target/fit', (req, res) => {
  try {
    applyTeam(parseTeam(avatars.refit(team, String(req.params.target), req.body?.fit), root))
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof AvatarError) res.status(err.status).json({ error: err.message })
    else teamError(res, err)
  }
})

/** Reset to the color-and-shape face; the stored file is deleted. */
app.delete('/api/avatars/:target', (req, res) => {
  try {
    const next = avatars.assign(team, String(req.params.target), undefined, undefined)
    applyTeam(parseTeam(next.team, root))
    next.commit()
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof AvatarError) res.status(err.status).json({ error: err.message })
    else teamError(res, err)
  }
})

/** Serve an approved avatar by generated id only. */
app.get('/api/avatars/:id', (req, res) => {
  const hit = avatars.find(String(req.params.id))
  if (!hit) {
    res.status(404).send('not found')
    return
  }
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Content-Security-Policy', "default-src 'none'")
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable')
  res.type(hit.mime).sendFile(hit.file)
})

// ---- team editing ----

app.put('/api/team/agents/:id', (req, res) => {
  const id = String(req.params.id)
  const current = team.agents.find((a) => a.id === id)
  if (!current) {
    res.status(404).json({ error: 'unknown employee' })
    return
  }
  try {
    const patched = parseAgent({ ...current, ...(req.body as object), id }, current.name)
    const next: Team = { ...team, agents: team.agents.map((a) => (a.id === id ? patched : a)) }
    applyTeam(parseTeam(next, root))
    res.json({ agent: patched })
  } catch (err) {
    teamError(res, err)
  }
})

app.post('/api/team/agents', (req, res) => {
  try {
    const agent = parseAgent(req.body, 'new employee')
    if (team.agents.some((a) => a.id === agent.id)) throw new TeamError(`team: an employee with id "${agent.id}" already exists`)
    applyTeam(parseTeam({ ...team, agents: [...team.agents, agent] }, root))
    res.json({ agent })
  } catch (err) {
    teamError(res, err)
  }
})

app.post('/api/team/agents/import', (req, res) => {
  try {
    const body = (req.body ?? {}) as { agent?: unknown }
    const raw = (typeof body.agent === 'object' && body.agent !== null ? body.agent : req.body) as Record<string, unknown>
    let id = typeof raw.id === 'string' ? raw.id : ''
    let n = 2
    const base = id || 'employee'
    while (!id || team.agents.some((a) => a.id === id)) id = `${base}-${n++}`
    let name = typeof raw.name === 'string' ? raw.name : 'NEW'
    while (team.agents.some((a) => a.name.toUpperCase() === name.toUpperCase())) name = `${name} 2`
    const agent = parseAgent({ ...raw, id, name, templateSeat: undefined, provider: typeof raw.provider === 'string' && raw.provider in team.providers ? raw.provider : 'claude', mcpServers: [] }, 'import')
    applyTeam(parseTeam({ ...team, agents: [...team.agents, agent] }, root))
    res.json({ agent })
  } catch (err) {
    teamError(res, err)
  }
})

app.post('/api/team/agents/:id/duplicate', (req, res) => {
  const source = team.agents.find((a) => a.id === String(req.params.id))
  if (!source) {
    res.status(404).json({ error: 'unknown employee' })
    return
  }
  try {
    let n = 2
    while (team.agents.some((a) => a.id === `${source.id}-${n}`)) n++
    const copy = parseAgent({ ...source, id: `${source.id}-${n}`, name: `${source.name} ${n}`, templateSeat: undefined }, 'copy')
    applyTeam(parseTeam({ ...team, agents: [...team.agents, copy] }, root))
    res.json({ agent: copy })
  } catch (err) {
    teamError(res, err)
  }
})

/** Shareable employee file. Employees hold no secrets; provider and MCP links are reset on import. */
app.get('/api/team/agents/:id/export.json', (req, res) => {
  const a = team.agents.find((x) => x.id === String(req.params.id))
  if (!a) {
    res.status(404).json({ error: 'unknown employee' })
    return
  }
  const { cwd: _cwd, templateSeat: _templateSeat, ...rest } = a
  res.setHeader('Content-Disposition', `attachment; filename="${a.id}.opengrokbot.json"`)
  res.json({ opengrokbot: 1, agent: { ...rest, provider: 'claude', mcpServers: [] } })
})

app.delete('/api/team/agents/:id', (req, res) => {
  const id = String(req.params.id)
  if (!team.agents.some((a) => a.id === id)) {
    res.status(404).json({ error: 'unknown employee' })
    return
  }
  try {
    applyTeam(parseTeam({ ...team, agents: team.agents.filter((a) => a.id !== id) }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

app.put('/api/team/mcp/:name', (req, res) => {
  const name = String(req.params.name)
  try {
    const def = parseMcpServer(req.body, name)
    applyTeam(parseTeam({ ...team, mcpServers: { ...team.mcpServers, [name]: def } }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

app.delete('/api/team/mcp/:name', (req, res) => {
  const name = String(req.params.name)
  const { [name]: _removed, ...rest } = team.mcpServers
  try {
    const agents = team.agents.map((a) => ({ ...a, mcpServers: a.mcpServers.filter((s) => s !== name) }))
    applyTeam(parseTeam({ ...team, mcpServers: rest, agents }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

// ---- skills ----

app.put('/api/team/skills/:id', (req, res) => {
  const id = String(req.params.id)
  try {
    const skill = parseSkill(req.body, id)
    applyTeam(parseTeam({ ...team, skills: { ...team.skills, [id]: skill } }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

app.delete('/api/team/skills/:id', (req, res) => {
  const { [String(req.params.id)]: _removed, ...rest } = team.skills
  try {
    applyTeam(parseTeam({ ...team, skills: rest }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

// ---- providers ----

app.get('/api/providers/status', async (req, res) => {
  try {
    const statuses = await providerStatuses(team, req.query.force === '1')
    // Employees on a provider that failed its check show as offline, with the reason.
    emit({ type: 'providers', checks: activity.providerStatuses(statuses) })
    res.json({ statuses })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.put('/api/team/providers/:id', (req, res) => {
  const id = String(req.params.id)
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const current = team.providers[id]
    // "••••" means "keep the stored key".
    const apiKey = body.apiKey === '••••' ? current?.apiKey : body.apiKey
    const def = parseProvider({ ...(current ?? {}), ...body, apiKey }, id)
    if (current && current.kind !== def.kind && ['claude', 'codex', 'gemini'].includes(id)) throw new TeamError('team: built-in providers keep their kind')
    applyTeam(parseTeam({ ...team, providers: { ...team.providers, [id]: def } }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

app.delete('/api/team/providers/:id', (req, res) => {
  const id = String(req.params.id)
  if (['claude', 'codex', 'gemini'].includes(id)) {
    res.status(400).json({ error: 'built-in providers cannot be removed' })
    return
  }
  if (team.agents.some((a) => a.provider === id)) {
    res.status(409).json({ error: 'an employee still uses this provider' })
    return
  }
  const { [id]: _removed, ...rest } = team.providers
  try {
    applyTeam(parseTeam({ ...team, providers: rest }, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

app.put('/api/team/settings', (req, res) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>
    const next = {
      ...team,
      company: typeof body.company === 'string' && body.company.trim() ? body.company.trim() : team.company,
      workspace: typeof body.workspace === 'string' && body.workspace.trim() ? body.workspace.trim() : team.workspace,
      owner: { ...team.owner, ...(typeof body.ownerName === 'string' && body.ownerName.trim() ? { name: body.ownerName.trim() } : {}), ...(typeof body.ownerTitle === 'string' && body.ownerTitle.trim() ? { title: body.ownerTitle.trim() } : {}) },
      settings: { ...team.settings, ...(typeof body.settings === 'object' && body.settings !== null ? (body.settings as object) : {}) },
    }
    applyTeam(parseTeam(next, root))
    res.json({ ok: true })
  } catch (err) {
    teamError(res, err)
  }
})

// ---- routines ----

app.get('/api/routines/presets', (_req, res) => {
  res.json({ presets: CRON_PRESETS })
})

app.put('/api/routines/:id', (req, res) => {
  const id = String(req.params.id)
  const b = (req.body ?? {}) as Record<string, unknown>
  try {
    const agentId = typeof b.agentId === 'string' ? b.agentId : ''
    const conversationId = typeof b.conversationId === 'string' ? b.conversationId : ''
    if (!team.agents.some((a) => a.id === agentId)) throw new TeamError('routine: pick an employee')
    if (!store.get(conversationId)) throw new TeamError('routine: pick a conversation')
    const cron = typeof b.cron === 'string' ? b.cron.trim() : ''
    if (cron && !nextRun(cron)) throw new TeamError('routine: that schedule never runs')
    const instruction = typeof b.instruction === 'string' ? b.instruction.trim() : ''
    if (!instruction) throw new TeamError('routine: write the instruction')
    const routine = routines.upsert({
      id,
      name: typeof b.name === 'string' && b.name.trim() ? b.name.trim() : 'Routine',
      agentId,
      conversationId,
      cron,
      instruction,
      enabled: b.enabled !== false,
    })
    res.json({ routine })
  } catch (err) {
    if (err instanceof Error && !(err instanceof TeamError) && /cron|range|step|value/.test(err.message)) res.status(400).json({ error: `routine: ${err.message}` })
    else teamError(res, err)
  }
})

app.delete('/api/routines/:id', (req, res) => {
  res.json({ ok: routines.delete(String(req.params.id)) })
})

app.post('/api/routines/:id/run', async (req, res) => {
  const extra = typeof req.body?.text === 'string' ? req.body.text : undefined
  const run = await routines.trigger(String(req.params.id), extra)
  if (!run) {
    res.status(404).json({ error: 'unknown routine' })
    return
  }
  res.json({ run })
})

/** Webhook trigger for Slack, GitHub, Zapier, cron services… The body is appended to the instruction. */
app.post('/api/hooks/:id', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
  const r = routines.get(String(req.params.id))
  if (!r) {
    res.status(404).json({ error: 'unknown routine' })
    return
  }
  const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
  void routines.trigger(r.id, raw.trim() ? `Trigger payload:\n${raw.slice(0, 4000)}` : undefined)
  res.json({ ok: true, routine: r.name })
})

// ---- account usage dashboard (sanitized rows only; credentials never leave the server) ----
app.use('/api/usage', usageRouter(usage))

app.post('/api/account/refresh', async (_req, res) => {
  try {
    await orchestrator.probeAccount()
    res.json({ account: account.get() })
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

app.get('/api/events', (req, res) => {
  eventhub.serve(req, res)
})

// ---- activity (office view and desktop pet) ----

app.get('/api/activity/snapshot', (_req, res) => {
  res.json(activitySnapshot(team, projects.list(), approvals.list(), activity))
})

const activityStreams = new Set<express.Response>()

/**
 * The overlay's stream: activity and provider checks as they happen, and a bare "changed" signal
 * (refetch the snapshot) for projects, approvals and the team. No messages or tool inputs.
 */
app.get('/api/activity/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  res.write(': connected\n\n')
  activityStreams.add(res)
  const unsubscribe = subscribe((event) => {
    const e = streamEventFor(event)
    if (e) res.write(`data: ${JSON.stringify(e)}\n\n`)
  })
  const ping = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    activityStreams.delete(res)
    clearInterval(ping)
    unsubscribe()
  })
})

const clientDir = path.join(root, 'dist', 'client')
if (existsSync(clientDir)) {
  app.use(express.static(clientDir))
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDir, 'index.html')))
}

const server = app.listen(PORT, HOST, () => {
  console.log(`[opengrokbot] ${team.company}: ${team.agents.map((a) => a.name).join(', ')} online at http://${HOST}:${PORT}${TOKEN ? ' (token required)' : ''}`)
  const address = server.address()
  if (INSTANCE_NONCE && process.send && address && typeof address !== 'string') {
    process.send({ type: READY_MESSAGE, nonce: INSTANCE_NONCE, port: address.port })
  }
})
server.on('error', (err: Error) => {
  console.error('[opengrokbot] Could not listen:', err.message)
  if (INSTANCE_NONCE && process.send) {
    process.send({ type: FAILED_MESSAGE, nonce: INSTANCE_NONCE, reason: err.message }, () => process.exit(1))
  } else process.exit(1)
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    draining = true
    eventhub.dispose()
    for (const stream of activityStreams) stream.end()
    usage.dispose()
    clearTimeout(usageEmitTimer)
    void pet.shutdown().finally(() => server.close(() => process.exit(0)))
  })
}
