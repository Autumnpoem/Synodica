import { useEffect, useState } from 'react'
import type { Project, Team } from '../../../shared/types'
import { petSettings, petStart, petStatus, petStop, type PetStatusBody } from '../api'
import type { UpstreamPet } from '../dshpet'
import { t } from '../i18n'

interface Props {
  team: Team
  projects: Project[]
  /** The upstream pet applied on this page (its settings page renders here). */
  upstream?: UpstreamPet
  upstreamError?: string
  onStatus: (s: PetStatusBody) => void
}

/** Office panel for the integrated dsh-pet: runtime status, follow target, bridge options and the upstream settings page. */
export function DshPetPanel({ team, projects, upstream, upstreamError, onStatus }: Props) {
  const [body, setBody] = useState<PetStatusBody | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const take = (b: PetStatusBody) => {
    setBody(b)
    onStatus(b)
  }
  useEffect(() => {
    void petStatus()
      .then(take)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  if (!body) return <section id="companion" className="dsh-pet-panel"><h3>{t('pet.title')}</h3>{error && <p className="form-error">{error}</p>}</section>
  const { status, settings } = body
  const running = status.state === 'running'
  const run = (fn: () => Promise<PetStatusBody>) => {
    setBusy(true)
    setError(null)
    void fn()
      .then(take)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }
  const patch = (p: Partial<PetStatusBody['settings']>) => {
    void petSettings(p)
      .then((r) => take({ status, settings: r.settings }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }
  const followValue = settings.follow.kind === 'team' ? 'team' : `${settings.follow.kind}:${settings.follow.id}`
  const statusText =
    status.state === 'missing'
      ? t('pet.status.missing', { command: status.command ?? 'npm run pet:install' })
      : status.state === 'invalid'
        ? t('pet.status.invalid', { path: 'pet-runtime', version: status.version, reason: status.reason ?? '' })
        : status.state === 'failed'
          ? t('pet.status.failed', { reason: status.reason ?? '' })
          : running
            ? t('pet.status.running')
            : t('pet.status.stopped')

  return (
    <section id="companion" className="dsh-pet-panel">
      <h3>{t('pet.title')}</h3>
      <p role="status">{statusText}</p>
      {error && <p className="form-error">{error}</p>}
      {(status.state === 'stopped' || status.state === 'failed' || running) && (
        <button type="button" className="btn" disabled={busy} onClick={() => run(running ? petStop : petStart)}>
          {running ? t('pet.stop') : t('pet.start')}
        </button>
      )}
      <label className="field">
        <span>{t('pet.follow')}</span>
        <select
          value={followValue}
          onChange={(e) => {
            const v = e.target.value
            const [kind, id] = v.split(':')
            patch({ follow: kind === 'project' || kind === 'agent' ? { kind, id: id ?? '' } : { kind: 'team' } })
          }}
        >
          <option value="team">{t('pet.followTeam')}</option>
          {projects
            .filter((p) => !p.archived)
            .map((p) => (
              <option key={p.id} value={`project:${p.id}`}>
                {t('pet.followProject', { name: p.name })}
              </option>
            ))}
          {team.agents.map((a) => (
            <option key={a.id} value={`agent:${a.id}`}>
              {t('pet.followAgent', { name: a.name })}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.bridge} onChange={(e) => patch({ bridge: e.target.checked })} /> {t('pet.bridge')}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.bubbles} onChange={(e) => patch({ bubbles: e.target.checked })} /> {t('pet.bubbles')}
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.overlay} onChange={(e) => patch({ overlay: e.target.checked })} /> {t('pet.browserOverlay')}
      </label>
      <p className="notes">{t('pet.optional')}</p>
      <p className="notes">{t('pet.safari')}</p>
      <p className="notes">{t('pet.attribution')}</p>
      {upstreamError && <p className="form-error">{upstreamError}</p>}
      {running && upstream?.Settings && (
        <div className="dsh-pet-upstream-settings">
          <h4>{t('pet.settingsUpstream')}</h4>
          <upstream.Settings />
        </div>
      )}
    </section>
  )
}
