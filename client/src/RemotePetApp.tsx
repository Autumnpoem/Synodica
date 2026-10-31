import { useEffect, useState } from 'react'
import { desktopPetConfig } from '../../shared/desktop'
import { petStatus } from './api'
import { desktopBridge } from './companion'
import { useUpstreamPet } from './dshpet'
import { useLocale } from './i18n'
import './remote-pet.css'

/** Original dsh-pet browser renderer in a native transparent window, bound to the remote session. */
export function RemotePetApp() {
  const bridge = desktopBridge()
  const locale = useLocale()
  const [enabled, setEnabled] = useState(false)
  const { pet, error } = useUpstreamPet(enabled, locale)
  useEffect(() => {
    const original = window.fetch.bind(window)
    const adapted: typeof window.fetch = async (input, init) => {
      const address = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href)
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
      if (address.origin !== location.origin || address.pathname !== '/dsh-pet-7340/config' || method.toUpperCase() !== 'GET') return original(input, init)
      const response = await original(input, init)
      if (!response.ok) return response
      const body = desktopPetConfig(await response.json())
      return new Response(JSON.stringify(body), { status: response.status, headers: { 'Content-Type': 'application/json' } })
    }
    window.fetch = adapted
    return () => { window.fetch = original }
  }, [])
  useEffect(() => {
    document.documentElement.classList.add('is-remote-pet-window')
    let alive = true
    const load = () => void petStatus().then((body) => {
      if (alive) setEnabled(body.settings.enabled && body.status.state === 'running')
    }).catch(() => { if (alive) setEnabled(false) })
    load()
    const timer = window.setInterval(load, 10_000)
    return () => { alive = false; window.clearInterval(timer); document.documentElement.classList.remove('is-remote-pet-window') }
  }, [])
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const hit = document.elementFromPoint(event.clientX, event.clientY)
      const interactive = Boolean(hit?.closest('.dsh-pet-hit,.dsh-pet-menu,.remote-pet-close,.dsh-pet-bubble.is-clickable'))
      bridge?.remotePetInteractive?.(interactive)
    }
    window.addEventListener('mousemove', onMove)
    return () => window.removeEventListener('mousemove', onMove)
  }, [bridge])
  return <div className="remote-pet-shell">
    <button className="remote-pet-close" type="button" aria-label="Close desktop pet" onClick={() => bridge?.remotePetClose?.()}>×</button>
    {error && <p className="remote-pet-error">{error}</p>}
    {enabled && pet?.Overlay && <pet.Overlay />}
  </div>
}
