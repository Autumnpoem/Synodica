import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { desktopPaths, migrateLegacyOffice, serverEnv } from './desktopdata.js'
import { HELPER_APP_NAME, HELPER_LAUNCHER_SCRIPT, helperProfileDir, helperProfileFor, petEnv, petHomeDir, petOsHome } from './petruntime.js'
import { tmp } from './testkit.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = [path.join(here, '..'), path.join(here, '..', '..')].find((d) => existsSync(path.join(d, 'desktop', 'pet-helper.cjs'))) as string
const helper = createRequire(import.meta.url)(path.join(root, 'desktop', 'pet-helper.cjs')) as {
  HELPER_APP_NAME: string
  detectHelperLaunch: (argv: unknown, env: Record<string, string | undefined>, exists?: (p: string) => boolean) => { main: string; profile: string } | null
  runHelper: (app: { setPath: (name: string, p: string) => void }, launch: { main: string; profile: string }, load: (p: string) => unknown) => void
}

test('desktop data: defaults live in per-user app data, never the app folder; explicit overrides are kept', () => {
  const userData = tmp('ogb-userdata-')
  const d = desktopPaths({}, userData)
  assert.equal(d.team, path.join(userData, 'team.json'))
  assert.equal(d.data, path.join(userData, 'data'))
  assert.equal(d.workDir, userData)
  assert.deepEqual(d.source, { team: 'user-data', data: 'user-data' })
  assert.ok(!d.team.startsWith(root + path.sep) && !d.data.startsWith(root + path.sep), 'nothing defaults into the checkout or bundle')
  const o = desktopPaths({ OPENGROKBOT_TEAM: ' /srv/office/team.json ', OPENGROKBOT_DATA: 'relative-data' }, userData)
  assert.equal(o.team, path.resolve('/srv/office/team.json'))
  assert.equal(o.data, path.resolve('relative-data'))
  assert.deepEqual(o.source, { team: 'env', data: 'env' })
  assert.deepEqual(desktopPaths({ OPENGROKBOT_TEAM: '   ', OPENGROKBOT_DATA: '' }, userData).source, { team: 'user-data', data: 'user-data' }, 'blank overrides are not paths')
})

test('desktop data: the legacy office is copied once into empty app data; existing app data and env overrides are never replaced', () => {
  const legacyDir = tmp('ogb-legacy-')
  const legacy = { team: path.join(legacyDir, 'team.json'), data: path.join(legacyDir, 'data') }
  writeFileSync(legacy.team, '{"company":"Legacy"}')
  mkdirSync(legacy.data)
  writeFileSync(path.join(legacy.data, 'c.json'), 'legacy')

  const fresh = desktopPaths({}, tmp('ogb-userdata-'))
  const r = migrateLegacyOffice(legacy, fresh)
  assert.deepEqual([r.team, r.data], ['copied', 'copied'])
  assert.equal(readFileSync(fresh.team, 'utf8'), '{"company":"Legacy"}')
  assert.equal(readFileSync(path.join(fresh.data, 'c.json'), 'utf8'), 'legacy')
  assert.ok(existsSync(legacy.team) && existsSync(legacy.data), 'the checkout keeps its files')

  const used = desktopPaths({}, tmp('ogb-userdata-'))
  writeFileSync(used.team, '{"company":"Mine"}')
  mkdirSync(used.data)
  writeFileSync(path.join(used.data, 'c.json'), 'mine')
  const k = migrateLegacyOffice(legacy, used)
  assert.deepEqual([k.team, k.data], ['kept', 'kept'])
  assert.equal(readFileSync(used.team, 'utf8'), '{"company":"Mine"}', 'stored team (with its keys) wins')
  assert.equal(readFileSync(path.join(used.data, 'c.json'), 'utf8'), 'mine')

  const target = tmp('ogb-override-')
  const env = desktopPaths({ OPENGROKBOT_TEAM: path.join(target, 'team.json'), OPENGROKBOT_DATA: path.join(target, 'data') }, tmp('ogb-userdata-'))
  const n = migrateLegacyOffice(legacy, env)
  assert.deepEqual([n.team, n.data], ['none', 'none'])
  assert.ok(!existsSync(env.team) && !existsSync(env.data), 'explicit overrides are left alone')
})

test('desktop data: the server child environment keeps the base environment and an explicit pet Electron', () => {
  const paths = desktopPaths({}, '/u/app')
  const base = { PATH: '/bin', OPENGROKBOT_SOMETHING: 'x' }
  const env = serverEnv(base, { port: 4567, paths, nonce: 'n1', electron: '/opt/app/electron', helperMode: 'app-executable' })
  assert.equal(env.PATH, '/bin')
  assert.equal(env.OPENGROKBOT_SOMETHING, 'x')
  assert.equal(env.PORT, '4567')
  assert.equal(env.OPENGROKBOT_TEAM, paths.team)
  assert.equal(env.OPENGROKBOT_DATA, paths.data)
  assert.equal(env.OPENGROKBOT_PET_ELECTRON, '/opt/app/electron')
  assert.equal(env.OPENGROKBOT_PET_HELPER_MODE, 'app-executable')
  assert.equal(serverEnv({ OPENGROKBOT_PET_ELECTRON: '/custom/electron' }, { port: 1, paths, nonce: 'n', electron: '/opt/app/electron', helperMode: 'launcher' }).OPENGROKBOT_PET_ELECTRON, '/custom/electron')
  assert.equal(base.OPENGROKBOT_SOMETHING, 'x', 'the parent environment object is not modified')
  assert.ok(!('PORT' in base))
})

