import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { AVATAR_MIME, inspectImage, isAvatarId, type AvatarFormat } from '../shared/avatar.js'
import type { AvatarRef, Team } from '../shared/types.js'

export class AvatarError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

/**
 * Uploaded portraits in a private folder under app data (data/avatars). Files are named only by a
 * generated id and the format detected from their bytes; requests address them by id, never by
 * path, so nothing outside this folder (and no other personal image) is ever read or served.
 */
export class AvatarStore {
  readonly dir: string

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'avatars')
    mkdirSync(this.dir, { recursive: true })
  }

  /** Validate and store an upload. Returns the new reference; the caller attaches it and removes the old one. */
  save(bytes: Uint8Array, fit: unknown): AvatarRef {
    const check = inspectImage(bytes)
    if (!check.ok) throw new AvatarError(check.error)
    const id = `av-${randomBytes(12).toString('hex')}`
    const file = path.join(this.dir, `${id}.${check.format}`)
    const tmp = `${file}.tmp`
    writeFileSync(tmp, bytes, { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
    return { id, fit: fit === 'contain' ? 'contain' : 'cover', updatedAt: Date.now() }
  }

  /** The stored file for an id, or undefined (bad id, missing file, or not a plain file). */
  find(id: unknown): { file: string; mime: string } | undefined {
    if (!isAvatarId(id)) return undefined
    for (const format of Object.keys(AVATAR_MIME) as AvatarFormat[]) {
      const file = path.join(this.dir, `${id}.${format}`)
      if (!existsSync(file)) continue
      const st = lstatSync(file)
      if (!st.isFile()) return undefined
      // Re-check the bytes when serving: a file swapped in by hand must still be a supported raster.
      const check = inspectImage(readFileSync(file))
      if (!check.ok || check.format !== format) return undefined
      return { file, mime: AVATAR_MIME[format] }
    }
    return undefined
  }

  /** Remove a stored avatar by id (reset / replace). Unknown ids are ignored. */
  remove(id: unknown): void {
    if (!isAvatarId(id)) return
    for (const format of Object.keys(AVATAR_MIME)) {
      const file = path.join(this.dir, `${id}.${format}`)
      if (existsSync(file) && lstatSync(file).isFile()) unlinkSync(file)
    }
  }

  /**
   * Upload, replace or reset (`bytes` undefined) the avatar of an employee or of the owner ("user").
   * Returns the updated team; the replaced file is deleted only after the caller persisted the team.
   */
  assign(team: Team, target: string, bytes: Uint8Array | undefined, fit: unknown): { team: Team; ref?: AvatarRef; commit: () => void } {
    const current = target === 'user' ? team.owner.avatar : team.agents.find((a) => a.id === target)?.avatar
    if (target !== 'user' && !team.agents.some((a) => a.id === target)) throw new AvatarError('unknown employee', 404)
    const ref = bytes ? this.save(bytes, fit) : undefined
    const apply = <T extends { avatar?: AvatarRef }>(x: T): T => {
      const { avatar: _old, ...rest } = x
      return (ref ? { ...rest, avatar: ref } : rest) as T
    }
    const next: Team = target === 'user' ? { ...team, owner: apply(team.owner) } : { ...team, agents: team.agents.map((a) => (a.id === target ? apply(a) : a)) }
    return {
      team: next,
      ...(ref ? { ref } : {}),
      commit: () => {
        if (current && current.id !== ref?.id) this.remove(current.id)
      },
    }
  }

  /** Change only how an existing avatar fits its frame. */
  refit(team: Team, target: string, fit: unknown): Team {
    const f: AvatarRef['fit'] = fit === 'contain' ? 'contain' : 'cover'
    const touch = <T extends { avatar?: AvatarRef }>(x: T): T => (x.avatar ? { ...x, avatar: { ...x.avatar, fit: f, updatedAt: Date.now() } } : x)
    if (target === 'user') return { ...team, owner: touch(team.owner) }
    if (!team.agents.some((a) => a.id === target)) throw new AvatarError('unknown employee', 404)
    return { ...team, agents: team.agents.map((a) => (a.id === target ? touch(a) : a)) }
  }

  /** Ids on disk (tests, cleanup). */
  ids(): string[] {
    return readdirSync(this.dir)
      .map((f) => f.replace(/\.(png|jpeg|webp|gif)$/, ''))
      .filter((id) => isAvatarId(id))
  }
}
