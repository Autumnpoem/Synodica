import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { PRESENCE_LABEL, type Tone } from '../shared/presence.js'
import type { CorrectionStatus, ProjectPhase, TaskTier, WorkflowRole } from '../shared/types.js'
import { detectLocale, EN, extraKeys, initialReplyLanguage, isFreshOffice, loadLocale, LOCALE_NAMES, LOCALE_STORAGE_KEY, missingKeys, placeholders, replyLanguageFor, RESOURCES, saveLocale, translate, ZH_CN, type MessageKey } from '../shared/i18n.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = [path.join(here, '..'), path.join(here, '..', '..')].find((d) => {
  try {
    readFileSync(path.join(d, 'shared', 'i18n.ts'))
    return true
  } catch {
    return false
  }
}) as string

// CJK Unified Ideographs, U+4E00..U+9FFF (built from code points so this file stays ASCII).
const CJK = new RegExp(`[${String.fromCharCode(0x4e00)}-${String.fromCharCode(0x9fff)}]`)
const ELLIPSIS = String.fromCharCode(0x2026)

test('the Simplified Chinese resource is complete, has no stray keys and keeps every placeholder', () => {
  assert.deepEqual(missingKeys('zh-CN'), [])
  assert.deepEqual(extraKeys('zh-CN'), [])
  for (const key of Object.keys(EN) as MessageKey[]) {
    assert.deepEqual(placeholders(ZH_CN[key] ?? ''), placeholders(EN[key]), `placeholders of ${key}`)
  }
})

test('decoded Chinese values are real Simplified Chinese text, not escape sequences', () => {
  const value = translate('zh-CN', 'composer.correct')
  assert.ok(CJK.test(value), 'contains CJK ideographs')
  assert.equal(value.length, 5, 'five characters, not thirty escape characters')
  assert.ok(!value.includes('\\'), 'no backslash survives decoding')
  assert.ok([...value].every((c) => c.charCodeAt(0) > 127))
  let translated = 0
  for (const key of Object.keys(EN) as MessageKey[]) {
    const zh = ZH_CN[key] ?? ''
    assert.ok(!/\\u[0-9a-f]{4}/i.test(zh), `${key} is decoded`)
    if (CJK.test(zh)) translated++
  }
  assert.ok(translated >= Object.keys(EN).length - 2, 'practically every label is translated, not copied English')
  assert.ok(CJK.test(LOCALE_NAMES['zh-CN']))
  assert.equal(translate('en', 'app.opening').endsWith(ELLIPSIS), true, 'English decodes its escapes too')
})

test('the localization sources stay ASCII: Chinese is serialized as JSON unicode escapes', () => {
  for (const f of ['shared/i18n.ts', 'shared/locale-zh-CN.ts']) {
    const src = readFileSync(path.join(root, f), 'utf8')
    assert.ok(![...src].some((c) => c.charCodeAt(0) > 127), `${f} is ASCII`)
  }
  const zh = readFileSync(path.join(root, 'shared', 'locale-zh-CN.ts'), 'utf8')
  assert.ok((zh.match(/\\\\u[0-9a-f]{4}/g) ?? []).length > 500, 'values are written as escapes')
})

test('interpolation fills placeholders, leaves unknown ones visible and falls back to English for a missing key', () => {
  assert.equal(translate('en', 'composer.placeholderTeam', { company: 'Lumen' }), 'Message the Lumen team')
  const zh = translate('zh-CN', 'composer.placeholderTeam', { company: 'Lumen' })
  assert.ok(zh.includes(' Lumen '), 'user-authored names stay literal inside Chinese text')
  assert.ok(CJK.test(zh))
  assert.equal(translate('en', 'pet.say.working', { name: 'ADA' }), 'ADA is working on {task}')
  const res = RESOURCES['zh-CN']
  const saved = res['board.retry']
  delete res['board.retry']
  try {
    assert.equal(translate('zh-CN', 'board.retry'), 'Retry', 'missing key falls back to English')
  } finally {
    res['board.retry'] = saved
  }
})

test('locale detection: saved choice first, Chinese on a Chinese OS or browser, English otherwise', () => {
  assert.equal(detectLocale(null, ['zh-CN', 'en-US']), 'zh-CN')
  assert.equal(detectLocale(null, ['zh-TW']), 'zh-CN')
  assert.equal(detectLocale(null, ['zh']), 'zh-CN')
  assert.equal(detectLocale(null, ['en-GB', 'zh-CN']), 'en')
  assert.equal(detectLocale(null, ['fr-FR']), 'en')
  assert.equal(detectLocale('en', ['zh-CN']), 'en', 'a saved English choice beats a Chinese OS')
  assert.equal(detectLocale('klingon', ['zh-CN']), 'zh-CN', 'a malformed saved value is ignored')
})

