// Electron shell: a local office starts its own server; a saved remote office starts at the
// app-owned sign-in page and uses a separate in-memory session. Native quota and pet windows follow
// the selected office without giving remote pages filesystem or shell IPC.
const { app, BrowserWindow, Menu, dialog, ipcMain, screen, session, shell } = require('electron')
const { spawn } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const PORT = Number(process.env.PORT ?? 4310)
const URL = `http://127.0.0.1:${PORT}/`
const root = path.join(__dirname, '..')
const preload = path.join(__dirname, 'preload.cjs')
let server = null
let mainWin = null
let petWin = null
/** Pure pet logic (validation, placement, single-window lifecycle), built to dist/shared by `npm run build`. */
let core = null
let links = null
let pet = null
/** Localized resources (dist/shared/i18n.js) for the native Pet menu. */
let i18n = null
/** Desktop data paths, migration and the server handshake (dist/server/desktopdata.js). */
let desktopData = null
/** The interface language the main window reported (validated), or null before it did. */
let uiLocale = null
let officeUrl = URL
let remoteSession = null
let quota = null
let connectionWin = null
let selectedOffice = { mode: 'local' }
let serverReady = false
let serverStarting = null
let remotePetWin = null
let remotePetTimer = null
let remotePetDismissed = false
const programmaticPetCloses = new WeakSet()
const connectionPage = path.join(__dirname, 'connection.html')
const connectionPageUrl = pathToFileURL(connectionPage).href

// Preserve the existing office, connection selection and browser profile across the brand rename.
// Packaged builds previously used productName; development used package.json's lowercase name.
const legacyUserData = path.join(app.getPath('appData'), app.isPackaged ? 'OpenGrokBot' : 'opengrokbot')
fs.mkdirSync(legacyUserData, { recursive: true })
app.setPath('userData', legacyUserData)
app.setPath('sessionData', legacyUserData)
app.setName('Synodica')

