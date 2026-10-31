import type { CSSProperties, PointerEvent, ReactNode } from 'react'
import { formatDuration, PRESENCE_GLYPH, type AppLink, type PetFocus, type Presence } from '../../../shared/presence'

/**
 * The office companion: an original, code-drawn sprite (no image assets). Its pose comes only from
 * the presence it is given; the CSS in pet.css animates poses and honours reduced motion.
 */
export function PetSprite({ presence, color, size = 120 }: { presence: Presence; color: string; size?: number }) {
  const unknown = presence === 'unknown'
  const eyes = eyesFor(presence)
  return (
    <svg className="pet-sprite" width={size} height={size} viewBox="0 0 120 120" aria-hidden="true" focusable="false">
      <ellipse className="pet-shadow" cx="60" cy="110" rx="30" ry="5" />
      <g className="pet-figure">
        {/* antenna with a status light */}
        <path d="M60 22 V12" className="pet-line" />
        <circle className="pet-light" cx="60" cy="10" r="5" />
        {/* body */}
        <rect className={`pet-shell${unknown ? ' is-outline' : ''}`} x="26" y="22" width="68" height="64" rx="30" style={{ fill: unknown ? 'none' : color, stroke: unknown ? color : undefined }} />
        <rect className="pet-face" x="35" y="36" width="50" height="30" rx="14" />
        {eyes}
        {/* feet */}
        <rect className="pet-foot" x="38" y="84" width="14" height="10" rx="5" style={{ fill: unknown ? 'none' : color, stroke: unknown ? color : undefined }} />
        <rect className="pet-foot" x="68" y="84" width="14" height="10" rx="5" style={{ fill: unknown ? 'none' : color, stroke: unknown ? color : undefined }} />
        {/* hands */}
        <circle className="pet-hand pet-hand-left" cx="24" cy="62" r="7" style={{ fill: unknown ? 'none' : color, stroke: unknown ? color : undefined }} />
        <circle className="pet-hand pet-hand-right" cx="96" cy="62" r="7" style={{ fill: unknown ? 'none' : color, stroke: unknown ? color : undefined }} />
        {prop(presence)}
      </g>
    </svg>
  )
}

function eyesFor(p: Presence): ReactNode {
  if (p === 'failed') {
    return (
      <g className="pet-eyes is-x">
        <path d="M45 46 l8 8 M53 46 l-8 8 M67 46 l8 8 M75 46 l-8 8" />
      </g>
    )
  }
  if (p === 'idle' || p === 'offline' || p === 'interrupted') {
    return (
      <g className="pet-eyes is-closed">
        <path d="M44 52 q5 4 10 0 M66 52 q5 4 10 0" />
      </g>
    )
  }
  if (p === 'done') {
    return (
      <g className="pet-eyes is-happy">
        <path d="M44 54 q5 -6 10 0 M66 54 q5 -6 10 0" />
      </g>
    )
  }
  const dy = p === 'thinking' ? -3 : p === 'coding' || p === 'command' || p === 'reading' ? 3 : 0
  return (
    <g className="pet-eyes">
      <ellipse cx="49" cy={51 + dy} rx="4" ry="5" />
      <ellipse cx="71" cy={51 + dy} rx="4" ry="5" />
    </g>
  )
}

/** A small prop that says what kind of work it is, so the pose is readable without colour. */
function prop(p: Presence): ReactNode {
  switch (p) {
    case 'thinking':
      return (
        <g className="pet-prop pet-thought">
          <circle cx="98" cy="22" r="3" />
          <circle cx="106" cy="13" r="4.5" />
          <circle cx="114" cy="3" r="2.5" />
        </g>
      )
    case 'coding':
    case 'reading':
    case 'command':
    case 'browsing':
    case 'tool':
      return (
        <g className="pet-prop pet-laptop">
          <rect x="36" y="70" width="48" height="22" rx="3" />
          <text x="60" y="86" textAnchor="middle">{p === 'command' ? '>_' : p === 'reading' ? '¶' : p === 'browsing' ? '@' : p === 'tool' ? '⚙' : '</>'}</text>
        </g>
      )
    case 'waiting-approval':
      return (
        <g className="pet-prop pet-badge is-attention">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">!</text>
        </g>
      )
    case 'waiting-user':
    case 'stalled':
      return (
        <g className="pet-prop pet-badge">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">?</text>
        </g>
      )
    case 'waiting-dependency':
    case 'queued':
      return (
        <g className="pet-prop pet-badge is-wait">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">{p === 'queued' ? '›' : '⧗'}</text>
        </g>
      )
    case 'failed':
      return (
        <g className="pet-prop pet-badge is-problem">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">✕</text>
        </g>
      )
    case 'interrupted':
      return (
        <g className="pet-prop pet-badge is-problem">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">‖</text>
        </g>
      )
    case 'offline':
      return (
        <g className="pet-prop pet-badge is-problem">
          <circle cx="102" cy="20" r="11" />
          <text x="102" y="25" textAnchor="middle">⏻</text>
        </g>
      )
    case 'done':
      return (
        <g className="pet-prop pet-sparkle">
          <path d="M14 20 l3 7 7 3 -7 3 -3 7 -3 -7 -7 -3 7 -3z" />
          <path d="M104 30 l2 5 5 2 -5 2 -2 5 -2 -5 -5 -2 5 -2z" />
        </g>
      )
    default:
      return null
  }
}

