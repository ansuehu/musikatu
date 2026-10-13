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
  beats: {
    track: (mono) => ipcRenderer.invoke('beats:track', mono),
    onProgress: (callback) => subscribe('stems:event', (e) => e.type === 'beatsProgress' && callback(e.fraction)),
  },
  notes: {
    transcribe: (mono) => ipcRenderer.invoke('notes:transcribe', mono),
    onProgress: (callback) => subscribe('stems:event', (e) => e.type === 'notesProgress' && callback(e.fraction)),
  },
  stems: {
    info: () => ipcRenderer.invoke('stems:info'),
    setPreference: (p) => ipcRenderer.invoke('stems:setPreference', p),
    benchmark: () => ipcRenderer.invoke('stems:benchmark'),
    downloadModel: () => ipcRenderer.invoke('stems:downloadModel'),
    cancelDownload: () => ipcRenderer.invoke('stems:cancelDownload'),
    importModel: () => ipcRenderer.invoke('stems:importModel'),
    separate: (key, left, right) => ipcRenderer.invoke('stems:separate', { key, left, right }),
    cancel: () => ipcRenderer.invoke('stems:cancel'),
    load: (key) => ipcRenderer.invoke('stems:load', key),
    exportStems: (key, baseName) => ipcRenderer.invoke('stems:export', { key, baseName }),
    clearCache: () => ipcRenderer.invoke('stems:clearCache'),
    onEvent: (callback) => subscribe('stems:event', callback),
  },
})