// One app instance: a second launch focuses the first instead of starting a second server and pet.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
app.on('second-instance', () => {
  const win = mainWin ?? connectionWin
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

/**
 * Start our server and wait until this exact child says it listens (a per-launch nonce over the IPC
 * channel). A failed start or a port already used by something else is reported, never attached to.
 */
async function startServer() {
  const userData = app.getPath('userData')
  const paths = desktopData.desktopPaths(process.env, userData)
  // A development checkout used team.json and data/ in the checkout before; copy them once, never overwriting.
  if (!app.isPackaged) {
    const migrated = desktopData.migrateLegacyOffice({ team: path.join(root, 'team.json'), data: path.join(root, 'data') }, paths)
    for (const note of migrated.notes) console.log(`[desktop] ${note}`)
  }
  const nonce = randomBytes(24).toString('hex')
  const env = desktopData.serverEnv(process.env, {
    port: PORT,
    paths,
    nonce,
    electron: process.execPath,
    helperMode: app.isPackaged ? 'app-executable' : 'launcher',
  })
  fs.mkdirSync(paths.workDir, { recursive: true })
  const child = spawn(process.execPath, [path.join(root, 'dist', 'server', 'index.js')], { cwd: paths.workDir, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  server = child
  child.on('exit', (code) => {
    if (server !== child) return
    server = null
    serverReady = false
    if (code !== 0 && !app.isQuitting) console.error(`[desktop] server exited with code ${code}`)
  })
  const ready = await desktopData.waitForReady(child, nonce, 60_000)
  if (!ready.ok) {
    child.kill()
    if (server === child) server = null
    throw new Error(ready.reason)
  }
}

function ensureLocalServer() {
  if (serverReady) return Promise.resolve()
  if (serverStarting) return serverStarting
  serverStarting = startServer().then(() => { serverReady = true }).finally(() => { serverStarting = null })
  return serverStarting
}

function connectionFile() { return path.join(app.getPath('userData'), 'connection.json') }

function readConnection() {
  try { return core.savedOffice(JSON.parse(fs.readFileSync(connectionFile(), 'utf8'))) }
  catch (err) { return err?.code === 'ENOENT' ? { mode: 'local' } : { mode: 'remote', remoteUrl: '', error: 'Saved office selection could not be read' } }
}

function saveConnection(choice) {
  const file = connectionFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(choice), { mode: 0o600 })
  fs.renameSync(`${file}.tmp`, file)
}

async function showConnectionWindow() {
  if (connectionWin && !connectionWin.isDestroyed()) { connectionWin.show(); connectionWin.focus(); return }
  const win = new BrowserWindow({
    width: 620, height: 540, minWidth: 480, minHeight: 420,
    backgroundColor: '#f7f6f2', title: 'Synodica · Office connection',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload },
  })
  connectionWin = win
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  win.on('closed', () => { if (connectionWin === win) connectionWin = null })
  await win.loadFile(connectionPage)
}

/** Pages stay on the selected office origin; external windows and webviews are refused. */
function lockNavigation(contents, allowExternal, origin = URL) {
  contents.on('will-navigate', (event, url) => {
    if (!core.trustedSender(url, origin)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    if (allowExternal && core.externalAllowed(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-attach-webview', (event) => event.preventDefault())
}

async function createWindow(target = URL) {
  const win = new BrowserWindow({
    width: 1320,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#f7f6f2',
    title: '\u661f\u8bae · Synodica',
    icon: path.join(root, 'build', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f6f2', symbolColor: '#353d45', height: 40 },
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, ...(target !== URL ? { session: remoteSession } : {}) },
  })
  const previous = mainWin
  const previousUrl = officeUrl
  mainWin = win
  officeUrl = target
  lockNavigation(win.webContents, target === URL, target)
  win.on('closed', () => {
    if (mainWin === win) {
      mainWin = null
      pet?.dispose()
      quota?.close()
      stopRemotePet()
    }
  })
  // The desktop pet is now the upstream dsh-pet (its own transparent Electron helper, launched by
  // the server's pet host with this app's Electron). The earlier built-in pet window no longer
  // starts by itself, so there are never two pets.
  win.webContents.on('did-finish-load', () => buildMenu())
  try {
    await win.loadURL(target)
    if (previous && !previous.isDestroyed()) previous.close()
  } catch (err) {
    if (mainWin === win) mainWin = previous
    officeUrl = previousUrl
    win.destroy()
    throw err
  }
}

function createQuotaWindow() {
  const win = new BrowserWindow({
    width: 340, height: 460, minWidth: 300, minHeight: 64,
    frame: false, resizable: false, skipTaskbar: false,
    backgroundColor: '#fffdf8', title: 'Synodica quota',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, ...(officeUrl !== URL ? { session: remoteSession } : {}) },
  })
  win.setAlwaysOnTop(true, 'floating')
  lockNavigation(win.webContents, false, officeUrl)
  void win.loadURL(`${officeUrl}#/quota`)
  return {
    isDestroyed: () => win.isDestroyed(),
    show: () => win.show(),
    focus: () => win.focus(),
    close: () => win.close(),
    setAlwaysOnTop: (on) => win.setAlwaysOnTop(on, on ? 'floating' : 'normal'),
    setSize: (width, height) => win.setSize(width, height),
    onClosed: (fn) => win.on('closed', fn),
    webContents: win.webContents,
  }
}

function remotePetBounds() {
  const a = screen.getPrimaryDisplay().workArea
  const width = Math.min(620, a.width)
  const height = Math.min(360, a.height)
  return { x: Math.round(Math.max(a.x, a.x + a.width - width - 20)), y: Math.round(Math.max(a.y, a.y + a.height - height - 20)), width, height }
}

function closeRemotePet() {
  const win = remotePetWin
  remotePetWin = null
  if (win && !win.isDestroyed()) {
    programmaticPetCloses.add(win)
    win.close()
  }
}

function stopRemotePet() {
  if (remotePetTimer) clearInterval(remotePetTimer)
  remotePetTimer = null
  closeRemotePet()
}

function openRemotePet() {
  if (remotePetWin && !remotePetWin.isDestroyed()) return
  const win = new BrowserWindow({
    ...remotePetBounds(), show: false, frame: false, transparent: true,
    backgroundColor: '#00000000', resizable: false, skipTaskbar: true,
    title: 'Synodica · dsh-pet',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, session: remoteSession, spellcheck: false },
  })
  remotePetWin = win
  lockNavigation(win.webContents, false, officeUrl)
  win.setAlwaysOnTop(true, 'floating')
  win.setIgnoreMouseEvents(true, { forward: true })
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    if (remotePetWin === win) remotePetWin = null
    if (!programmaticPetCloses.has(win)) remotePetDismissed = true
  })
  void win.loadURL(`${officeUrl}#/remote-pet`).then(() => { if (!win.isDestroyed()) win.showInactive() }).catch(() => { if (!win.isDestroyed()) win.close() })
}

let remotePetChecking = false
async function syncRemotePet() {
  if (remotePetChecking || officeUrl === URL || !mainWin || mainWin.isDestroyed()) return
  const requestedOffice = officeUrl
  remotePetChecking = true
  try {
    const status = await petCall('status')
    if (officeUrl !== requestedOffice) return
    const enabled = status?.settings?.enabled && status.status?.state === 'running'
    if (!enabled) {
      if (status?.settings?.enabled === false) remotePetDismissed = false
      closeRemotePet()
    } else if (!remotePetDismissed) openRemotePet()
  } finally { remotePetChecking = false }
}

function startRemotePet() {
  stopRemotePet()
  remotePetDismissed = false
  void syncRemotePet()
  remotePetTimer = setInterval(() => void syncRemotePet(), 8000)
}

// ---------- desktop pet ----------

function settingsFile() {
  return path.join(app.getPath('userData'), 'desktop-pet.json')
}

function loadPetSettings() {
  try {
    return core.sanitizeNativeSettings(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')))
  } catch {
    return core.sanitizeNativeSettings(undefined)
  }
}

function savePetSettings(s) {
  try {
    const file = settingsFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(s))
    fs.renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.warn('[desktop] could not save the pet settings:', err instanceof Error ? err.message : err)
  }
}

function displays() {
  const list = screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }))
  return { list, primaryId: screen.getPrimaryDisplay().id, nearest: (r) => screen.getDisplayMatching(r).id }
}

