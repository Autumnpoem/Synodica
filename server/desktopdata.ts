// Desktop-mode data locations and the start handshake between the Electron shell (desktop/app.cjs)
// and its server child. Electron-free, so the server tests exercise it with real files and processes.
import type { ChildProcess } from 'node:child_process'
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'

export interface DesktopPaths {
  /** The team file (employees, providers and their keys). */
  team: string
  /** Conversations, projects, memory, uploads, pet home, usage cache. */
  data: string
  /** Working directory of the server process: relative paths never resolve inside the app bundle. */
  workDir: string
  /** Where each path came from: an explicit environment override, or per-user app data. */
  source: { team: 'env' | 'user-data'; data: 'env' | 'user-data' }
}

/**
 * Default writable locations in desktop mode: the user's app data (Electron's app.getPath('userData')),
 * never the application folder, which is read-only inside a packaged .app. OPENGROKBOT_TEAM and
 * OPENGROKBOT_DATA still override them.
 */
export function desktopPaths(env: NodeJS.ProcessEnv, userData: string): DesktopPaths {
  const teamEnv = env.OPENGROKBOT_TEAM?.trim()
  const dataEnv = env.OPENGROKBOT_DATA?.trim()
  return {
    team: teamEnv ? path.resolve(teamEnv) : path.join(userData, 'team.json'),
    data: dataEnv ? path.resolve(dataEnv) : path.join(userData, 'data'),
    workDir: userData,
    source: { team: teamEnv ? 'env' : 'user-data', data: dataEnv ? 'env' : 'user-data' },
  }
}

export interface MigrationResult {
  team: 'copied' | 'kept' | 'none'
  data: 'copied' | 'kept' | 'none'
  notes: string[]
}

/**
 * One-time move of a development checkout's office (team.json and data/) into app data. Copies only
 * into places that do not exist yet: an existing team file or data folder in app data always wins,
 * so stored credentials and settings are never replaced. The checkout's files stay where they are.
 * Explicit environment overrides are left alone.
 */
export function migrateLegacyOffice(legacy: { team: string; data: string }, target: Pick<DesktopPaths, 'team' | 'data' | 'source'>): MigrationResult {
  const out: MigrationResult = { team: 'none', data: 'none', notes: [] }
  if (target.source.team === 'user-data' && existsSync(legacy.team) && path.resolve(legacy.team) !== path.resolve(target.team)) {
    if (existsSync(target.team)) out.team = 'kept'
    else {
      mkdirSync(path.dirname(target.team), { recursive: true })
      try {
        // COPYFILE_EXCL: fails instead of replacing a file that appeared meanwhile.
        copyFileSync(legacy.team, target.team, constants.COPYFILE_EXCL)
        chmodSync(target.team, 0o600)
        out.team = 'copied'
        out.notes.push(`copied the existing team file into ${target.team}`)
      } catch {
        out.team = 'kept'
      }
    }
  }
  if (target.source.data === 'user-data' && existsSync(legacy.data) && statSync(legacy.data).isDirectory() && path.resolve(legacy.data) !== path.resolve(target.data)) {
    if (existsSync(target.data)) out.data = 'kept'
    else {
      mkdirSync(path.dirname(target.data), { recursive: true })
      cpSync(legacy.data, target.data, { recursive: true, force: false, errorOnExist: false, preserveTimestamps: true })
      out.data = 'copied'
      out.notes.push(`copied the existing data folder into ${target.data}`)
    }
  }
  return out
}

export interface ServerEnvOptions {
  port: number
  paths: DesktopPaths
  /** Per-launch secret the server echoes back over IPC once it listens. */
  nonce: string
  /** This Electron's own executable: the server runs on it in Node mode, the pet host and helper reuse it. */
  electron: string
  helperMode: 'app-executable' | 'launcher'
}

/** The server child's environment in desktop mode. Explicit overrides already in `base` are kept. */
export function serverEnv(base: NodeJS.ProcessEnv, o: ServerEnvOptions): NodeJS.ProcessEnv {
  return {
    ...base,
    PORT: String(o.port),
    ELECTRON_RUN_AS_NODE: '1',
    OPENGROKBOT_DESKTOP: '1',
    OPENGROKBOT_TEAM: o.paths.team,
    OPENGROKBOT_DATA: o.paths.data,
    OPENGROKBOT_INSTANCE_NONCE: o.nonce,
    OPENGROKBOT_PET_ELECTRON: base.OPENGROKBOT_PET_ELECTRON?.trim() || o.electron,
    OPENGROKBOT_PET_HELPER_MODE: o.helperMode,
  }
}

export const READY_MESSAGE = 'opengrokbot:ready'
export const FAILED_MESSAGE = 'opengrokbot:failed'

/**
 * Wait until this exact child reports that it listens. Only its IPC message with the launch nonce
 * counts, so a failed start (for example, the port is taken by another program) is reported instead
 * of opening whatever answers on that port.
 */
export function waitForReady(child: Pick<ChildProcess, 'on' | 'off'>, nonce: string, timeoutMs: number): Promise<{ ok: true; port: number } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: { ok: true; port: number } | { ok: false; reason: string }) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      child.off('error', onError)
      resolve(v)
    }
    const onMessage = (m: unknown) => {
      const msg = m && typeof m === 'object' ? (m as { type?: unknown; nonce?: unknown; port?: unknown; reason?: unknown }) : {}
      if (msg.nonce !== nonce) return
      if (msg.type === READY_MESSAGE && typeof msg.port === 'number' && Number.isInteger(msg.port) && msg.port > 0) finish({ ok: true, port: msg.port })
      else if (msg.type === FAILED_MESSAGE) finish({ ok: false, reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 300) : 'the server could not start' })
    }
    const onExit = (code: number | null, signal: string | null) => finish({ ok: false, reason: `the server exited before it was ready (${signal ?? code})` })
    const onError = (err: Error) => finish({ ok: false, reason: `the server could not start: ${err.message}` })
    const timer = setTimeout(() => finish({ ok: false, reason: 'the server did not report ready in time' }), timeoutMs)
    child.on('message', onMessage)
    child.on('exit', onExit)
    child.on('error', onError)
  })
}
