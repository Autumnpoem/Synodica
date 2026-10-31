import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import test from 'node:test'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.cjs')
const { Arch } = require('builder-util')

test('afterPack rejects a Windows package without its Claude CLI', async () => {
  const appOutDir = mkdtempSync(join(tmpdir(), 'opengrokbot-package-'))
  try {
    await assert.rejects(
      async () => config.afterPack({ appOutDir, electronPlatformName: 'win32', arch: Arch.x64 }),
      /claude-agent-sdk-win32-x64.*claude\.exe/,
    )
  } finally {
    rmSync(appOutDir, { recursive: true, force: true })
  }
})

test('afterPack accepts the target CLI in a Windows package', async () => {
  const appOutDir = mkdtempSync(join(tmpdir(), 'opengrokbot-package-'))
  try {
    const binary = join(appOutDir, 'resources', 'app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-win32-x64', 'claude.exe')
    mkdirSync(join(binary, '..'), { recursive: true })
    writeFileSync(binary, '')
    await config.afterPack({ appOutDir, electronPlatformName: 'win32', arch: Arch.x64 })
  } finally {
    rmSync(appOutDir, { recursive: true, force: true })
  }
})

test('afterPack checks the macOS app bundle path and native binary name', async () => {
  const appOutDir = mkdtempSync(join(tmpdir(), 'opengrokbot-package-'))
  try {
    const binary = join(appOutDir, 'Synodica.app', 'Contents', 'Resources', 'app', 'node_modules', '@anthropic-ai', 'claude-agent-sdk-darwin-arm64', 'claude')
    mkdirSync(join(binary, '..'), { recursive: true })
    writeFileSync(binary, '')
    await config.afterPack({ appOutDir, electronPlatformName: 'darwin', arch: Arch.arm64, packager: { appInfo: { productFilename: 'Synodica' } } })
  } finally {
    rmSync(appOutDir, { recursive: true, force: true })
  }
})
