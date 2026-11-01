import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { resolveCodexCommand, runCli } from './providers/cli.js'
import { queryCodexAppServer } from './usagemeter.js'
import { tmp } from './testkit.js'

function fakeExecutable(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '#!/bin/sh\nprintf "fake-codex\\n"\n')
  chmodSync(file, 0o755)
}

test('Codex executable selection prefers PATH, then macOS ChatGPT/Codex desktop bundles', () => {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  const apps = path.join(dir, 'Applications')
  const home = path.join(dir, 'home')
  const chat = path.join(apps, 'ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  const codex = path.join(apps, 'Codex.app/Contents/Resources/codex-cli/bin/codex')
  const homeChat = path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex')
  const opts = { platform: 'darwin' as const, applications: apps, home, env: { PATH: bin } }
  fakeExecutable(chat)
  assert.equal(resolveCodexCommand(opts), chat)
  fakeExecutable(path.join(bin, 'codex'))
  assert.equal(resolveCodexCommand(opts), 'codex')
  chmodSync(path.join(bin, 'codex'), 0o644)
  assert.equal(resolveCodexCommand(opts), chat)
  chmodSync(chat, 0o644)
  fakeExecutable(codex)
  assert.equal(resolveCodexCommand(opts), codex)
  chmodSync(codex, 0o644)
  fakeExecutable(homeChat)
  assert.equal(resolveCodexCommand(opts), homeChat)
  assert.equal(resolveCodexCommand({ ...opts, platform: 'linux' }), 'codex')
})

test('runCli uses executable from its own PATH for Codex', async () => {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  fakeExecutable(path.join(bin, 'codex'))
  const result = await runCli('codex', ['--version'], { cwd: dir, env: { PATH: bin }, stdin: '', signal: new AbortController().signal })
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.trim(), 'fake-codex')
})

test('usage app-server uses the same PATH selection and honors an explicit command', async () => {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  const fakeServer = (file: string, source: string): void => {
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, `#!/bin/sh\nread line\nprintf '%s\\n' '{"id":1,"result":{}}'\nread line\nread line\nprintf '%s\\n' '{"id":2,"result":{"account":null,"source":"${source}"}}'\n`)
    chmodSync(file, 0o755)
  }
  fakeServer(path.join(bin, 'codex'), 'path')
  const explicit = path.join(dir, 'custom-codex')
  fakeServer(explicit, 'override')
  const signal = new AbortController().signal
  const fromPath = await queryCodexAppServer({ env: { PATH: bin }, signal })
  assert.deepEqual(fromPath.account, { account: null, source: 'path' })
  const fromOverride = await queryCodexAppServer({ command: explicit, env: { PATH: bin }, signal })
  assert.deepEqual(fromOverride.account, { account: null, source: 'override' })
})
