// Localizable server notes. The server stores a note's English rendering in `message.text` (history,
// exports and employees' context stay as before) and the parts in `message.note`; the UI renders the
// parts in its own locale. Placeholder values are literal text (names, task ids, paths, the owner's
// words, provider errors) and are never translated; a `{ key }` value is a nested note key.
import { EN, translate, type Locale, type MessageKey } from './i18n.js'
import type { NotePart, NoteVar } from './types.js'

export type NoteKey = Extract<MessageKey, `note.${string}`>

export function part(key: NoteKey, vars?: Record<string, NoteVar>, br?: number): NotePart {
  return { key, ...(vars ? { vars } : {}), ...(br ? { br } : {}) }
}

function isNoteKey(key: unknown): key is NoteKey {
  return typeof key === 'string' && key.startsWith('note.') && key in EN
}

/** A well-formed note: known keys only, literal or nested-key values. Anything else renders as plain text. */
export function isNote(value: unknown): value is NotePart[] {
  if (!Array.isArray(value) || value.length === 0) return false
  return value.every((p) => {
    if (!p || typeof p !== 'object' || !isNoteKey((p as NotePart).key)) return false
    const { vars, br } = p as NotePart
    if (br !== undefined && (typeof br !== 'number' || br < 0 || br > 2)) return false
    if (vars === undefined) return true
    if (!vars || typeof vars !== 'object') return false
    return Object.values(vars).every((v) => typeof v === 'string' || typeof v === 'number' || (!!v && typeof v === 'object' && isNoteKey((v as { key: unknown }).key)))
  })
}

/** Render a note in a locale. Literal values are inserted as they are. */
export function renderNote(locale: Locale, parts: readonly NotePart[]): string {
  return parts
    .map((p) => {
      const vars: Record<string, string | number> = {}
      for (const [name, v] of Object.entries(p.vars ?? {})) vars[name] = typeof v === 'object' ? translate(locale, v.key as MessageKey) : v
      return '\n'.repeat(p.br ?? 0) + translate(locale, p.key as MessageKey, vars)
    })
    .join('')
}

/** The text to show for a message or correction detail: its note in the UI locale, else the stored text. */
export function localizedText(locale: Locale, text: string, note: unknown): string {
  return isNote(note) ? renderNote(locale, note) : text
}
