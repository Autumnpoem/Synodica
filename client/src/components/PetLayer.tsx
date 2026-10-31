import { useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { parseFollow, petFocus, type AppLink, type FocusInput, type PetPrefs } from '../../../shared/presence'
import { useNow, useReducedMotion } from '../companion'
import { Pet } from './Pet'

interface PetLayerProps {
  prefs: PetPrefs
  onPrefs: (p: PetPrefs) => void
  data: Omit<FocusInput, 'target' | 'now'>
  clockOffset: number
  onOpen: (link: AppLink) => void
  onSettings: () => void
}

/**
 * The browser companion: a small floating pet inside the page. Position is a fraction of the
 * viewport, so resizing the window never pushes it off screen.
 */
export function PetLayer({ prefs, onPrefs, data, clockOffset, onOpen, onSettings }: PetLayerProps) {
  const now = useNow(clockOffset)
  const reduced = useReducedMotion()
  const [bubble, setBubble] = useState(true)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const box = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ startX: number; startY: number; x: number; y: number; w: number; h: number; moved: boolean; lastX: number; lastY: number } | null>(null)
  const dragged = useRef(false)
  if (!prefs.visible) return null
  const focus = petFocus({ ...data, target: parseFollow(prefs.follow), now })
  const x = pos?.x ?? prefs.x
  const y = pos?.y ?? prefs.y

  const handlers = {
    onPointerDown: (e: PointerEvent) => {
      if (e.button !== 0) return
      const r = box.current?.getBoundingClientRect()
      drag.current = { startX: e.clientX, startY: e.clientY, x, y, w: r?.width ?? 120, h: r?.height ?? 120, moved: false, lastX: x, lastY: y }
      dragged.current = false
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    },
    onPointerMove: (e: PointerEvent) => {
      const d = drag.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (!d.moved && Math.hypot(dx, dy) < 5) return
      d.moved = true
      const fx = Math.min(1, Math.max(0, d.x + dx / Math.max(1, window.innerWidth - d.w)))
      const fy = Math.min(1, Math.max(0, d.y + dy / Math.max(1, window.innerHeight - d.h)))
      d.lastX = fx
      d.lastY = fy
      setPos({ x: fx, y: fy })
    },
    onPointerUp: (e: PointerEvent) => {
      const d = drag.current
      drag.current = null
      ;(e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId)
      if (d?.moved) {
        dragged.current = true
        onPrefs({ ...prefs, x: d.lastX, y: d.lastY })
        setPos(null)
      }
    },
  }

  const style = { left: `${x * 100}vw`, top: `${y * 100}vh`, transform: `translate(${-x * 100}%, ${-y * 100}%)` } as CSSProperties
  return (
    <div className={`pet-layer${x < 0.5 ? ' is-left' : ''}${y < 0.4 ? ' is-top' : ''}`} ref={box} style={style}>
      <Pet
        focus={focus}
        now={now}
        scale={prefs.scale}
        still={prefs.paused || reduced}
        onOpen={onOpen}
        dragHandlers={handlers}
        wasDrag={() => {
          const was = dragged.current
          dragged.current = false
          return was
        }}
        bubble={bubble}
        controls={
          <div className="pet-controls">
            <button type="button" onClick={() => setBubble(false)} aria-label="Minimise the pet's bubble">
              Minimise
            </button>
            <button type="button" onClick={onSettings}>
              Settings
            </button>
            <button type="button" onClick={() => onPrefs({ ...prefs, visible: false })}>
              Hide
            </button>
          </div>
        }
      />
      {!bubble && (
        <button type="button" className="pet-expand" onClick={() => setBubble(true)} aria-label="Show the pet's status bubble">
          {focus.view.label}
        </button>
      )}
    </div>
  )
}