interface PetProps {
  focus: PetFocus
  now: number
  scale: number
  /** Animations off: the user's pause setting or the system's reduced motion. */
  still: boolean
  onOpen: (link: AppLink) => void
  /** Pointer handlers for dragging, attached to the sprite. */
  dragHandlers?: {
    onPointerDown: (e: PointerEvent) => void
    onPointerMove: (e: PointerEvent) => void
    onPointerUp: (e: PointerEvent) => void
  }
  /** Was the last pointer gesture a drag (then a click is not an "open")? */
  wasDrag?: () => boolean
  /** Extra controls (settings, hide), shown next to the bubble. */
  controls?: ReactNode
  /** Hide the bubble (compact). */
  bubble?: boolean
}

export function Pet({ focus, now, scale, still, onOpen, dragHandlers, wasDrag, controls, bubble = true }: PetProps) {
  const { view } = focus
  const color = focus.agent?.color ?? '#8ea2ff'
  const who = focus.agent && focus.title !== focus.agent.name ? `${focus.title} · ${focus.agent.name}` : focus.title
  const elapsed = focus.since !== undefined && view.presence !== 'unknown' ? ` for ${formatDuration(now - focus.since)}` : ''
  const counts = focus.counts
  const summary = counts ? [counts.working ? `${counts.working} working` : '', counts.attention ? `${counts.attention} need you` : '', counts.problem ? `${counts.problem} with problems` : '', counts.wait ? `${counts.wait} waiting` : '', counts.quiet ? `${counts.quiet} idle` : '', counts.unknown ? `${counts.unknown} unknown` : ''].filter(Boolean).join(' · ') : ''
  const open = () => {
    if (wasDrag?.()) return
    onOpen(focus.link)
  }
  return (
    <div className={`pet pres-${view.presence} tone-${view.tone}${still ? ' is-still' : ''}`} style={{ '--pet-scale': String(scale) } as CSSProperties}>
      {bubble && (
        <div className="pet-bubble">
          <div className="pet-who">{who}</div>
          <div className="pet-state" role="status" aria-live="polite">
            <span className="pet-glyph" aria-hidden="true">
              {PRESENCE_GLYPH[view.presence]}
            </span>
            {view.label}
          </div>
          {(focus.task || focus.projectName) && <div className="pet-task">{[focus.task, focus.projectName].filter(Boolean).join(' · ')}</div>}
          {view.detail && <div className="pet-detail" title={view.detail}>{view.detail}</div>}
          {(elapsed || summary) && <div className="pet-meta">{[elapsed.trim(), summary].filter(Boolean).join(' · ')}</div>}
          {focus.attention && (
            <button type="button" className="pet-attention" onClick={() => focus.attention && onOpen(focus.attention.link)}>
              {focus.attention.link.view === 'approval' ? 'Open approval' : 'Open'} · {focus.attention.text}
            </button>
          )}
          {controls}
        </div>
      )}
      <button type="button" className="pet-body" onClick={open} aria-label={`${who}: ${view.label}${elapsed}. Open ${focus.link.view === 'office' ? 'the office' : 'the conversation'}`} title={`${view.label}${elapsed}`} {...dragHandlers}>
        <PetSprite presence={view.presence} color={color} size={Math.round(96 * scale)} />
      </button>
    </div>
  )
}
