import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../desktop/app.cjs', import.meta.url), 'utf8')
const bootstrap = source.slice(0, source.indexOf('async function startServer()'))

for (const isPackaged of [true, false]) {
  test(`brand rename keeps existing ${isPackaged ? 'packaged' : 'development'} office and session data`, () => {
    const appData = mkdtempSync(path.join(tmpdir(), 'synodica-brand-'))
    const legacy = path.join(appData, isPackaged ? 'OpenGrokBot' : 'opengrokbot')
    mkdirSync(legacy)
    const existing = { 'team.json': '{"agents":[{"id":"saved-role"}]}', 'connection.json': '{"mode":"remote","remoteUrl":"https://office.example"}' }
    for (const [name, text] of Object.entries(existing)) writeFileSync(path.join(legacy, name), text)
    const paths = { appData, userData: path.join(appData, 'Synodica'), sessionData: path.join(appData, 'Synodica') }
    let appName = 'Synodica'
    let lockChecked = false
    const app = {
      isPackaged,
      getPath: (name) => paths[name],
      setPath: (name, value) => { paths[name] = value },
      setName: (value) => { appName = value },
      requestSingleInstanceLock: () => {
        assert.equal(paths.userData, legacy, 'preserve the profile before taking the instance lock')
        assert.equal(paths.sessionData, legacy)
        lockChecked = true
        return true
      },
      on() {},
    }
    try {
      runInNewContext(bootstrap, {
        require: (name) => name === 'electron' ? { app } : require(name),
        process: { env: {} }, __dirname: path.resolve('desktop'), console,
      })
      assert.ok(lockChecked)
      assert.equal(appName, 'Synodica')
      for (const [name, text] of Object.entries(existing)) assert.equal(readFileSync(path.join(paths.userData, name), 'utf8'), text)
    } finally {
      rmSync(appData, { recursive: true, force: true })
    }
  })
}
