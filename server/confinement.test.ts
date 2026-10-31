// Real-path confinement: workspace checks, shared-file mirroring, API local tools, file serving,
// artifacts, and the read-only / no-shell turn modes of each adapter.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { PROVIDER_CAPABILITIES } from '../shared/catalog.js'
import { allowedRealFile, canonicalPath, confine, isInside, overlaps } from './paths.js'
import { checkWorkspace, writeProjectFiles } from './projectio.js'
import { buildQueryOptions } from './providers/claude.js'
import { sandboxFor } from './providers/codex.js'
import { allowedLocalTools, runLocalTool, type LocalToolPolicy } from './providers/localexec.js'
import { runOpenAiTurn, type FetchLike } from './providers/openai.js'
import { enforcesReadOnly } from './providers/types.js'
import { member, mixedTeam, tmp } from './testkit.js'
import { resolveArtifacts } from './workflow.js'
import type { Conversation, Project } from '../shared/types.js'

const confined: LocalToolPolicy = { allowOutside: false, shell: true, readOnly: false }
const signal = new AbortController().signal
const run = (name: string, args: Record<string, unknown>, cwd: string, policy: LocalToolPolicy = confined) => runLocalTool(name, args, cwd, policy, signal)

/** A workspace with an outside secret, a symlinked file and a symlinked folder pointing at it. */
function trap() {
  const base = realpathSync.native(tmp('ogb-trap-'))
  const ws = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  mkdirSync(ws)
  mkdirSync(outside)
  writeFileSync(path.join(outside, 'secret.txt'), 'TOP-SECRET\n')
  writeFileSync(path.join(ws, 'ok.txt'), 'fine\n')
  symlinkSync(path.join(outside, 'secret.txt'), path.join(ws, 'link.txt'))
  symlinkSync(outside, path.join(ws, 'linkdir'), 'dir')
  return { base, ws, outside }
}

test('paths: canonical paths resolve symlinks and dangling links; containment is not a string prefix', () => {
  const { base, ws, outside } = trap()
  assert.equal(canonicalPath(path.join(ws, 'linkdir', 'new', 'file.txt')), path.join(outside, 'new', 'file.txt'), 'a symlinked parent decides where a new file lands')
  symlinkSync(path.join(outside, 'not-yet.txt'), path.join(ws, 'dangling'))
  assert.equal(canonicalPath(path.join(ws, 'dangling')), path.join(outside, 'not-yet.txt'), 'a dangling link is followed to its target')
  assert.equal(isInside(path.join(base, 'ws-evil'), ws), false, 'a sibling with the same prefix is outside')
  assert.equal(isInside(path.join(ws, '..', 'outside'), ws), false)
  assert.equal(overlaps(path.join(ws, 'sub'), ws), true)
  assert.equal(overlaps(ws, path.join(ws, 'sub')), true)
  assert.throws(() => confine(ws, 'linkdir/secret.txt'), /outside the working folder/)
  assert.equal(confine(ws, 'new/a.txt'), path.join(ws, 'new', 'a.txt'))
})

