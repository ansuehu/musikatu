const { app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'webm', 'aif', 'aiff']

// Wayland compositors only allow global shortcuts through the XDG portal.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-features', 'GlobalShortcutsPortal')

/** @type {BrowserWindow | null} */
let win = null
// A file passed on the command line (`earwork song.mp3`), handed to the renderer once.
let initialFile = findAudioArg(process.argv)

function findAudioArg(argv) {
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .find((arg) => !arg.startsWith('-') && AUDIO_EXTENSIONS.includes(path.extname(arg).slice(1).toLowerCase()))
}

async function readAudio(filePath) {
  const data = await fs.readFile(filePath)
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#0d0f13',
    title: 'Earwork',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) win.loadURL(devUrl)
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  win.on('closed', () => (win = null))
}

const send = (command) => win?.webContents.send('menu', command)

function buildMenu() {
  const isMac = process.platform === 'darwin'
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Audio…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { type: 'separator' },
        { label: 'Keyboard && Pedal Shortcuts…', accelerator: 'CmdOrCtrl+,', click: () => send('shortcuts') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Needed so Cut/Copy/Paste work in text fields (marker names), esp. on macOS.
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ---- files ----
ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Open audio file',
    properties: ['openFile'],
    filters: [
      { name: 'Audio', extensions: AUDIO_EXTENSIONS },
      { name: 'All files', extensions: ['*'] },
    ],
  })
  if (result.canceled || result.filePaths.length === 0) return null
  return readAudio(result.filePaths[0])
})

ipcMain.handle('file:initial', async () => {
  const file = initialFile
  initialFile = undefined
  return file ? readAudio(path.resolve(file)) : null
})

// ---- per-file project data (markers, loops, EQ…) ----
const projectsDir = () => path.join(app.getPath('userData'), 'projects')
const projectPath = (key) => path.join(projectsDir(), crypto.createHash('sha1').update(String(key)).digest('hex') + '.json')

ipcMain.handle('project:load', async (_e, key) => {
  try {
    return await fs.readFile(projectPath(key), 'utf8')
  } catch {
    return null
  }
})

ipcMain.handle('project:save', async (_e, key, json) => {
  if (typeof json !== 'string' || json.length > 5_000_000) return false
  await fs.mkdir(projectsDir(), { recursive: true })
  const file = projectPath(key)
  await fs.writeFile(file + '.tmp', json, 'utf8')
  await fs.rename(file + '.tmp', file)
  return true
})

// ---- global hotkeys (work while another app — notation software, a DAW — has focus) ----
ipcMain.handle('shortcuts:setGlobal', (_e, list) => {
  globalShortcut.unregisterAll()
  const failed = []
  for (const { accelerator, action } of Array.isArray(list) ? list : []) {
    try {
      const ok = globalShortcut.register(accelerator, () => win?.webContents.send('shortcuts:triggered', action))
      if (!ok) failed.push(accelerator)
    } catch {
      failed.push(accelerator)
    }
  }
  return failed
})

// ---- lifecycle ----
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) app.quit()

app.on('second-instance', async (_e, argv) => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
  const file = findAudioArg(argv)
  if (file) win.webContents.send('file:opened', await readAudio(path.resolve(file)))
})

app.on('open-file', (e, file) => {
  // macOS: file dropped on the dock icon or opened via Finder
  e.preventDefault()
  if (win) readAudio(file).then((p) => win?.webContents.send('file:opened', p))
  else initialFile = file
})

app.whenReady().then(() => {
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