test('pet helper profile: inside the pet home on every platform; the real home and any DSH profile are never used', () => {
  const realHome = tmp('ogb-realhome-')
  const dataDir = tmp('ogb-data-')
  const home = petHomeDir(dataDir)
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    const dir = helperProfileDir(home, platform)
    const join = platform === 'win32' ? path.win32 : path.posix
    assert.equal(join.basename(dir), HELPER_APP_NAME)
    // Containment is judged with the target platform's path rules: on a POSIX host the win32 result
    // is the same folder written with backslashes, so a plain string prefix would misjudge it.
    const rel = join.relative(join.normalize(petOsHome(home)), dir)
    assert.ok(rel !== '' && !rel.startsWith('..') && !join.isAbsolute(rel), `${platform}: under the pet's own OS home`)
  }
  const electron = path.join(tmp('ogb-electron-'), 'electron')
  writeFileSync(electron, '')
  const env = petEnv({ HOME: realHome, USERPROFILE: realHome, DSH_HOME: path.join(realHome, '.dsh'), OPENAI_API_KEY: 'redacted', PATH: '/bin' }, home, electron, { helper: { mode: 'launcher', appEntry: '/opt/app/desktop/main.cjs' }, platform: 'linux' })
  assert.equal(env.DSH_HOME, home)
  assert.equal(env.HOME, petOsHome(home))
  assert.equal(env.OPENGROKBOT_PET_HELPER_PROFILE, helperProfileDir(home, 'linux'))
  assert.equal(env.OPENAI_API_KEY, undefined)
  for (const [k, v] of Object.entries(env)) assert.ok(!String(v).startsWith(realHome), `${k} does not point into the user's real home`)
  assert.equal(petEnv({ USERPROFILE: realHome }, home, undefined, { platform: 'win32' }).USERPROFILE, petOsHome(home))
  assert.deepEqual(helperProfileFor(home, electron, { helper: { mode: 'app-executable' }, platform: 'darwin' }), { dir: helperProfileDir(home, 'darwin'), isolated: true })
  assert.equal(helperProfileFor(home, electron, { platform: 'win32' }).isolated, false, 'the one unroutable launch is reported, not hidden')
  assert.doesNotMatch(HELPER_LAUNCHER_SCRIPT, /\/(home|Users|opt)\//, 'the generated launcher holds no paths')
})

test('pet helper entry: only the verified package helper is run, and only after every profile path is moved into the pet home', () => {
  assert.equal(helper.HELPER_APP_NAME, HELPER_APP_NAME, 'the CommonJS entry and the server agree on the folder name')
  const pkg = tmp('ogb-pkg-')
  const main = path.join(pkg, 'runtime', 'electron-helper', 'main.js')
  const profile = helperProfileDir(petHomeDir(tmp('ogb-data-')), process.platform)
  const env = { OPENGROKBOT_PET_HELPER_PROFILE: profile, OPENGROKBOT_PET_PACKAGE_ROOT: pkg }
  const exists = (p: string) => p === main
  assert.deepEqual(helper.detectHelperLaunch(['electron', main], env, exists), { main, profile })
  assert.equal(helper.detectHelperLaunch(['electron', '/elsewhere/main.js'], env, exists), null, 'another script is not run')
  assert.equal(helper.detectHelperLaunch(['electron', main], { ...env, OPENGROKBOT_PET_HELPER_PROFILE: path.join(pkg, 'other') }, exists), null, 'a profile of another name is refused')
  assert.equal(helper.detectHelperLaunch(['electron', main], { ...env, OPENGROKBOT_PET_HELPER_PROFILE: 'relative/dsh-pet-electron-helper' }, exists), null)
  assert.equal(helper.detectHelperLaunch(['electron', main], {}, exists), null, 'an ordinary app launch is not helper mode')
  assert.equal(helper.detectHelperLaunch(['electron', main], env, () => false), null)

  const order: string[] = []
  const app = { setPath: (name: string, p: string) => order.push(`${name}=${p}`) }
  helper.runHelper(app, { main, profile }, (p) => order.push(`load ${p}`))
  assert.ok(existsSync(profile))
  assert.deepEqual(order, [`userData=${profile}`, `sessionData=${profile}`, `crashDumps=${path.join(profile, 'Crashpad')}`, `load ${main}`])
})