test('workspace check compares real paths: symlinks into the checkout, home or system folders are refused', () => {
  const base = realpathSync.native(tmp('ogb-wsck-'))
  const app = path.join(base, 'app')
  const home = path.join(base, 'home')
  const data = path.join(base, 'data')
  for (const d of [app, home, path.join(home, '.ssh'), data, path.join(base, 'links')]) mkdirSync(d, { recursive: true })
  const rules = { appRoot: app, home, denied: [data] }
  symlinkSync(app, path.join(base, 'links', 'to-app'), 'dir')
  symlinkSync(home, path.join(base, 'links', 'to-home'), 'dir')
  symlinkSync(path.join(home, '.ssh'), path.join(base, 'links', 'to-ssh'), 'dir')
  symlinkSync(data, path.join(base, 'links', 'to-data'), 'dir')
  symlinkSync(path.join(app, 'not-yet'), path.join(base, 'links', 'dangling-into-app'))

  assert.equal(checkWorkspace(path.join(base, 'links', 'to-app'), rules).ok, false, 'an existing symlink resolving to the checkout')
  assert.equal(checkWorkspace(path.join(base, 'links', 'to-app', 'new-project'), rules).ok, false, 'a new folder under a symlinked parent inside the checkout')
  assert.equal(existsSync(path.join(app, 'new-project')), false, 'nothing was created inside the checkout')
  assert.equal(checkWorkspace(path.join(base, 'links', 'dangling-into-app'), rules).ok, false, 'a dangling link pointing into the checkout')
  assert.equal(checkWorkspace(path.join(base, 'links', 'to-home'), rules).ok, false, 'an alias of the home folder')
  assert.equal(checkWorkspace(path.join(base, 'links', 'to-ssh', 'proj'), rules).ok, false, 'hidden settings folders in home')
  assert.equal(checkWorkspace(path.join(base, 'links', 'to-data', 'proj'), rules).ok, false, 'the data folder')
  assert.equal(checkWorkspace(base, rules).ok, false, 'a folder containing the checkout')
  if (process.platform !== 'win32') assert.equal(checkWorkspace('/etc/ogb-project', rules).ok, false, 'system folders')

  const good = checkWorkspace(path.join(home, 'projects', 'todo'), rules)
  assert.ok(good.ok)
  symlinkSync(path.join(home, 'projects'), path.join(base, 'links', 'to-projects'), 'dir')
  const viaAlias = checkWorkspace(path.join(base, 'links', 'to-projects', 'shop'), rules)
  assert.ok(viaAlias.ok)
  assert.equal(viaAlias.path, path.join(home, 'projects', 'shop'), 'the stored workspace is the real path')
})

test('shared notes are never written through a symlinked .opengrokbot folder, file or workspace', () => {
  const { base, ws, outside } = trap()
  const app = path.join(base, 'app')
  mkdirSync(app)
  const rules = { appRoot: app, home: path.join(base, 'home') }
  const p = { id: 'p', name: 'P', workspace: ws, brief: 'b', critiques: [], decisions: [], tasks: [] } as unknown as Project
  const name = (id: string) => id

  symlinkSync(outside, path.join(ws, '.opengrokbot'), 'dir')
  assert.throws(() => writeProjectFiles(p, name, rules), /symbolic link/)
  assert.equal(existsSync(path.join(outside, 'brief.md')), false)

  const ws2 = path.join(base, 'ws2')
  mkdirSync(path.join(ws2, '.opengrokbot'), { recursive: true })
  symlinkSync(path.join(outside, 'secret.txt'), path.join(ws2, '.opengrokbot', 'brief.md'))
  assert.throws(() => writeProjectFiles({ ...p, workspace: ws2 }, name, rules), /symbolic link/)
  assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'TOP-SECRET\n', 'the link target is untouched')

  symlinkSync(app, path.join(base, 'ws-into-app'), 'dir')
  assert.throws(() => writeProjectFiles({ ...p, workspace: path.join(base, 'ws-into-app') }, name, rules), /Synodica app folder/)
  assert.equal(existsSync(path.join(app, '.opengrokbot')), false)

  const ws3 = path.join(base, 'ws3')
  mkdirSync(ws3)
  assert.equal(writeProjectFiles({ ...p, workspace: ws3 }, name, rules).length, 3)
  assert.match(readFileSync(path.join(ws3, '.opengrokbot', 'brief.md'), 'utf8'), /# P/)
})

