import { useState } from 'react'
import type { NativePetSettings } from '../../../shared/desktop'
import { DEFAULT_PET_PREFS, type PetPrefs } from '../../../shared/presence'
import type { Project, Team } from '../../../shared/types'
import type { DesktopBridge } from '../companion'

interface PetSettingsProps {
  team: Team
  projects: Project[]
  prefs: PetPrefs
  onPrefs: (p: PetPrefs) => void
  /** Present only in the desktop app. */
  bridge?: DesktopBridge
  native?: NativePetSettings
}

function FollowSelect({ id, value, team, projects, onChange }: { id: string; value: string; team: Team; projects: Project[]; onChange: (v: string) => void }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="team">The whole team</option>
      <optgroup label="A project">
        {projects
          .filter((p) => !p.archived)
          .map((p) => (
            <option key={p.id} value={`project:${p.id}`}>
              {p.name}
            </option>
          ))}
      </optgroup>
      <optgroup label="An employee">
        {team.agents.map((a) => (
          <option key={a.id} value={`agent:${a.id}`}>
            {a.name} · {a.role}
          </option>
        ))}
      </optgroup>
    </select>
  )
}

/** Companion settings: the in-page pet (this browser) and, in the desktop app, the desktop pet. */
export function PetSettings({ team, projects, prefs, onPrefs, bridge, native }: PetSettingsProps) {
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<PetPrefs>) => onPrefs({ ...prefs, ...patch })
  const setNative = (patch: Partial<Omit<NativePetSettings, 'position'>>) => {
    if (!bridge) return
    setError(null)
    bridge.setPetSettings(patch).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className="pet-settings">
      <fieldset>
        <legend>In-app pet (this browser)</legend>
        <label className="check">
          <input type="checkbox" checked={prefs.visible} onChange={(e) => set({ visible: e.target.checked })} /> Show the pet in this window
        </label>
        {bridge && native?.visible && <p className="hint">Hidden while the desktop pet is shown, so you never see two.</p>}
        <label className="field-inline" htmlFor="pet-follow">
          Follow
        </label>
        <FollowSelect id="pet-follow" value={prefs.follow} team={team} projects={projects} onChange={(follow) => set({ follow })} />
        <label className="field-inline" htmlFor="pet-scale">
          Size {Math.round(prefs.scale * 100)}%
        </label>
        <input id="pet-scale" type="range" min={0.5} max={2} step={0.1} value={prefs.scale} onChange={(e) => set({ scale: Number(e.target.value) })} />
        <label className="check">
          <input type="checkbox" checked={prefs.paused} onChange={(e) => set({ paused: e.target.checked })} /> Pause animations
        </label>
        <button type="button" className="btn btn-pill" onClick={() => set({ x: DEFAULT_PET_PREFS.x, y: DEFAULT_PET_PREFS.y })}>
          Reset position
        </button>
        <p className="hint">Drag the pet to move it. Animations also stop when your system asks for reduced motion. Stored in this browser only.</p>
      </fieldset>
      <fieldset>
        <legend>Desktop pet (desktop app)</legend>
        {bridge && native ? (
          <>
            <label className="check">
              <input type="checkbox" checked={native.visible} onChange={(e) => setNative({ visible: e.target.checked })} /> Show the desktop pet
            </label>
            <label className="field-inline" htmlFor="native-follow">
              Follow
            </label>
            <FollowSelect id="native-follow" value={native.follow} team={team} projects={projects} onChange={(follow) => setNative({ follow })} />
            <label className="field-inline" htmlFor="native-scale">
              Size {Math.round(native.scale * 100)}%
            </label>
            <input id="native-scale" type="range" min={0.5} max={2} step={0.1} value={native.scale} onChange={(e) => setNative({ scale: Number(e.target.value) })} />
            <label className="check">
              <input type="checkbox" checked={native.alwaysOnTop} onChange={(e) => setNative({ alwaysOnTop: e.target.checked })} /> Always on top of other windows
            </label>
            <label className="check">
              <input type="checkbox" checked={native.clickThrough} onChange={(e) => setNative({ clickThrough: e.target.checked })} /> Click-through (clicks reach the windows below)
            </label>
            {native.clickThrough && <p className="hint">The pet ignores the mouse now. Turn this off here, or from the menu bar: Pet → Clickable pet.</p>}
            <label className="check">
              <input type="checkbox" checked={native.paused} onChange={(e) => setNative({ paused: e.target.checked })} /> Pause animations
            </label>
            <p className="hint">Drag the desktop pet to move it; its place is remembered per display and brought back on screen if that display is gone. Click it to open the related project or approval here. It never starts at login.</p>
            {error && <p className="hint bad">{error}</p>}
          </>
        ) : (
          <p className="hint">
            A pet on your desktop, outside this window (always on top, click-through, placement on any display), needs the desktop app: run <code>npm run desktop</code>. These options do not exist in a browser; the in-app pet above works everywhere.
          </p>
        )}
      </fieldset>
    </div>
  )
}
