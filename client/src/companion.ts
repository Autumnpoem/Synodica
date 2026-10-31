import { useEffect, useState } from 'react'
import type { NativePetSettings, OfficeConnection } from '../../shared/desktop'
import type { Locale } from '../../shared/i18n'
import { sanitizePetPrefs, type AppLink, type PetPrefs } from '../../shared/presence'

/**
 * The bridge desktop/preload.cjs exposes in the Electron app. Absent in a normal browser. It can
 * only read / change the pet settings and move or open links from the pet; nothing else.
 */
export interface DesktopBridge {
  platform: string
  getPetSettings(): Promise<NativePetSettings>
  setPetSettings(patch: Partial<Omit<NativePetSettings, 'position'>>): Promise<NativePetSettings>
  onPetSettings(cb: (s: NativePetSettings) => void): () => void
  onNavigate(cb: (hash: string) => void): () => void
  /** Move the desktop pet window; the main process clamps it to a display and saves (debounced). */
  petDrag(dx: number, dy: number): void
  petOpen(link: AppLink): void
  /** Tell the app shell the interface language (the native Pet menu follows it). Older shells lack it. */
  setLocale?(locale: Locale): void
  getConnection(): Promise<OfficeConnection>
  connectRemote(url: string, token: string): Promise<OfficeConnection>
  disconnectRemote(): Promise<OfficeConnection>
  openQuota(): Promise<{ pinned: boolean; collapsed: boolean }>
  getQuotaState(): Promise<{ pinned: boolean; collapsed: boolean }>
  quotaAction(action: 'close' | 'pin' | 'collapse'): Promise<{ pinned: boolean; collapsed: boolean }>
  remotePetInteractive?(interactive: boolean): void
  remotePetClose?(): void
}

export function desktopBridge(): DesktopBridge | undefined {
  const b = (window as unknown as { ogbDesktop?: DesktopBridge }).ogbDesktop
  return b && typeof b.getPetSettings === 'function' ? b : undefined
}

const KEY = 'ogb.pet.browser.v1'

/** Browser (in-page) pet preferences, kept in this browser only. Separate from the native pet. */
export function loadPetPrefs(): PetPrefs {
  try {
    const raw = localStorage.getItem(KEY)
    return sanitizePetPrefs(raw ? JSON.parse(raw) : undefined)
  } catch {
    return sanitizePetPrefs(undefined)
  }
}

export function savePetPrefs(p: PetPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitizePetPrefs(p)))
  } catch {
    // storage full or disabled: the preference lasts for this page only
  }
}

/** The current time on the server's clock, re-rendering every `ms` while the page is visible. */
export function useNow(offset: number, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now() + offset)
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const start = () => {
      if (timer || document.visibilityState === 'hidden') return
      setNow(Date.now() + offset)
      timer = setInterval(() => setNow(Date.now() + offset), ms)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = undefined
    }
    const onVis = () => (document.visibilityState === 'hidden' ? stop() : start())
    start()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [offset, ms])
  return now
}

/** The system's reduced-motion preference, live. */
export function useReducedMotion(): boolean {
  const query = '(prefers-reduced-motion: reduce)'
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches)
  useEffect(() => {
    if (typeof matchMedia !== 'function') return
    const m = matchMedia(query)
    const on = () => setReduced(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return reduced
}
