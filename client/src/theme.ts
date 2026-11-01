import { useSyncExternalStore } from 'react'

export type ThemePreference = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'ogb.theme.preference.v1'
const listeners = new Set<() => void>()
let preference: ThemePreference = 'light'
let media: MediaQueryList | undefined
let initialized = false

function parsePreference(value: string | null): ThemePreference {
  return value === 'dark' || value === 'system' ? value : 'light'
}

function readPreference(): ThemePreference {
  try { return parsePreference(window.localStorage.getItem(STORAGE_KEY)) } catch { return preference }
}

function effectiveTheme(): 'light' | 'dark' {
  return resolveEffectiveTheme(preference, media?.matches ?? false)
}

export function resolveEffectiveTheme(choice: ThemePreference, systemPrefersDark: boolean): 'light' | 'dark' {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light'
  return choice
}

function applyTheme(): void {
  const theme = effectiveTheme()
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function initializeTheme(): void {
  if (initialized || typeof window === 'undefined' || typeof document === 'undefined') return
  initialized = true
  preference = readPreference()
  media = window.matchMedia?.('(prefers-color-scheme: dark)')
  applyTheme()
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    preference = parsePreference(event.key === null ? null : event.newValue)
    applyTheme()
    notify()
  })
  media?.addEventListener?.('change', () => {
    if (preference !== 'system') return
    applyTheme()
    notify()
  })
}

export function getThemePreference(): ThemePreference {
  return preference
}

export function setThemePreference(next: ThemePreference): void {
  if (preference === next) return
  preference = next
  try { window.localStorage.setItem(STORAGE_KEY, next) } catch { /* keep the choice for this window */ }
  applyTheme()
  notify()
}

export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
    getThemePreference,
    () => 'light',
  )
}