test('API local tools: symlinked files and symlinked parent folders cannot read, write, edit, list or search outside', async () => {
  const { base, ws, outside } = trap()
  assert.match(await run('read_file', { path: 'link.txt' }, ws), /outside the working folder/)
  assert.match(await run('read_file', { path: 'linkdir/secret.txt' }, ws), /outside the working folder/)
  assert.match(await run('read_file', { path: '../outside/secret.txt' }, ws), /outside the working folder/)
  assert.match(await run('read_file', { path: 'ok.txt' }, ws), /fine/)

  assert.match(await run('write_file', { path: 'linkdir/planted.txt', content: 'x' }, ws), /outside the working folder/)
  assert.match(await run('write_file', { path: 'linkdir/deep/new/planted.txt', content: 'x' }, ws), /outside the working folder/)
  assert.equal(existsSync(path.join(outside, 'planted.txt')), false)
  assert.equal(existsSync(path.join(outside, 'deep')), false, 'no folders were created outside either')
  assert.match(await run('write_file', { path: 'link.txt', content: 'overwritten' }, ws), /outside the working folder/)
  symlinkSync(path.join(outside, 'dangling-target.txt'), path.join(ws, 'dangling'))
  assert.match(await run('write_file', { path: 'dangling', content: 'x' }, ws), /outside the working folder/)
  assert.equal(existsSync(path.join(outside, 'dangling-target.txt')), false)
  assert.match(await run('write_file', { path: path.join(base, 'ws-evil', 'x.txt'), content: 'x' }, ws), /outside the working folder/, 'a sibling folder with the same prefix')
  assert.match(await run('edit_file', { path: 'link.txt', old_text: 'TOP', new_text: 'PWN' }, ws), /outside the working folder/)
  assert.equal(readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'TOP-SECRET\n')

  assert.match(await run('write_file', { path: 'src/new/a.txt', content: 'hello' }, ws), /Wrote/)
  assert.equal(readFileSync(path.join(ws, 'src', 'new', 'a.txt'), 'utf8'), 'hello')
  assert.match(await run('edit_file', { path: 'src/new/a.txt', old_text: 'hello', new_text: 'bye' }, ws), /Edited/)

  const listed = await run('list_files', { pattern: '**/*' }, ws)
  assert.ok(listed.includes('ok.txt') && listed.includes('src/new/a.txt'))
  assert.ok(!listed.includes('secret.txt') && !listed.includes('link.txt'), listed)
  assert.equal(await run('search_files', { pattern: 'TOP-SECRET' }, ws), 'No matches.')
  assert.match(await run('search_files', { pattern: 'TOP', path: 'linkdir' }, ws), /outside the working folder/)

  // Ordinary chats with permission bypass keep the previous, unconfined behaviour.
  assert.match(await run('read_file', { path: 'link.txt' }, ws, { allowOutside: true, shell: true, readOnly: false }), /TOP-SECRET/)
})

test('API shell: disabled in project and read-only turns (not offered, and refused if called anyway)', async () => {
  const ws = tmp('ogb-shell-')
  const marker = path.join(ws, 'ran.txt')
  const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`
  assert.match(await run('run_command', { command }, ws, { allowOutside: false, shell: false, readOnly: false }), /disabled/)
  assert.match(await run('write_file', { path: 'a.txt', content: 'x' }, ws, { allowOutside: false, shell: false, readOnly: true }), /read-only/)
  assert.equal(existsSync(marker), false)
  assert.equal(existsSync(path.join(ws, 'a.txt')), false)
  const all = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebFetch']
  assert.deepEqual(allowedLocalTools(all, { shell: false, readOnly: false }).map((t) => t.name).sort(), ['edit_file', 'fetch_url', 'list_files', 'read_file', 'search_files', 'write_file'])
  assert.deepEqual(allowedLocalTools(all, { shell: false, readOnly: true }).map((t) => t.name).sort(), ['fetch_url', 'list_files', 'read_file', 'search_files'])
  assert.ok(allowedLocalTools(all, { shell: true, readOnly: false }).some((t) => t.name === 'run_command'), 'ordinary chats keep the shell')

  // The adapter offers the model no shell in a project turn, and only read tools in a review.
  const team = mixedTeam(ws)
  const agent = member('junior', 'deepseek', ['implementer'], { tools: all })
  const conversation: Conversation = { id: 'c', kind: 'group', name: 'P', memberIds: ['user', 'junior'], messages: [{ id: 'm', conversationId: 'c', authorId: 'user', text: 'hi', createdAt: 1, status: 'done' }], sessions: {} }
  const offered: string[][] = []
  const fake: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { tools?: { function: { name: string } }[] }
    offered.push((body.tools ?? []).map((t) => t.function.name).sort())
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`, { status: 200 })
  }
  const provider = team.providers.deepseek
  assert.ok(provider)
  const base = { team, conversation, agent, provider, sessionId: undefined, signal, handlers: { onDelta: () => {}, onActivity: () => {}, onSession: () => {} }, cwd: ws }
  await runOpenAiTurn({ ...base, safe: true }, fake)
  await runOpenAiTurn({ ...base, safe: true, readOnly: true }, fake)
  await runOpenAiTurn(base, fake)
  assert.ok(!offered[0]?.includes('run_command') && offered[0]?.includes('write_file'), 'project turn: files yes, shell no')
  assert.deepEqual(offered[1], ['fetch_url', 'list_files', 'read_file', 'search_files'], 'review turn: read tools only')
  assert.ok(offered[2]?.includes('run_command'), 'ordinary chat: unchanged')
})

