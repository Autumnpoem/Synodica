// Avatar references and image validation shared by the server (uploads) and the client (URLs).
import type { AvatarRef } from './types.js'

/** Generated avatar ids: "av-" and 24 lowercase hex digits. Never a path, file name or URL. */
export const AVATAR_ID = /^av-[0-9a-f]{24}$/

export const AVATAR_LIMITS = {
  /** Largest accepted upload. */
  maxBytes: 2 * 1024 * 1024,
  /** Smallest and largest accepted side, in pixels. */
  minSide: 16,
  maxSide: 4096,
  /** Decoded pixel budget (width x height), so a small file cannot claim a huge canvas. */
  maxPixels: 16 * 1024 * 1024,
} as const

export type AvatarFormat = 'png' | 'jpeg' | 'webp' | 'gif'

export const AVATAR_MIME: Record<AvatarFormat, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

export function isAvatarId(v: unknown): v is string {
  return typeof v === 'string' && AVATAR_ID.test(v)
}

/** A stored reference, or undefined when it is missing or malformed (callers then use color and shape). */
export function parseAvatarRef(raw: unknown): AvatarRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  if (!isAvatarId(r.id)) return undefined
  const fit = r.fit === 'contain' ? 'contain' : 'cover'
  const updatedAt = typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : 0
  return { id: r.id, fit, updatedAt }
}

/** The constrained endpoint an avatar is served from; `v` busts caches after a replace. */
export function avatarUrl(ref: AvatarRef): string {
  return `/api/avatars/${ref.id}?v=${ref.updatedAt}`
}

export type ImageCheck = { ok: true; format: AvatarFormat; width: number; height: number } | { ok: false; error: string }

/**
 * Identify a raster image by its real header bytes (never by name or declared type) and read its
 * geometry. Only PNG, JPEG, WebP and GIF pass; SVG, HTML and everything else are refused.
 */
export function inspectImage(bytes: Uint8Array): ImageCheck {
  if (bytes.length === 0) return { ok: false, error: 'the file is empty' }
  if (bytes.length > AVATAR_LIMITS.maxBytes) return { ok: false, error: `the image is larger than ${AVATAR_LIMITS.maxBytes / 1024 / 1024} MB` }
  const size = readGeometry(bytes)
  if (!size) return { ok: false, error: 'only PNG, JPEG, WebP or GIF images are supported (SVG and other formats are refused)' }
  const { format, width, height } = size
  if (width < AVATAR_LIMITS.minSide || height < AVATAR_LIMITS.minSide) return { ok: false, error: `the image must be at least ${AVATAR_LIMITS.minSide}x${AVATAR_LIMITS.minSide} pixels` }
  if (width > AVATAR_LIMITS.maxSide || height > AVATAR_LIMITS.maxSide) return { ok: false, error: `the image must be at most ${AVATAR_LIMITS.maxSide}x${AVATAR_LIMITS.maxSide} pixels` }
  if (width * height > AVATAR_LIMITS.maxPixels) return { ok: false, error: 'the image has too many pixels' }
  return { ok: true, format, width, height }
}

function u16be(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
}
function u16le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
}
function u24le(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16)
}
function u32be(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0))
}
function ascii(b: Uint8Array, i: number, n: number): string {
  let s = ''
  for (let k = 0; k < n; k++) s += String.fromCharCode(b[i + k] ?? 0)
  return s
}

function readGeometry(b: Uint8Array): { format: AvatarFormat; width: number; height: number } | undefined {
  // PNG: signature, then the IHDR chunk first.
  if (b.length >= 24 && ascii(b, 1, 3) === 'PNG' && b[0] === 0x89 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a && ascii(b, 12, 4) === 'IHDR') {
    return { format: 'png', width: u32be(b, 16), height: u32be(b, 20) }
  }
  // GIF87a / GIF89a: logical screen size.
  if (b.length >= 10 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) {
    return { format: 'gif', width: u16le(b, 6), height: u16le(b, 8) }
  }
  // WebP: RIFF....WEBP with a VP8, VP8L or VP8X chunk.
  if (b.length >= 30 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    const chunk = ascii(b, 12, 4)
    if (chunk === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { format: 'webp', width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
    if (chunk === 'VP8L' && b[20] === 0x2f) {
      const v = (b[21] ?? 0) | ((b[22] ?? 0) << 8) | ((b[23] ?? 0) << 16) | ((b[24] ?? 0) << 24)
      return { format: 'webp', width: (v & 0x3fff) + 1, height: ((v >>> 14) & 0x3fff) + 1 }
    }
    if (chunk === 'VP8X') return { format: 'webp', width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
    return undefined
  }
  // JPEG: SOI, then walk segments to the first start-of-frame marker.
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return undefined
      const marker = b[i + 1] ?? 0
      if (marker === 0xff) {
        i++
        continue
      }
      const len = u16be(b, i + 2)
      if (len < 2) return undefined
      const sof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (sof) return { format: 'jpeg', width: u16be(b, i + 7), height: u16be(b, i + 5) }
      i += 2 + len
    }
  }
  return undefined
}