test('the locale preference persists in storage only and never overrides an existing reply language', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) }
  assert.equal(loadLocale(storage, ['zh-CN']), 'zh-CN')
  saveLocale(storage, 'en')
  assert.equal(data.get(LOCALE_STORAGE_KEY), 'en')
  assert.equal(loadLocale(storage, ['zh-CN']), 'en', 'the saved switch survives a reload')
  const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
  assert.equal(loadLocale(broken, ['zh-CN']), 'zh-CN')
  saveLocale(broken, 'en')
  // Reply language is separate from the UI locale.
  assert.equal(replyLanguageFor('auto', 'zh-CN', false), 'auto', 'an existing office keeps auto')
  assert.equal(replyLanguageFor('Spanish', 'zh-CN', true), 'Spanish', 'a chosen language is kept')
  assert.equal(replyLanguageFor('auto', 'zh-CN', true), 'zh-CN', 'a fresh office with the Chinese UI replies in Chinese')
  assert.equal(replyLanguageFor('auto', 'en', true), 'auto')
})

/** Every client source file (the React UI is not compiled by this test command, so its keys are checked here). */
function clientSources(dir = path.join(root, 'client', 'src')): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...clientSources(full))
    else if (/\.tsx?$/.test(entry.name)) out.push({ file: path.relative(root, full), text: readFileSync(full, 'utf8') })
  }
  return out
}

test('every literal key the client translates exists, and every dynamic key family covers all its states', () => {
  const unknown: string[] = []
  let used = 0
  for (const { file, text } of clientSources()) {
    for (const m of text.matchAll(/\bt\('([A-Za-z0-9.\-]+)'/g)) {
      used++
      if (!((m[1] as string) in EN)) unknown.push(`${file}: ${m[1]}`)
    }
  }
  assert.deepEqual(unknown, [])
  assert.ok(used > 300, `the UI is localized through the shared layer (${used} literal lookups)`)
  // Keys built from a prefix and a state value at runtime.
  const phases: Record<ProjectPhase, true> = { new: true, planning: true, 'plan-ready': true, executing: true, 'final-review': true, done: true, 'needs-attention': true }
  const tones: Record<Tone, true> = { working: true, wait: true, attention: true, problem: true, quiet: true, unknown: true, done: true }
  const statuses: Record<CorrectionStatus, true> = { stopping: true, stopped: true, applied: true, superseded: true, 'pending-restart': true }
  const tiers: Record<TaskTier, true> = { routine: true, standard: true, critical: true }
  const roles: Record<WorkflowRole, true> = { lead: true, critic: true, implementer: true, reviewer: true, tester: true, writer: true }
  const families: [string, string[]][] = [
    ['board.phase.', Object.keys(phases)],
    ['phase.', Object.keys(phases)],
    ['office.tone.', Object.keys(tones)],
    ['correction.status.', Object.keys(statuses)],
    ['task.tier.', Object.keys(tiers)],
    ['role.', Object.keys(roles)],
    ['presence.', Object.keys(PRESENCE_LABEL)],
    ['settings.nav.', ['general', 'team', 'providers', 'marketplace', 'routines', 'skills', 'usage', 'account']],
  ]
  for (const [prefix, values] of families) for (const v of values) assert.ok(`${prefix}${v}` in EN, `${prefix}${v}`)
  for (const r of Object.keys(roles)) assert.ok(`role.${r}Hint` in EN, `role.${r}Hint`)
  // Rendered Chinese for a dynamic key with interpolation.
  const line = translate('zh-CN', 'office.tone.working', { n: 3 })
  assert.ok(line.startsWith('3 ') && CJK.test(line))
})

test('the initial reply-language decision happens once, only for a fresh office on the Chinese UI', () => {
  const fresh = [{ messages: [{ authorId: 'ada' }] }, { messages: [] }]
  const used = [{ messages: [{ authorId: 'ada' }, { authorId: 'user' }] }]
  assert.equal(isFreshOffice(fresh), true)
  assert.equal(isFreshOffice(used), false)
  assert.equal(initialReplyLanguage('auto', 'zh-CN', fresh, false), 'zh-CN')
  assert.equal(initialReplyLanguage('auto', 'zh-CN', fresh, true), undefined, 'decided before: a later switch-off sticks')
  assert.equal(initialReplyLanguage('auto', 'zh-CN', used, false), undefined, 'an existing office keeps its setting')
  assert.equal(initialReplyLanguage('en', 'zh-CN', fresh, false), undefined)
  assert.equal(initialReplyLanguage('auto', 'en', fresh, false), undefined)
})