test('read-only turns per adapter: Claude drops write tools and MCP, Codex uses its read-only sandbox, Gemini is not trusted', () => {
  const ws = tmp('ogb-ro-')
  const team = mixedTeam(ws)
  team.mcpServers = { fs: { type: 'stdio', command: 'fs-server' } }
  const agent = member('qa', 'claude', ['tester'], { tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write', 'Bash', 'NotebookEdit', 'Task'], mcpServers: ['fs'], permissionMode: 'bypassPermissions', autoApproveTools: true, inheritClaudeSettings: true })
  const conversation: Conversation = { id: 'c', kind: 'dm', name: 'x', memberIds: ['user', 'qa'], messages: [], sessions: {} }
  const provider = team.providers.claude
  assert.ok(provider)
  const o = buildQueryOptions(team, conversation, agent, provider, undefined, new AbortController(), undefined, '', { safe: true, readOnly: true, cwd: ws })
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep'])
  assert.deepEqual(o.allowedTools, ['Read', 'Glob', 'Grep'])
  assert.equal(o.mcpServers, undefined)
  assert.equal(o.permissionMode, 'dontAsk')
  assert.equal(o.allowDangerouslySkipPermissions, undefined)
  assert.equal(o.canUseTool, undefined, 'nothing auto-approves writes')
  assert.deepEqual(o.settingSources, [], 'no inherited user settings can add tools')

  assert.equal(sandboxFor(['Read', 'Edit', 'Write', 'Bash'], false, true), 'read-only')
  assert.equal(sandboxFor(['Read', 'Edit', 'Write', 'Bash'], true, true), 'read-only', 'read-only beats any bypass')
  assert.equal(sandboxFor(['Read', 'Edit'], false), 'workspace-write', 'work turns unchanged')

  assert.equal(enforcesReadOnly('claude'), true)
  assert.equal(enforcesReadOnly('codex'), true)
  assert.equal(enforcesReadOnly('openai'), true)
  assert.equal(enforcesReadOnly('gemini'), false)
  assert.equal(PROVIDER_CAPABILITIES.openai.projectShell, false, 'the API shell limitation is declared')
  assert.match(PROVIDER_CAPABILITIES.openai.notes, /not a sandbox/)
})

test('file serving: real path inside an allowed root only; symlinks, .. and denied files are refused', () => {
  const { base, ws, outside } = trap()
  const team = path.join(ws, 'team.json')
  writeFileSync(team, '{"apiKey":"x"}')
  assert.equal(allowedRealFile(path.join(ws, 'ok.txt'), [ws]), path.join(ws, 'ok.txt'))
  assert.equal(allowedRealFile(path.join(ws, 'link.txt'), [ws]), undefined, 'a symlink inside the workspace to an outside file')
  assert.equal(allowedRealFile(path.join(ws, 'linkdir', 'secret.txt'), [ws]), undefined, 'a symlinked parent folder')
  assert.equal(allowedRealFile(`${ws}/../outside/secret.txt`, [ws]), undefined, 'lexical ..')
  assert.equal(allowedRealFile('relative.txt', [ws]), undefined)
  mkdirSync(path.join(base, 'ws-evil'))
  writeFileSync(path.join(base, 'ws-evil', 'x.txt'), 'x')
  assert.equal(allowedRealFile(path.join(base, 'ws-evil', 'x.txt'), [ws]), undefined, 'prefix sibling')
  assert.equal(allowedRealFile(team, [ws], [team]), undefined, 'denied files are never served')
  // A root given through a symlink alias still works for files really inside it.
  symlinkSync(ws, path.join(base, 'alias'), 'dir')
  assert.equal(allowedRealFile(path.join(base, 'alias', 'ok.txt'), [path.join(base, 'alias')]), path.join(ws, 'ok.txt'))
  assert.equal(allowedRealFile(path.join(outside, 'secret.txt'), [path.join(base, 'alias')]), undefined)
})

test('handoff artifacts: a symlink pointing outside the workspace is not recorded as delivered', () => {
  const { ws } = trap()
  const r = resolveArtifacts(['ok.txt', 'link.txt', 'linkdir/secret.txt'], ws)
  assert.deepEqual(r.found, [path.join(ws, 'ok.txt')])
  assert.deepEqual(r.missing, ['link.txt', 'linkdir/secret.txt'])
})