function createPetWindow(bounds) {
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    title: 'Synodica pet',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, preload, spellcheck: false },
  })
  petWin = win
  lockNavigation(win.webContents, false)
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('closed', () => {
    if (petWin === win) petWin = null
    // If it was closed from outside, the controller marks it hidden; show that in the app and menu.
    setImmediate(() => {
      if (!pet || app.isQuitting) return
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('pet:settings', pet.current)
      buildMenu()
    })
  })
  let ready = false
  let showWhenReady = false
  win.once('ready-to-show', () => {
    ready = true
    if (showWhenReady && !win.isDestroyed()) win.showInactive()
  })
  // Same origin and session as the main window, so the existing token cookie applies. No token in the URL.
  void win.loadURL(`${URL}#/pet`)
  return {
    isDestroyed: () => win.isDestroyed(),
    destroy: () => win.destroy(),
    showInactive: () => {
      if (ready) win.showInactive()
      else showWhenReady = true
    },
    setAlwaysOnTop: (on) => win.setAlwaysOnTop(on, on ? 'floating' : 'normal'),
    setIgnoreMouseEvents: (ignore, opts) => win.setIgnoreMouseEvents(ignore, opts),
    setBounds: (r) => win.setBounds(r),
    getBounds: () => win.getBounds(),
    onClosed: (fn) => win.on('closed', fn),
    sendSettings: (s) => {
      if (!win.isDestroyed()) win.webContents.send('pet:settings', s)
    },
  }
}

