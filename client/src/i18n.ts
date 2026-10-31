import { useSyncExternalStore } from 'react'
import { loadLocale, saveLocale, translate, type Locale, type MessageKey } from '../../shared/i18n'

// One UI locale for the page: chosen from the saved preference, else the OS / browser language.
const storage = typeof window !== 'undefined' ? window.localStorage : undefined
let current: Locale = loadLocale(storage, typeof navigator !== 'undefined' ? navigator.languages ?? [navigator.language] : [])
const listeners = new Set<() => void>()

function apply(): void {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
apply()

export function getLocale(): Locale {
  return current
}

/** Switch the interface language. Persisted in this browser only; team, provider and model settings are untouched. */
export function setLocale(next: Locale): void {
  if (next === current) return
  current = next
  saveLocale(storage, next)
  apply()
  for (const fn of listeners) fn()
}

/** Re-render on locale changes (App uses it, so the whole tree follows). */
export function useLocale(): Locale {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    () => current,
  )
}

/** Translate in the current locale. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  return translate(current, key, vars)
}
