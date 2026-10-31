// Explicit distribution allowlist: office data and credentials never enter an application package.
const { existsSync } = require('node:fs')
const { join } = require('node:path')
const { Arch } = require('builder-util')

module.exports = {
  // Keep the installed application's identity so existing OS integrations survive the rename.
  appId: 'org.opengrokbot.office',
  productName: 'Synodica',
  directories: { output: 'release', buildResources: 'build' },
  asar: false,
  npmRebuild: false,
  files: [
    'dist/client/**/*', 'dist/server/**/*.js', 'dist/shared/**/*.js',
    '!dist/server/**/*.test.js', '!dist/server/testkit.js',
    'desktop/**/*', 'build/icon.png', 'team.example.json', 'package.json',
    'THIRD_PARTY_NOTICES.md', 'LICENSE', 'NOTICE', 'licenses/**/*',
  ],
  extraResources: [{ from: 'pet-runtime/node_modules', to: 'app/pet-runtime/node_modules', filter: ['**/*'] }],
  afterPack(context) {
    const { appOutDir, electronPlatformName: platform, arch } = context
    const target = `${platform}-${Arch[arch]}`
    const appDir = platform === 'darwin'
      ? join(appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app')
      : join(appOutDir, 'resources', 'app')
    const binary = join(appDir, 'node_modules', '@anthropic-ai', `claude-agent-sdk-${target}`, platform === 'win32' ? 'claude.exe' : 'claude')
    if (!existsSync(binary)) {
      // Upstream SDK requires installing the matching optional platform package for cross-builds.
      throw new Error(`Missing Claude SDK native CLI in package: ${binary}. Install @anthropic-ai/claude-agent-sdk-${target} before packaging (cross-builds require the target platform package).`)
    }
  },
  mac: { target: ['dmg', 'zip'], category: 'public.app-category.productivity', identity: null, icon: 'build/icon.png', extendInfo: { CFBundleDisplayName: '\u661f\u8bae · Synodica' } },
  win: { target: ['zip'], icon: 'build/icon.png', signExecutable: false },
  linux: { target: ['AppImage'], category: 'Development', icon: 'build/icon.png' },
  artifactName: 'Synodica-${version}-${os}-${arch}.${ext}',
}