function applyPet(patch) {
  const s = pet.apply(patch)
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('pet:settings', s)
  buildMenu()
  return s
}

const fromMain = (e) => Boolean(mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents && core.trustedSender(e.senderFrame?.url, URL))
const fromPet = (e) => Boolean(petWin && !petWin.isDestroyed() && e.sender === petWin.webContents && core.trustedSender(e.senderFrame?.url, URL))
const fromOffice = (e) => Boolean(mainWin && !mainWin.isDestroyed() && e.sender === mainWin.webContents && core.trustedSender(e.senderFrame?.url, officeUrl))
const fromQuota = (e) => Boolean(quotaWindow && !quotaWindow.isDestroyed() && e.sender === quotaWindow.webContents && core.trustedSender(e.senderFrame?.url, officeUrl))
const fromConnection = (e) => Boolean(connectionWin && !connectionWin.isDestroyed() && e.sender === connectionWin.webContents && e.senderFrame?.url === connectionPageUrl)
const fromRemotePet = (e) => Boolean(remotePetWin && !remotePetWin.isDestroyed() && e.sender === remotePetWin.webContents && e.senderFrame?.url === `${officeUrl}#/remote-pet`)
let quotaWindow = null

/** Suspend only the local pet while another office is displayed; preserve its enabled preference. */
async function setLocalPetActive(active) {
  if (!serverReady) return
  const response = await session.defaultSession.fetch(`${URL}api/pet/desktop`, {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: { 'Content-Type': 'application/json', Origin: new globalThis.URL(URL).origin },
    body: JSON.stringify({ active }),
  })
  if (!response.ok) throw new Error(`Local pet switch failed (${response.status})`)
}

