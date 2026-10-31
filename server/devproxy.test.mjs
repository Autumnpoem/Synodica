import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { test } from 'node:test'
import express from 'express'
import { createServer as createViteServer } from 'vite'
import viteConfig from '../vite.config.ts'
import { Auth, loginPage } from './auth.ts'

test('Vite proxy preserves the browser origin for authenticated development writes', async () => {
  const app = express()
  const auth = new Auth({ token: 'fixture-access-token' })
  app.use(express.json())
  app.use(auth.middleware(loginPage))
  app.post('/api/session', (req, res) => auth.login(req, res))
  app.post('/api/write', (_req, res) => res.json({ ok: true }))
  const backend = createHttpServer(app)
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const backendAddress = backend.address()
  assert(backendAddress && typeof backendAddress !== 'string')
  const backendBase = `http://127.0.0.1:${backendAddress.port}`
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    server: {
      ...viteConfig.server,
      host: '127.0.0.1',
      port: 0,
      proxy: { '/api': { ...viteConfig.server.proxy['/api'], target: backendBase } },
    },
  })
  try {
    await vite.listen()
    const frontendAddress = vite.httpServer?.address()
    assert(frontendAddress && typeof frontendAddress !== 'string')
    const frontendBase = `http://127.0.0.1:${frontendAddress.port}`
    const login = await fetch(`${backendBase}/api/session`, { method: 'POST', headers: { origin: backendBase, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'fixture-access-token' }) })
    assert.equal(login.status, 200)
    const cookie = login.headers.get('set-cookie')?.split(';')[0]
    assert(cookie)
    const write = await fetch(`${frontendBase}/api/write`, { method: 'POST', headers: { origin: frontendBase, cookie, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(write.status, 200)
    assert.deepEqual(await write.json(), { ok: true })
  } finally {
    await vite.close()
    await new Promise((resolve) => backend.close(resolve))
  }
})
