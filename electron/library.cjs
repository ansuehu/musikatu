// Songs and their projects on disk: per-song project files (markers, loops, chords…), opening a song
// by its path, and finding a song again after its file was moved or renamed.
const { app, dialog, ipcMain } = require('electron')
const path = require('node:path')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')

const AUDIO_EXTENSIONS = ['wav', 'mp3', 'flac', 'aac', 'ogg', 'oga', 'opus', 'm4a', 'mp4', 'webm', 'aif', 'aiff']

async function readAudio(filePath) {
  const data = await fs.readFile(filePath)
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) }
}

/** @param {() => Electron.BrowserWindow | null} getWindow */
function register(getWindow) {
  /** Opens a song by its path (from the stem cache list): audio files only. */
  ipcMain.handle('file:openPath', async (_e, filePath) => {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !AUDIO_EXTENSIONS.includes(path.extname(filePath).slice(1).toLowerCase())) throw new Error('Not an audio file')
    return readAudio(filePath)
  })

  /** Asks where a song now is, starting in the nearest folder of its old location that still exists. */
  ipcMain.handle('file:locate', async (_e, oldPath) => {
    let dir = typeof oldPath === 'string' && path.isAbsolute(oldPath) ? path.dirname(oldPath) : app.getPath('home')
    while (!(await fs.access(dir).then(() => true, () => false)) && path.dirname(dir) !== dir) dir = path.dirname(dir)
    const result = await dialog.showOpenDialog(getWindow(), {
      title: `Where is “${typeof oldPath === 'string' ? path.basename(oldPath) : 'the song'}” now?`,
      defaultPath: dir,
      properties: ['openFile'],
      filters: [
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readAudio(result.filePaths[0])
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

  /**
   * Projects of songs lasting `duration` seconds whose audio file is no longer where it was. Projects record
   * their song's path and duration at the start of the file, so only that part is read.
   */
  ipcMain.handle('project:findMoved', async (_e, duration) => {
    const out = []
    let names = []
    try {
      names = (await fs.readdir(projectsDir())).filter((n) => /^[0-9a-f]{40}\.json$/.test(n))
    } catch {
      return out
    }
    for (const n of names) {
      let head = ''
      try {
        const fh = await fs.open(path.join(projectsDir(), n), 'r')
        const buf = Buffer.alloc(4096)
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
        await fh.close()
        head = buf.subarray(0, bytesRead).toString('utf8')
      } catch {
        continue
      }
      const m = /"source":(\{[^{}]*\})/.exec(head)
      if (!m) continue
      let src
      try {
        src = JSON.parse(m[1])
      } catch {
        continue
      }
      if (typeof src.path !== 'string' || !path.isAbsolute(src.path) || typeof src.duration !== 'number' || Math.abs(src.duration - duration) > 0.02) continue
      if (!(await fs.access(src.path).then(() => true, () => false))) out.push({ key: `path:${src.path}`, name: path.basename(src.path) })
    }
    return out
  })

  /** Moves a song's project from its old key to its new one (replacing what was saved under the new one). */
  ipcMain.handle('project:relink', async (_e, from, to) => {
    if (typeof from !== 'string' || typeof to !== 'string') return false
    try {
      await fs.rename(projectPath(from), projectPath(to))
      return true
    } catch {
      return false
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
}

module.exports = { AUDIO_EXTENSIONS, readAudio, register }
