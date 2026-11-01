import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { runInNewContext, createContext, runInContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import * as api from '../client/src/api.ts'
import { clampDockPosition } from '../client/src/quotaPosition.ts'

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
const js = (s) => ts.transpile(s, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None })

for (const file of ['App.tsx', 'QuotaApp.tsx']) test(file + ' reopens a permanently closed live stream and cancels retries on unmount', async () => {
  const sources = [], timers = new Map(), acknowledged = []; let next = 0
  class Source {
    static CLOSED = 2
    readyState = 1
    constructor() { sources.push(this) }
    listeners = new Map()
    addEventListener(name,fn) { this.listeners.set(name,fn) }
    close() { this.readyState = 2 }
  }
  const context = createContext({ EventSource: Source, setTimeout: (fn) => { timers.set(++next, fn); return next }, clearTimeout: (id) => timers.delete(id),
    acknowledgeMessage: (message) => acknowledged.push(message.requestId), maybeNotify() {}, fetchUsage: async () => ({}), authStatus: async () => ({ authenticated: true }), dispatch() {}, setReport() {}, setError() {}, t: Object.assign(() => '', { error: 'failed' }), window: { location: { reload() {} } } })
  const helper = new URL('../client/src/eventStream.ts', import.meta.url)
  if (existsSync(helper)) runInContext(js(readFileSync(helper, 'utf8').replace('export function', 'function')), context)
  const source = read('client/src/' + file)
  const start = source.indexOf('    let alive = true', source.indexOf('useEffect'))
  const end = source.indexOf('\n  }, [', start)
  const dispose = runInContext(js('(function(){' + source.slice(start, end) + '\n})()'), context)
  if (file === 'App.tsx') {
    sources[0].listeners.get('sync')({ data: JSON.stringify({ state: { conversations: [{ messages: [{ requestId: 'snapshot-ack' }] }] } }) })
    sources[0].onmessage({ data: JSON.stringify({ type: 'message:done', message: { requestId: 'live-ack' } }) })
    assert.deepEqual(acknowledged, ['snapshot-ack', 'live-ack'])
  }
  sources[0].readyState = 2 // a 502/503 response closes native EventSource permanently
  sources[0].onerror?.(new Event('error'))
  await Promise.resolve(); await Promise.resolve()
  for (const [id, fn] of [...timers]) { timers.delete(id); fn() }
  assert.equal(sources.length, 2, 'a server restart must not leave the office permanently disconnected')
  sources[1].readyState = 2; sources[1].onerror(new Event('error')); dispose()
  assert.equal(timers.size, 0)
})

test('a server-acknowledged message can be sent again after its HTTP response was lost', async () => {
  const saved = new Map(), keys = []
  const original = { fetch: globalThis.fetch, storage: globalThis.sessionStorage }
  globalThis.sessionStorage = { get length() { return saved.size }, key: (i) => [...saved.keys()][i] ?? null, getItem: (k) => saved.get(k) ?? null, setItem: (k,v) => saved.set(k,v), removeItem: (k) => saved.delete(k) }
  globalThis.fetch = async (_url, init) => {
    const requestId = new Headers(init.headers).get('Idempotency-Key');keys.push(requestId)
    if (keys.length === 1) {
      // The user sees the authoritative stream echo even though the POST response is lost.
      api.acknowledgeMessage?.({ authorId: 'user', conversationId: 'group', requestId })
      throw new TypeError('lost response')
    }
    return new Response(JSON.stringify({ message: { id: 'next' } }), { headers: { 'content-type': 'application/json' } })
  }
  try {
    await assert.rejects(api.sendMessageFull('group', { text: 'continue' }), /lost response/)
    await api.sendMessageFull('group', { text: 'continue' })
    assert.notEqual(keys[0], keys[1], 'an acknowledged send must not suppress a new identical message')
  } finally { globalThis.fetch = original.fetch; globalThis.sessionStorage = original.storage }
})

test('a readiness timeout cleans up the actual server child before retrying', async () => {
  const source = read('desktop/app.cjs');let killed = 0
  const child = { on() {}, kill() { killed++; return true } }
  const context = { app: { getPath: () => '/tmp/fixture', isPackaged: true }, desktopData: { desktopPaths: () => ({ workDir: '/tmp/fixture' }), serverEnv: () => ({}), waitForReady: async () => ({ ok: false, reason: 'fixture timeout' }) }, process: { env: {}, execPath: '/fixture/electron' }, fs: { mkdirSync() {} }, path: { join: (...p) => p.join('/') }, randomBytes: () => ({ toString: () => 'fixture' }), root: '/fixture', PORT: 1234, spawn: () => child, server: null, serverReady: false, console }
  const body = source.slice(source.indexOf('async function startServer()'), source.indexOf('\nfunction ensureLocalServer'))
  const start = runInNewContext(body + ';startServer', context)
  await assert.rejects(start(), /fixture timeout/)
  assert.equal(killed, 1); assert.equal(context.server, null)
})

