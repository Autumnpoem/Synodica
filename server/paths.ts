import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Windows and macOS file systems compare names case-insensitively by default. */
function fold(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p
}

/**
 * The real location of `p`: symlinks in every existing component are resolved (realpath of the
 * nearest existing ancestor), and the components that do not exist yet are appended as written.
 * Two paths that name the same folder through different symlinks get the same canonical path.
 */
export function canonicalPath(p: string): string {
  let cur = path.resolve(p)
  const rest: string[] = []
  for (let hops = 0; ; ) {
    try {
      const real = realpathSync.native(cur)
      return rest.length ? path.join(real, ...[...rest].reverse()) : real
    } catch {
      // A dangling symlink still decides where a write would land: follow it to its target.
      if (isSymlink(cur)) {
        if (++hops > 40) throw new Error(`too many symbolic links: ${p}`)
        cur = path.resolve(path.dirname(cur), readlinkSync(cur))
        continue
      }
      const parent = path.dirname(cur)
      if (parent === cur) return path.join(cur, ...[...rest].reverse())
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

/** Whether `child` equals or lies under `parent`. Both must already be canonical. No string prefix tricks. */
export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(fold(parent), fold(child))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** Two folders overlap when one equals or contains the other (canonical paths). */
export function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a)
}

/** Whether the path itself (not its target) is a symbolic link. */
export function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Resolve `p` (relative to `root`) to its real location and require it to stay inside the real
 * `root`. Existing files and folders are followed through symlinks first, so a link inside the
 * folder that points outside it is refused; for new paths the nearest existing parent decides.
 * Returns the canonical absolute path to operate on.
 */
export function confine(root: string, p: string): string {
  const realRoot = canonicalPath(root)
  const target = canonicalPath(path.resolve(root, p))
  if (!isInside(target, realRoot)) throw new Error(`Path is outside the working folder: ${p}`)
  return target
}

/** Write a text file, refusing to follow a symlink at the last component where the OS supports it. */
export function writeNoFollow(target: string, body: string): void {
  if (isSymlink(target)) throw new Error(`refusing to write through a symbolic link: ${target}`)
  const fd = openSync(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW ?? 0), 0o644)
  try {
    writeFileSync(fd, body)
  } finally {
    closeSync(fd)
  }
}

/**
 * Whether an existing file may be served or opened: its real path must lie inside one of the
 * real allowed roots and outside every denied path. Lexical `..` and symlinks cannot escape.
 */
export function allowedRealFile(p: string, roots: string[], denied: string[] = []): string | undefined {
  if (!p || !path.isAbsolute(p) || !existsSync(p)) return undefined
  let real: string
  try {
    real = realpathSync.native(p)
  } catch {
    return undefined
  }
  const canonicalRoots = roots.filter((r) => existsSync(r)).map(canonicalPath)
  if (!canonicalRoots.some((r) => isInside(real, r))) return undefined
  if (denied.map(canonicalPath).some((d) => isInside(real, d))) return undefined
  return real
}
