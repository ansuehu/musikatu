const { contextBridge, ipcRenderer, webUtils } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, ...args) => callback(...args)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  openFile: () => ipcRenderer.invoke('file:open'),
  initialFile: () => ipcRenderer.invoke('file:initial'),
  /** Absolute path of a dropped File (File.path is gone in sandboxed renderers). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  },
  loadProject: (key) => ipcRenderer.invoke('project:load', key),
  saveProject: (key, json) => ipcRenderer.invoke('project:save', key, json),
  setGlobalShortcuts: (list) => ipcRenderer.invoke('shortcuts:setGlobal', list),
  onGlobalShortcut: (callback) => subscribe('shortcuts:triggered', callback),
  onMenu: (callback) => subscribe('menu', callback),
  onFileOpened: (callback) => subscribe('file:opened', callback),
})