test('switching the desktop view to a remote office does not terminate local work', async () => {
  const source = read('desktop/app.cjs');let stopped = 0; const handlers = new Map()
  const context = { ipcMain: { handle: (name, fn) => handlers.set(name,fn), on() {} }, fromOffice: () => true, fromConnection: () => false, core: { remoteOfficeOrigin: () => ({ ok: true, value: 'https://office.example/' }) }, URL: 'http://127.0.0.1:4310/', remoteSession: { fetch: async () => ({ ok: true, json: async () => ({ authenticated: true }) }) }, globalThis: { URL }, quota: { close() {} }, selectedOffice: { mode: 'local' }, createWindow: async () => {}, saveConnection() {}, connectionWin: null, stopLocalServer: async () => { stopped++ }, startRemotePet() {} }
  const body = source.slice(source.indexOf('function registerIpc()'),source.indexOf('\n/** The menu talks'))
  context.serverReady = false
  runInNewContext(body + ';registerIpc()',context)
  await handlers.get('office:connect')({}, { url: 'https://office.example/', token: 'fixture' })
  assert.equal(stopped, 0, 'changing views must leave ongoing local tasks running')
})

test('quota dock keeps its header reachable when a loaded report increases its height', () => {
  let current = { x: 0, y: -400 }, rect = { left: 12, right: 308, top: 8, bottom: 108 }, observe
  const context = { layout: { composerTop: null }, dock: { current: { getBoundingClientRect: () => rect } }, setPosition: (fn) => { const next=fn(current), dx=next.x-current.x, dy=next.y-current.y;rect={left:rect.left+dx,right:rect.right+dx,top:rect.top+dy,bottom:rect.bottom+dy};current=next }, clampDockPosition, window: { innerWidth: 320, innerHeight: 600, addEventListener() {}, removeEventListener() {} }, ResizeObserver: class { constructor(fn) { observe=fn } observe() {} disconnect() {} } }
  const source=read('client/src/components/QuotaDock.tsx'),start=source.indexOf('    const fit =',source.indexOf('useLayoutEffect(() =>')),end=source.indexOf('\n  }, [',start)
  const dispose=runInNewContext(js('(function(){'+source.slice(start,end)+'\n})()'),context)
  rect={...rect,top:-222} // a late report grows upward from the dragged bottom anchor
  observe?.()
  assert.ok(rect.top>=8, 'report growth moved the controls above the viewport')
  dispose()
})

test('a failed server child exiting late cannot clear its replacement', async () => {
  const source=read('desktop/app.cjs');let onExit
  const old={on(_event,fn){onExit=fn},kill(){return true}}
  const context={app:{getPath:()=>'/tmp/fixture',isPackaged:true},desktopData:{desktopPaths:()=>({workDir:'/tmp/fixture'}),serverEnv:()=>({}),waitForReady:async()=>({ok:false,reason:'fixture timeout'})},process:{env:{},execPath:'/fixture/electron'},fs:{mkdirSync(){}},path:{join:(...p)=>p.join('/')},randomBytes:()=>({toString:()=> 'fixture'}),root:'/fixture',PORT:1234,spawn:()=>old,server:null,serverReady:false,console}
  const body=source.slice(source.indexOf('async function startServer()'),source.indexOf('\nfunction ensureLocalServer'))
  const start=runInNewContext(body+';startServer',context)
  await assert.rejects(start(),/fixture timeout/)
  const replacement={id:'replacement'};context.server=replacement;context.serverReady=true
  onExit(0)
  assert.equal(context.server,replacement,'the failed launch must not erase the new server reference')
  assert.equal(context.serverReady,true)
})

test('a genuinely unacknowledged message retry preserves its request id', async () => {
  const saved=new Map(), keys=[];const original={fetch:globalThis.fetch,storage:globalThis.sessionStorage}
  globalThis.sessionStorage={getItem:k=>saved.get(k)??null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)}
  globalThis.fetch=async(_url,init)=>{keys.push(new Headers(init.headers).get('Idempotency-Key'));if(keys.length===1)throw new TypeError('lost response');return new Response(JSON.stringify({message:{id:'original'}}),{headers:{'content-type':'application/json'}})}
  try{await assert.rejects(api.sendMessageFull('retry-fixture',{text:'continue'}),/lost response/);await api.sendMessageFull('retry-fixture',{text:'continue'});assert.equal(keys[0],keys[1])}
  finally{globalThis.fetch=original.fetch;globalThis.sessionStorage=original.storage}
})

test('real EventSource recovers from HTTP 503 and 502 before receiving the new snapshot', async () => {
  const { spawn } = await import('node:child_process')
  const entry=new URL('../client/src/eventStream.ts',import.meta.url).href
  const script=`import assert from 'node:assert/strict';import {createServer} from 'node:http';import {connectEventStream} from ${JSON.stringify(entry)};
let requests=0;const server=createServer((req,res)=>{requests++;if(requests<3){res.writeHead(requests===1?503:502);res.end();return}res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('event: sync\\ndata: {"recovered":true}\\n\\n')});
server.listen(0,'127.0.0.1',()=>{const timer=setTimeout(()=>{console.error('stream recovery timed out');process.exit(1)},9000);const dispose=connectEventStream('http://127.0.0.1:'+server.address().port,source=>{source.addEventListener('sync',event=>{assert.equal(JSON.parse(event.data).recovered,true);assert.equal(requests,3);dispose();clearTimeout(timer);server.closeAllConnections();server.close()})})});`
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--experimental-eventsource','--import','tsx','--input-type=module','-e',script]);let stderr='';child.stderr.on('data',s=>stderr+=s);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)))})
})
