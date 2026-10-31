// Preload for the main window, pet and quota window (sandboxed, context-isolated). It exposes
// bounded office, quota and pet actions. No filesystem, shell, process or arbitrary IPC.
// The main process checks the sender window, the page origin and every payload.
const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, cb) {
  if (typeof cb !== 'function') return () => {}
  const handler = (_event, value) => cb(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('ogbDesktop', {
  platform: process.platform,
  getPetSettings: () => ipcRenderer.invoke('pet:get'),
  setPetSettings: (patch) => ipcRenderer.invoke('pet:set', patch),
  onPetSettings: (cb) => subscribe('pet:settings', cb),
  onNavigate: (cb) => subscribe('app:navigate', cb),
  petDrag: (dx, dy) => ipcRenderer.send('pet:drag', { dx, dy }),
  petOpen: (link) => ipcRenderer.send('pet:open', link),
  // The interface language chosen in the app, so the native Pet menu follows it ('en' | 'zh-CN').
  setLocale: (locale) => ipcRenderer.send('app:locale', locale),
  getConnection: () => ipcRenderer.invoke('office:get'),
  connectRemote: (url, token) => ipcRenderer.invoke('office:connect', { url, token }),
  disconnectRemote: () => ipcRenderer.invoke('office:disconnect'),
  openQuota: () => ipcRenderer.invoke('quota:open'),
  getQuotaState: () => ipcRenderer.invoke('quota:get'),
  quotaAction: (action) => ipcRenderer.invoke('quota:action', action),
  remotePetInteractive: (interactive) => ipcRenderer.send('remote-pet:interactive', interactive),
  remotePetClose: () => ipcRenderer.send('remote-pet:close'),
})
