import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { DEFAULT_NATIVE_PET, type NativePetSettings } from '../../shared/desktop'
import { parseFollow, petFocus, type ActivityStreamEvent } from '../../shared/presence'
import type { ActivitySnapshot, AgentActivity } from '../../shared/types'
import { desktopBridge, useNow, useReducedMotion } from './companion'
import { Pet } from './components/Pet'

/**
 * The desktop pet overlay (Electron, transparent window, loaded at #/pet). It reads the minimal
 * activity snapshot and the filtered activity stream: no messages, briefs or provider settings.
 * One EventSource for the life of the window; reconnects reload the snapshot.
 */
export function PetApp() {
  const bridge = desktopBridge()
  const [snap, setSnap] = useState<ActivitySnapshot | null>(null)
  const [activity, setActivity] = useState<Map<string, AgentActivity>>(new Map())
  const [connected, setConnected] = useState(false)
  const [settings, setSettings] = useState<NativePetSettings>(DEFAULT_NATIVE_PET)
  const [offset, setOffset] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const now = useNow(offset)
  const reduced = useReducedMotion()
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const dragged = useRef(false)

  useEffect(() => {
    document.documentElement.classList.add('is-pet-window')
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = () =>
      fetch('/api/activity/snapshot')
        .then(async (res) => {
          if (!res.ok) throw new Error(res.status === 401 ? 'Sign in in the main window' : `HTTP ${res.status}`)
          return (await res.json()) as ActivitySnapshot
        })
        .then((s) => {
          if (!alive) return
          setSnap(s)
          setActivity(new Map(s.activity.map((a) => [a.agentId, a])))
          setOffset(s.serverNow - Date.now())
          setError(null)
        })
        .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : String(err)))
    // Bursts of project changes cause one reload, not one per event.
    const reloadSoon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(), 400)
    }
    const es = new EventSource('/api/activity/events')
    es.onopen = () => {
      setConnected(true)
      void load()
    }
    es.onerror = () => setConnected(false)
    es.onmessage = (e) => {
      let ev: ActivityStreamEvent
      try {
        ev = JSON.parse(e.data) as ActivityStreamEvent
      } catch {
        return
      }
      if (ev.type === 'activity') {
        const a = ev.activity
        setActivity((m) => new Map(m).set(a.agentId, a))
      } else reloadSoon()
    }
    const off = bridge?.onPetSettings((s) => setSettings(s))
    void bridge?.getPetSettings().then(setSettings)
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      es.close()
      off?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const focus = snap
    ? petFocus({ target: parseFollow(settings.follow), agents: snap.agents, activity, projects: snap.projects, approvals: snap.approvals, now, connected })
    : { view: { presence: 'unknown' as const, tone: 'unknown' as const, label: error ? `Unknown · ${error}` : 'Unknown · connecting', live: false }, link: { view: 'office' as const }, title: 'Synodica' }

  // Native drag: the main process moves the window by validated deltas.
  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return
      drag.current = { x: e.screenX, y: e.screenY, moved: false }
      dragged.current = false
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current
      if (!d || !bridge) return
      const dx = Math.round(e.screenX - d.x)
      const dy = Math.round(e.screenY - d.y)
      if (!d.moved && Math.hypot(dx, dy) < 4) return
      d.moved = true
      d.x = e.screenX
      d.y = e.screenY
      bridge.petDrag(dx, dy)
    },
    onPointerUp: (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      if (d?.moved) dragged.current = true
    },
  }

  return (
    <div className="pet-window">
      <Pet
        focus={focus}
        now={now}
        scale={settings.scale}
        still={settings.paused || reduced}
        onOpen={(link) => bridge?.petOpen(link)}
        dragHandlers={handlers}
        wasDrag={() => {
          const was = dragged.current
          dragged.current = false
          return was
        }}
      />
    </div>
  )
}
