import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sendMessageFull } from '../client/src/api.ts'

test('a rejected chat command gets a fresh request id after the office state changes', async () => {
  const saved = new Map()
  const originalFetch = globalThis.fetch
  const originalStorage = globalThis.sessionStorage
  const keys = []
  globalThis.sessionStorage = {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => { saved.set(key, value) },
    removeItem: (key) => { saved.delete(key) },
  }
  globalThis.fetch = async (_url, init) => {
    keys.push(new Headers(init.headers).get('Idempotency-Key'))
    return keys.length === 1
      ? new Response(JSON.stringify({ error: 'start is too early' }), { status: 409, headers: { 'content-type': 'application/json' } })
      : new Response(JSON.stringify({ message: { id: 'accepted' } }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(sendMessageFull('group', { text: '/start' }), /start is too early/)
    assert.equal((await sendMessageFull('group', { text: '/start' })).id, 'accepted')
    assert.notEqual(keys[0], keys[1])
  } finally {
    globalThis.fetch = originalFetch
    globalThis.sessionStorage = originalStorage
  }
})
