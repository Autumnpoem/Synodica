#!/usr/bin/env node
// Installs the pinned upstream pet package (dsh-pet 0.3.8, MIT, PC2005-cloud) into pet-runtime/
// from the npm registry and verifies it: registry integrity in the lockfile, version, license,
// the original runtime files and the packaged animations. Install scripts are disabled and peer
// packages are not auto-installed. Only the four explicitly pinned host libraries
// needed by the public balance extension are installed; no DSH CLI is installed. Nothing from the package is copied into the
// repository; pet-runtime/node_modules and its lockfile stay out of Git.
//
//   npm run pet:install            install (or repair) and verify
//   npm run pet:install -- --check verify an existing install only
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED = {
  name: 'dsh-pet',
  version: '0.3.8',
  integrity: 'sha512-E1ymE0/a1k2MJco2JDcWeqwMttjWNZWt5yMEN+jjKwWD+H2XT5OMUDmazMLhNnN5grmL9+lbE94iyEQMn5p+JA==',
  tarball: 'https://registry.npmjs.org/dsh-pet/-/dsh-pet-0.3.8.tgz',
}

const HOST_LIBRARIES = {
  '@deepseek-ai/cordis': '4.0.4',
  '@deepseek-ai/dsh-home-paths': '0.2.0-rc.1',
  '@deepseek-ai/dsh-credentials': '0.2.0-rc.1',
  '@deepseek-ai/dsh-llm': '0.2.0-rc.1',
}

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(appRoot, 'pet-runtime')
const pkgDir = path.join(dir, 'node_modules', PINNED.name)
const checkOnly = process.argv.includes('--check')

function fail(message) {
  console.error(`[pet:install] ${message}`)
  process.exit(1)
}

if (!checkOnly) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  console.log(`[pet:install] installing ${PINNED.name}@${PINNED.version} into ${dir} (no install scripts, no peers)`)
  const r = spawnSync(npm, ['install', '--prefix', dir, '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--save-exact'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) fail('npm install failed. Check the network or the registry, then run `npm run pet:install` again. Nothing was changed outside pet-runtime/.')
}

const lockFile = path.join(dir, 'package-lock.json')
if (!existsSync(lockFile)) fail('pet-runtime/package-lock.json is missing; run `npm run pet:install`.')
const lock = JSON.parse(readFileSync(lockFile, 'utf8'))
const entry = lock.packages?.[`node_modules/${PINNED.name}`]
if (!entry) fail('dsh-pet is not in pet-runtime/package-lock.json; run `npm run pet:install`.')
if (entry.version !== PINNED.version) fail(`locked version ${entry.version} is not the pinned ${PINNED.version}.`)
if (entry.integrity !== PINNED.integrity) fail(`registry integrity ${entry.integrity} does not match the pinned ${PINNED.integrity}. Do not use this install.`)
if (entry.resolved && entry.resolved !== PINNED.tarball) fail(`resolved from ${entry.resolved}, expected the official tarball ${PINNED.tarball}.`)

if (!existsSync(pkgDir)) fail(`${pkgDir} is missing; run \`npm run pet:install\`.`)
const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
if (manifest.name !== PINNED.name || manifest.version !== PINNED.version) fail(`installed ${manifest.name}@${manifest.version}, expected ${PINNED.name}@${PINNED.version}.`)
if (manifest.license !== 'MIT') fail('the installed package is not the MIT-licensed release.')
for (const rel of ['LICENSE', 'lib/standalone.js', 'lib/client.js', 'lib/index.js', 'assets/config.jsonc', 'runtime/electron-helper/main.js']) {
  if (!existsSync(path.join(pkgDir, rel))) fail(`${rel} is missing from the installed package; run \`npm run pet:install\` again.`)
}
// The plugin's public apply(ctx) entry imports these runtime interfaces. The host supplies
// no credential or model service; they only let the unmodified plugin load its balance hook.
for (const [name, version] of Object.entries(HOST_LIBRARIES)) {
  const file = path.join(dir, 'node_modules', name, 'package.json')
  if (!existsSync(file)) fail(`${name} is missing; run npm run pet:install.`)
  const installed = JSON.parse(readFileSync(file, 'utf8'))
  if (installed.version !== version) fail(`${name} is not the pinned ${version}.`)
}
const webm = readdirSync(path.join(pkgDir, 'assets', 'webm')).filter((f) => f.endsWith('.webm')).length
if (webm === 0) fail('the packaged animations (assets/webm) are missing.')
console.log(`[pet:install] ok: ${PINNED.name}@${PINNED.version}, integrity verified, ${webm} original animations, license MIT (Copyright 2026 PC2005-cloud).`)
console.log('[pet:install] start Synodica and turn the pet on in Office -> Desktop pet.')
