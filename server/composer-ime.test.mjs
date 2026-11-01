import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const source = readFileSync(new URL('../client/src/components/Composer.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const onKeyDown =')
const end = source.indexOf('\n\n  const replyPerson', start)
assert.ok(start > 0 && end > start, 'Composer key handler is available for the fixture')
const handlerSource = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })

function fixture(options = []) {
  const calls = { sent: 0, picked: 0, prevented: 0 }
  const context = {
    options,
    highlight: 0,
    setHighlight() {},
    insert() { calls.picked++ },
    replyTo: null,
    onClearReply() {},
    submit() { calls.sent++ },
  }
  const keyDown = runInNewContext(`(function(){ ${handlerSource}; return onKeyDown })()`, context)
  const press = (key, { isComposing = false, keyCode = 0, shiftKey = false } = {}) => keyDown({
    key, shiftKey, nativeEvent: { isComposing, keyCode }, preventDefault() { calls.prevented++ },
  })
  return { calls, press }
}

test('IME Enter confirms a candidate without sending or picking an @ option', () => {
  for (const options of [[], [{ id: 'agent' }]]) {
    const { calls, press } = fixture(options)
    press('Enter', { isComposing: true })
    assert.deepEqual(calls, { sent: 0, picked: 0, prevented: 0 })
  }
})

test('native keyCode 229 on IME commit does not send or pick an option', () => {
  for (const options of [[], [{ id: 'agent' }]]) {
    const { calls, press } = fixture(options)
    press('Enter', { keyCode: 229 })
    assert.deepEqual(calls, { sent: 0, picked: 0, prevented: 0 })
  }
})

test('the next ordinary Enter sends; Shift+Enter remains a newline', () => {
  const { calls, press } = fixture()
  press('Enter', { isComposing: true })
  press('Enter')
  assert.equal(calls.sent, 1)
  assert.equal(calls.prevented, 1)
  press('Enter', { shiftKey: true })
  assert.equal(calls.sent, 1)
  assert.equal(calls.prevented, 1)
})

test('ordinary Enter and Tab still select an autocomplete option', () => {
  const { calls, press } = fixture([{ id: 'agent' }])
  press('Enter')
  press('Tab')
  assert.deepEqual(calls, { sent: 0, picked: 2, prevented: 2 })
})