function registerIpc() {
  ipcMain.handle('office:get', (e) => {
    if (!fromOffice(e) && !fromQuota(e) && !fromConnection(e)) throw new Error('not allowed')
    return { ...selectedOffice, localUrl: URL, connected: Boolean(mainWin && !mainWin.isDestroyed()), ...(selectedOffice.mode === 'remote' && officeUrl === URL ? { connected: false } : {}) }
  })
  ipcMain.handle('office:connect', async (e, input) => {
    if (!fromOffice(e) && !fromConnection(e)) throw new Error('not allowed')
    const checked = core.remoteOfficeOrigin(input?.url)
    if (!checked.ok) throw new Error(checked.error)
    if (checked.value === URL) throw new Error('use Local office for this address')
    if (typeof input?.token !== 'string' || !input.token.trim() || input.token.length > 4096) throw new Error('enter the current office access token')
    const target = checked.value
    const response = await remoteSession.fetch(`${target}api/session`, {
      method: 'POST', credentials: 'include', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Origin: new globalThis.URL(target).origin },
      body: JSON.stringify({ token: input.token }),
    })
    if (!response.ok) throw new Error(`Remote sign-in failed (${response.status})`)
    const status = await remoteSession.fetch(`${target}api/session`, { credentials: 'include', redirect: 'error' })
    if (!status.ok || !(await status.json()).authenticated) throw new Error('Remote session was not established')
    quota?.close()
    const previousChoice = selectedOffice
    const suspendLocalPet = serverReady && officeUrl === URL
    if (suspendLocalPet) await setLocalPetActive(false)
    selectedOffice = { mode: 'remote', remoteUrl: target }
    try { await createWindow(target) }
    catch (err) {
      selectedOffice = previousChoice
      if (suspendLocalPet) await setLocalPetActive(true)
      throw err
    }
    saveConnection(selectedOffice)
    if (connectionWin && !connectionWin.isDestroyed()) connectionWin.close()
    // Changing the viewed office must not interrupt local work; quit owns server shutdown.
    startRemotePet()
    return { mode: 'remote', localUrl: URL, remoteUrl: target }
  })
  ipcMain.handle('office:disconnect', async (e) => {
    if (!fromOffice(e) && !fromConnection(e)) throw new Error('not allowed')
    await ensureLocalServer()
    const previousChoice = selectedOffice
    selectedOffice = { mode: 'local' }
    if (officeUrl !== URL || !mainWin || mainWin.isDestroyed()) {
      stopRemotePet()
      quota?.close()
      try { await createWindow(URL) }
      catch (err) { selectedOffice = previousChoice; throw err }
      await remoteSession.clearStorageData({ storages: ['cookies'] })
    }
    await setLocalPetActive(true)
    saveConnection(selectedOffice)
    if (connectionWin && !connectionWin.isDestroyed()) connectionWin.close()
    return { mode: 'local', localUrl: URL }
  })
  ipcMain.handle('quota:open', (e) => {
    if (!fromOffice(e)) throw new Error('not allowed')
    return quota.open()
  })
  ipcMain.handle('quota:get', (e) => {
    if (!fromQuota(e)) throw new Error('not allowed')
    return quota.state()
  })
  ipcMain.handle('quota:action', (e, action) => {
    if (!fromQuota(e) || !['close', 'pin', 'collapse'].includes(action)) throw new Error('not allowed')
    if (action === 'close') { quota.close(); return quota.state() }
    if (action === 'pin') return quota.togglePin()
    return quota.toggleCollapse()
  })
  ipcMain.on('remote-pet:interactive', (e, interactive) => {
    if (fromRemotePet(e) && typeof interactive === 'boolean') remotePetWin.setIgnoreMouseEvents(!interactive, { forward: true })
  })
  ipcMain.on('remote-pet:close', (e) => {
    if (!fromRemotePet(e)) return
    remotePetDismissed = true
    closeRemotePet()
  })
  ipcMain.handle('pet:get', (e) => {
    if (!fromMain(e) && !fromPet(e)) throw new Error('not allowed')
    return pet.current
  })
  ipcMain.handle('pet:set', (e, patch) => {
    if (!fromMain(e)) throw new Error('not allowed')
    const checked = core.checkSettingsPatch(patch)
    if (!checked.ok) throw new Error(checked.error)
    return applyPet(checked.value)
  })
  ipcMain.on('pet:drag', (e, delta) => {
    if (!fromPet(e)) return
    const checked = core.checkDrag(delta)
    if (checked.ok) pet.dragBy(checked.value.dx, checked.value.dy)
  })
  ipcMain.on('pet:open', (e, link) => {
    if (!fromPet(e) || !mainWin || mainWin.isDestroyed()) return
    const checked = core.checkLink(link)
    if (!checked.ok) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
    mainWin.webContents.send('app:navigate', links.linkToHash(checked.value))
  })
  ipcMain.on('app:locale', (e, locale) => {
    if (!fromMain(e) || !i18n || !i18n.isLocale(locale) || locale === uiLocale) return
    uiLocale = locale
    buildMenu()
  })
}

