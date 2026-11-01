import assert from 'node:assert/strict'
import { chmodSync, copyFileSync, linkSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
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

function nativeNode(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  try {
    linkSync(process.execPath, file)
  } catch {
    copyFileSync(process.execPath, file)
  }
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
  if (process.platform === 'win32') unlinkSync(path.join(bin, 'codex'))
  else chmodSync(path.join(bin, 'codex'), 0o644)
  assert.equal(resolveCodexCommand(opts), chat)
  if (process.platform === 'win32') unlinkSync(chat)
  else chmodSync(chat, 0o644)
  fakeExecutable(codex)
  assert.equal(resolveCodexCommand(opts), codex)
  if (process.platform === 'win32') unlinkSync(codex)
  else chmodSync(codex, 0o644)
  fakeExecutable(homeChat)
  assert.equal(resolveCodexCommand(opts), homeChat)
  assert.equal(resolveCodexCommand({ ...opts, platform: 'linux' }), 'codex')
})

test('runCli uses executable from its own PATH for Codex', async () => {
  const dir = tmp()
  const bin = path.join(dir, 'bin')
  if (process.platform === 'win32') {
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\necho fake-codex\r\n')
  } else fakeExecutable(path.join(bin, 'codex'))
  const result = await runCli('codex', ['--version'], { cwd: dir, env: { ...process.env, PATH: bin }, stdin: '', signal: new AbortController().signal })
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
  const explicit = path.join(dir, process.platform === 'win32' ? 'custom-codex.exe' : 'custom-codex')
  if (process.platform === 'win32') {
    nativeNode(path.join(bin, 'codex.exe'))
    nativeNode(explicit)
    writeFileSync(path.join(dir, 'app-server'), `let input = ''\nprocess.stdin.on('data', chunk => {\n  input += chunk\n  let end\n  while ((end = input.indexOf('\\n')) >= 0) {\n    const line = input.slice(0, end)\n    input = input.slice(end + 1)\n    const msg = JSON.parse(line)\n    if (msg.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n')\n    if (msg.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { account: null, source: process.execPath.includes('custom-codex') ? 'override' : 'path' } }) + '\\n')\n  }\n})\n`)
  } else {
    fakeServer(path.join(bin, 'codex'), 'path')
    fakeServer(explicit, 'override')
  }
  const previousCwd = process.cwd()
  try {
    if (process.platform === 'win32') process.chdir(dir)
    const signal = new AbortController().signal
    const fromPath = await queryCodexAppServer({ env: { ...process.env, PATH: bin }, signal })
    assert.deepEqual(fromPath.account, { account: null, source: 'path' })
    const fromOverride = await queryCodexAppServer({ command: explicit, env: { ...process.env, PATH: bin }, signal })
    assert.deepEqual(fromOverride.account, { account: null, source: 'override' })
  } finally {
    if (process.platform === 'win32') process.chdir(previousCwd)
  }
})
