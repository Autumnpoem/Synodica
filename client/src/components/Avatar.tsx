import { useState } from 'react'
import { avatarUrl } from '../../../shared/avatar'
import type { AvatarShape } from '../../../shared/types'
import { t } from '../i18n'
import type { Person } from '../people'
import { defaultRoleAvatar, roleAvatarUrl } from '../roleAvatars'
import '../avatars.css'

interface AvatarProps {
  person: Person
  size?: number
}

const SHAPES: Record<AvatarShape, string> = {
  blob: 'M5 21C4 12 11 5 20 5s16 6 15 15c-1 8-6 15-15 15S6 30 5 21z',
  round: 'M20 4a16 16 0 1 1 0 32 16 16 0 0 1 0-32z',
  triangle: 'M18 5c1.2-1.5 2.8-1.5 4 0l13 24c1 2-.2 4.5-2.5 4.5h-25C5.2 33.5 4 31 5 29z',
  hex: 'M17.5 4.5c1.5-.9 3.5-.9 5 0l9.5 5.5c1.5.9 2.5 2.6 2.5 4.3v11.4c0 1.7-1 3.4-2.5 4.3L22.5 35.5c-1.5.9-3.5.9-5 0L8 30c-1.5-.9-2.5-2.6-2.5-4.3V14.3c0-1.7 1-3.4 2.5-4.3z',
  drop: 'M20 3c6 8 14 14 14 22a14 14 0 0 1-28 0C6 17 14 11 20 3z',
}

/**
 * An uploaded portrait when there is one (round frame, never stretched: "cover" crops to fill,
 * "contain" shows the whole image), else a friendly face in the employee's color and shape; the
 * owner gets an initial on a gradient. A portrait that fails to load falls back to the face.
 */
export function Avatar({ person, size = 36 }: AvatarProps) {
  const [broken, setBroken] = useState<string | null>(null)
  const [brokenRole, setBrokenRole] = useState<string | null>(null)
  const ref = person.avatar ?? person.agent?.avatar
  if (ref && broken !== ref.id) {
    return (
      <span className={`avatar avatar-photo${ref.fit === 'contain' ? ' is-contain' : ''}`} style={{ width: size, height: size, background: ref.fit === 'contain' ? person.color : undefined }}>
        <img src={avatarUrl(ref)} alt={t('avatar.of', { name: person.name })} width={size} height={size} style={{ objectFit: ref.fit }} draggable={false} onError={() => setBroken(ref.id)} />
      </span>
    )
  }
  const role = defaultRoleAvatar(person)
  if (brokenRole !== role) {
    return (
      <span className="avatar avatar-photo avatar-role" style={{ width: size, height: size }}>
        <img src={roleAvatarUrl(role)} alt={person.name} width={size} height={size} draggable={false} onError={() => setBrokenRole(role)} />
      </span>
    )
  }
  if (person.kind === 'owner') {
    const initial = person.name.trim().charAt(0).toUpperCase() || '•'
    return (
      <span className="avatar avatar-owner" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-label={person.name}>
        {initial}
      </span>
    )
  }
  const shape = person.agent?.shape ?? 'blob'
  const eyeY = shape === 'triangle' ? 23 : shape === 'drop' ? 23 : 19.5
  const mouthY = eyeY + 7.5
  return (
    <svg className="avatar" width={size} height={size} viewBox="0 0 40 40" aria-label={person.name}>
      <path d={SHAPES[shape]} fill={person.color} />
      <ellipse cx="14.5" cy={eyeY} rx="2.3" ry="2.6" fill="#141414" />
      <ellipse cx="25.5" cy={eyeY} rx="2.3" ry="2.6" fill="#141414" />
      <path d={`M15.5 ${mouthY}c2.5 2.2 6.5 2.2 9 0`} stroke="#141414" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  )
}

interface AvatarClusterProps {
  people: Person[]
  size?: number
  compact?: boolean
}

/** Overlapping avatars like a group-chat icon: up to three faces, then "+N". */
export function AvatarCluster({ people, size = 40, compact = false }: AvatarClusterProps) {
  const shown = people.slice(0, 3)
  const rest = people.length - shown.length
  if (shown.length === 1 && shown[0]) return <Avatar person={shown[0]} size={size} />
  const small = Math.round(size * (compact ? 0.65 : 0.72))
  const step = Math.round(size * (compact ? 0.15 : 0.3))
  const width = small + step * (shown.length - 1)
  return (
    <span className={`avatar-cluster-wrap${compact ? ' is-compact' : ''}`}>
      <span className="avatar-cluster" style={{ width, height: size }}>
        {shown.map((p, i) => (
          <span key={p.id} className="avatar-cluster-item" style={{ left: i * step, zIndex: shown.length - i }}>
            <Avatar person={p} size={small} />
          </span>
        ))}
      </span>
      {rest > 0 && !compact && <span className="avatar-cluster-more">+{rest}</span>}
    </span>
  )
}