/** The menu talks to the selected office's pet host using its own session. */
async function petCall(action) {
  if (!mainWin || mainWin.isDestroyed()) return null
  try {
    const remote = officeUrl !== URL
    const ses = remote ? remoteSession : session.defaultSession
    const res = await ses.fetch(`${officeUrl}api/pet/${action}`, {
      method: action === 'status' ? 'GET' : 'POST', credentials: 'include', redirect: 'error',
      ...(action === 'status' ? {} : { headers: { Origin: new globalThis.URL(officeUrl).origin } }),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

let petRunning = false
async function refreshPetState() {
  const s = await petCall('status')
  petRunning = s?.status?.state === 'running'
}

function showInApp(hash) {
  if (!mainWin || mainWin.isDestroyed()) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
  mainWin.webContents.send('app:navigate', hash)
}

function buildMenu() {
  const isMac = process.platform === 'darwin'
  // Menu labels follow the language chosen in the app, else the OS language (the same zh-CN / en resources).
  const locale = i18n ? (uiLocale ?? i18n.detectLocale(null, [app.getLocale()])) : 'en'
  const t = (key) => (i18n ? i18n.translate(locale, key) : key)
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    {
      label: t('pet.title'),
      submenu: [
        {
          label: petRunning ? t('pet.stop') : t('pet.start'),
          click: async () => {
            await petCall(petRunning ? 'stop' : 'start')
            await refreshPetState()
            if (officeUrl !== URL) await syncRemotePet()
            buildMenu()
          },
        },
        { label: t('pet.settingsUpstream'), click: () => showInApp('#/office') },
        { type: 'separator' },
        { label: t('pet.menu.openOffice'), click: () => showInApp('#/office') },
        { label: t('pet.menu.openUsage'), click: () => showInApp('#/usage') },
        { label: locale === 'zh-CN' ? '\u6253\u5f00\u989d\u5ea6\u60ac\u6d6e\u7a97' : 'Open quota window', click: () => { if (mainWin && !mainWin.isDestroyed()) quota.open() } },
        ...(officeUrl === URL ? [] : [{ label: locale === 'zh-CN' ? '\u663e\u793a\u684c\u9762\u5ba0\u7269' : 'Show desktop pet', click: () => { remotePetDismissed = false; void syncRemotePet() } }]),
        { label: locale === 'zh-CN' ? '\u5207\u6362\u529e\u516c\u5ba4' : 'Switch office', click: () => void showConnectionWindow() },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  const before = petRunning
  void refreshPetState().then(() => {
    if (petRunning !== before) buildMenu()
  })
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  core = await import(pathToFileURL(path.join(root, 'dist', 'shared', 'desktop.js')).href)
  links = await import(pathToFileURL(path.join(root, 'dist', 'shared', 'presence.js')).href)
  desktopData = await import(pathToFileURL(path.join(root, 'dist', 'server', 'desktopdata.js')).href)
  try {
    i18n = await import(pathToFileURL(path.join(root, 'dist', 'shared', 'i18n.js')).href)
  } catch {
    i18n = null
  }
  pet = new core.PetController(loadPetSettings(), { create: createPetWindow, displays, save: savePetSettings })
  remoteSession = session.fromPartition('remote-office')
  remoteSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  quota = new core.QuotaWindowController(() => {
    quotaWindow = createQuotaWindow()
    quotaWindow.onClosed(() => { quotaWindow = null })
    return quotaWindow
  })
  registerIpc()
  selectedOffice = readConnection()
  buildMenu()
  // Unplugged or rearranged displays: keep a shown pet on screen.
  for (const ev of ['display-removed', 'display-metrics-changed']) screen.on(ev, () => pet.recover())
  for (const ev of ['display-removed', 'display-metrics-changed']) screen.on(ev, () => { if (remotePetWin && !remotePetWin.isDestroyed()) remotePetWin.setBounds(remotePetBounds()) })
  try {
    if (selectedOffice.mode === 'remote') await showConnectionWindow()
    else { await ensureLocalServer(); await createWindow() }
  } catch (err) {
    console.error(err)
    // Truthful failure: never open whatever else might answer on the port.
    dialog.showErrorBox('Synodica could not start', `${err instanceof Error ? err.message : String(err)}\n\nIf another program uses port ${PORT}, quit it or start Synodica with a different PORT.`)
    app.isQuitting = true
    if (server) server.kill()
    app.quit()
  }
})

app.on('window-all-closed', () => {
  app.isQuitting = true
  if (server) server.kill()
  app.quit()
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopRemotePet()
  pet?.dispose()
  if (server) server.kill()
})
