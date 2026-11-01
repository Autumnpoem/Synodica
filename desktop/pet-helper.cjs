// Helper mode of Synodica's Electron entry: the upstream dsh-pet host starts its desktop helper
// with this app's Electron (DSH_PET_ELECTRON_PATH). Before the upstream helper (runtime/electron-helper
// /main.js, unmodified) runs, its Electron profile is moved into Synodica's dedicated pet home with
// the documented app.setPath API. Its loadFile('index.html') also needs the original helper folder
// as Electron's app root. Upstream then calls app.setName('dsh-pet-electron-helper'), which no
// longer changes where userData is: an explicit path wins over the name-derived default. The user's
// global Application Support / AppData / ~/.config folder of that name is never created or read.
const fs = require('node:fs')
const path = require('node:path')

const HELPER_APP_NAME = 'dsh-pet-electron-helper'

/**
 * Is this process the pet's desktop helper? Only when the server's pet host asked for it: the profile
 * and the verified package come from its environment, and the helper script named on the command
 * line must be exactly that package's runtime/electron-helper/main.js.
 * @returns {{ main: string, profile: string } | null}
 */
function detectHelperLaunch(argv, env, exists = fs.existsSync) {
  const profile = typeof env.OPENGROKBOT_PET_HELPER_PROFILE === 'string' ? env.OPENGROKBOT_PET_HELPER_PROFILE : ''
  const root = typeof env.OPENGROKBOT_PET_PACKAGE_ROOT === 'string' ? env.OPENGROKBOT_PET_PACKAGE_ROOT : ''
  if (!profile || !root || !path.isAbsolute(profile) || !path.isAbsolute(root)) return null
  if (path.basename(profile) !== HELPER_APP_NAME) return null
  const main = path.join(path.resolve(root), 'runtime', 'electron-helper', 'main.js')
  const named = (Array.isArray(argv) ? argv.slice(1) : []).some((a) => typeof a === 'string' && !a.startsWith('-') && path.resolve(a) === main)
  if (!named || !exists(main)) return null
  return { main, profile: path.resolve(profile) }
}

/** Point every profile path of this Electron process into the dedicated folder, then run the upstream helper. */
function runHelper(app, launch, load = require) {
  fs.mkdirSync(launch.profile, { recursive: true, mode: 0o700 })
  app.setPath('userData', launch.profile)
  app.setPath('sessionData', launch.profile)
  try {
    app.setPath('crashDumps', path.join(launch.profile, 'Crashpad'))
  } catch {
    // Older Electron without a settable crash dump path: nothing is written there unless a crash reporter starts.
  }
  app.setAppPath(path.dirname(launch.main))
  load(launch.main)
}

module.exports = { HELPER_APP_NAME, detectHelperLaunch, runHelper }
