// Multi-client synchronization: one authoritative server, many browsers / phones / desktop windows.
// Shared by the server (which stamps events and checks versions) and the client (which resyncs and
// sends stable request ids). Pure functions only, so both sides and the tests use the same rules.
import type { AppState, ServerEvent } from './types.js'

/** Header carrying a client's stable id for one logical write (a resend or refresh reuses it). */
export const REQUEST_ID_HEADER = 'Idempotency-Key'

/** A client request id: 8-128 letters, digits, '-' or '_'. */
export function isRequestId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(v)
}

/** A fresh request id (random, URL-safe). */
export function newRequestId(random: () => number = Math.random): string {
  let s = ''
  for (let i = 0; i < 24; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(random() * 36)]
  return `r-${Date.now().toString(36)}-${s}`
}

/** JSON with object keys sorted, so equal content always gives equal text (key order never matters). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v === undefined ? null : v)).join(',')}]`
  const o = value as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
    .join(',')}}`
}

/** 53-bit string hash (cyrb53), deterministic in Node and every browser. Not a security primitive. */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/**
 * The version of a task or project as a client saw it. Any change on the server (state, history,
 * corrections, owner…) gives a new version, so a write based on an older view is refused as a
 * conflict instead of silently overwriting what another device did.
 */
export function versionOf(value: unknown): string {
  return cyrb53(stableJson(value)).toString(36)
}

/** An event as it travels on the shared stream: the server event plus its position in this server run. */
export type SequencedEvent = ServerEvent & { seq: number }

/**
 * The first frame of every (re)connection: the authoritative snapshot and the stream position it is
 * valid at. `epoch` changes on every server start, so a client never mixes two server runs.
 */
export interface SyncFrame {
  epoch: string
  seq: number
  state: AppState
}

/** Where a client is on the shared stream. */
export interface SyncCursor {
  epoch: string
  seq: number
}

/**
 * Whether a live event should be applied on top of the snapshot the client holds: only events after
 * the snapshot's position (an event already contained in the snapshot is skipped), never before any
 * snapshot has arrived.
 */
export function shouldApply(cursor: SyncCursor | null, seq: unknown): boolean {
  if (!cursor) return false
  if (typeof seq !== 'number') return true
  return seq > cursor.seq
}

/** Live typing indicators by conversation, as kept by the server for snapshots. */
export type TypingMap = Record<string, string[]>
