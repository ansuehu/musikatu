// Main-process side of stem separation: model management, device choice, the inference
// utility process, the per-file stems cache, and the IPC surface for the renderer.
const { app, dialog, ipcMain, shell, utilityProcess } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const model = require('./model.cjs')

const settingsPath = () => path.join(app.getPath('userData'), 'stems-settings.json')
const defaultCacheRoot = () => path.join(app.getPath('userData'), 'stems')
/** User-chosen cache folder (from settings), or null for the default. Loaded in register(). */
let customCacheRoot = null
const cacheRoot = () => customCacheRoot ?? defaultCacheRoot()
/** Cache entries are folders named by the SHA-1 of the song's project key. */
const ENTRY_RE = /^[0-9a-f]{40}$/
const cacheDir = (key) => path.join(cacheRoot(), crypto.createHash('sha1').update(String(key)).digest('hex'))

const GPU_BACKEND_LABEL = { cuda: 'CUDA', dml: 'DirectML', webgpu: 'WebGPU', coreml: 'Core ML', cpu: 'CPU' }

/** @type {Electron.UtilityProcess | null} */
let worker = null
let jobCounter = 0
/** @type {Map<number, {resolve: Function, reject: Function, onProgress?: Function}>} */
const jobs = new Map()
let downloadAbort = null
let currentSeparation = null

async function readSettings() {
  try {
    return { preference: 'auto', benchmark: null, ...JSON.parse(await fsp.readFile(settingsPath(), 'utf8')) }
  } catch {
    return { preference: 'auto', benchmark: null }
  }
}

async function writeSettings(s) {
  await fsp.writeFile(settingsPath(), JSON.stringify(s, null, 2))
}

function ensureWorker() {
  if (worker) return worker
  worker = utilityProcess.fork(path.join(__dirname, 'separator-process.cjs'), [], { serviceName: 'Musikatu stem separator' })
  worker.on('message', (msg) => {
    const job = jobs.get(msg.jobId)
    if (!job) return
    if (msg.type === 'progress') job.onProgress?.(msg)
    else if (msg.type === 'error') {
      jobs.delete(msg.jobId)
      job.reject(new Error(msg.message))
    } else {
      jobs.delete(msg.jobId)
      job.resolve(msg)
    }
  })
  worker.on('exit', (code) => {
    worker = null
    for (const [id, job] of jobs) {
      jobs.delete(id)
      job.reject(new Error(code === 0 ? 'Cancelled' : `Separator stopped unexpectedly (exit ${code})`))
    }
  })
  return worker
}

function runJob(message, onProgress, transfer) {
  const jobId = ++jobCounter
  const w = ensureWorker()
  return new Promise((resolve, reject) => {
    jobs.set(jobId, { resolve, reject, onProgress })
    w.postMessage({ ...message, jobId }, transfer)
  })
}

/** Names of the cache entry folders in the cache root (never anything else that lives there). */
async function cacheEntries() {
  try {
    return (await fsp.readdir(cacheRoot(), { withFileTypes: true })).filter((d) => d.isDirectory() && ENTRY_RE.test(d.name)).map((d) => d.name)
  } catch {
    return []
  }
}

async function cacheBytes() {
  let total = 0
  for (const id of await cacheEntries()) total += await dirSize(path.join(cacheRoot(), id))
  return total
}

async function dirSize(dir) {
  let total = 0
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name)
      total += entry.isDirectory() ? await dirSize(p) : (await fsp.stat(p)).size
    }
  } catch {
    /* missing dir */
  }
  return total
}

/** Which device "auto" resolves to, benchmarking once per machine if needed. */
async function resolveDevice(preference, send) {
  if (preference !== 'auto') return preference
  const settings = await readSettings()
  let bench = settings.benchmark
  if (!bench || bench.modelSha !== model.MODEL.sha256) {
    send({ type: 'phase', phase: 'benchmark' })
    bench = { ...(await runJob({ type: 'benchmark', modelPath: model.modelPath() })), modelSha: model.MODEL.sha256, at: Date.now() }
    delete bench.type
    delete bench.jobId
    await writeSettings({ ...settings, benchmark: bench })
  }
  return bench.gpu !== null && bench.gpu < bench.cpu * 0.95 ? 'gpu' : 'cpu'
}

function register(getWindow) {
  // a custom cache folder survives restarts; ignore it if it has disappeared (e.g. an unplugged drive)
  void readSettings().then(async (s) => {
    if (s.cacheDir && (await fsp.access(s.cacheDir).then(() => true, () => false))) customCacheRoot = s.cacheDir
  })
  const send = (event) => getWindow()?.webContents.send('stems:event', event)

  ipcMain.handle('stems:info', async () => {
    const settings = await readSettings()
    return {
      model: await model.status(),
      sources: model.MODEL.sources,
      sampleRate: model.MODEL.sampleRate,
      preference: settings.preference,
      benchmark: settings.benchmark,
      platform: process.platform,
      cacheBytes: await cacheBytes(),
    }
  })

  ipcMain.handle('stems:setPreference', async (_e, preference) => {
    if (!['auto', 'gpu', 'cpu'].includes(preference)) return
    await writeSettings({ ...(await readSettings()), preference })
  })

  ipcMain.handle('stems:benchmark', async () => {
    const settings = await readSettings()
    const bench = { ...(await runJob({ type: 'benchmark', modelPath: model.modelPath() })), modelSha: model.MODEL.sha256, at: Date.now() }
    delete bench.type
    delete bench.jobId
    await writeSettings({ ...settings, benchmark: bench })
    return bench
  })

  ipcMain.handle('stems:downloadModel', async () => {
    downloadAbort?.abort()
    downloadAbort = new AbortController()
    try {
      return await model.download((received, total) => send({ type: 'download', received, total }), downloadAbort.signal)
    } finally {
      downloadAbort = null
    }
  })

  ipcMain.handle('stems:cancelDownload', () => downloadAbort?.abort())

  ipcMain.handle('stems:importModel', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: `Select ${model.MODEL.file}`,
      properties: ['openFile'],
      filters: [{ name: 'ONNX model', extensions: ['onnx'] }],
    })
    if (r.canceled || !r.filePaths[0]) return null
    return model.importFrom(r.filePaths[0])
  })

  ipcMain.handle('stems:separate', async (_e, { key, left, right }) => {
    if (!(await model.status()).installed) throw new Error('The separation model is not installed.')
    if (currentSeparation) throw new Error('A separation is already running.')
    if (!(left instanceof Float32Array) || !(right instanceof Float32Array) || left.length !== right.length) throw new Error('Bad audio input')
    const settings = await readSettings()
    const outDir = cacheDir(key)
    currentSeparation = { key }
    try {
      let device = await resolveDevice(settings.preference, send)
      const go = (dev) =>
        runJob(
          { type: 'separate', modelPath: model.modelPath(), device: dev, left, right, outDir, sources: model.MODEL.sources },
          (p) => send({ type: 'progress', done: p.done, total: p.total, ep: p.ep, label: GPU_BACKEND_LABEL[p.ep] ?? p.ep, elapsed: p.elapsed ?? 0 }),
        )
      let result
      try {
        send({ type: 'phase', phase: 'loading', device })
        result = await go(device)
      } catch (err) {
        // A GPU that can't start (missing driver/runtime) shouldn't stop the user: fall back to CPU.
        if (device !== 'gpu' || /Cancelled/.test(String(err?.message))) throw err
        send({ type: 'notice', text: `GPU unavailable, using CPU instead. ${String(err.message).slice(0, 200)}` })
        device = 'cpu'
        send({ type: 'phase', phase: 'loading', device })
        result = await go('cpu')
      }
      const meta = {
        key,
        model: model.MODEL.id,
        modelSha: model.MODEL.sha256,
        sources: model.MODEL.sources,
        sampleRate: model.MODEL.sampleRate,
        length: left.length,
        backend: GPU_BACKEND_LABEL[result.ep] ?? result.ep,
        seconds: result.seconds,
        createdAt: new Date().toISOString(),
      }
      await fsp.writeFile(path.join(outDir, 'meta.json'), JSON.stringify(meta, null, 2))
      return meta
    } catch (err) {
      await fsp.rm(outDir, { recursive: true, force: true })
      throw err
    } finally {
      currentSeparation = null
    }
  })

  ipcMain.handle('beats:track', async (_e, mono) => {
    if (!(mono instanceof Float32Array)) throw new Error('Bad audio input')
    const r = await runJob({ type: 'beats', mono }, (p) => send({ type: 'beatsProgress', fraction: p.fraction }))
    return { beats: r.beats, downbeats: r.downbeats, seconds: r.seconds, sampleRate: 22050 }
  })

  ipcMain.handle('notes:transcribe', async (_e, mono) => {
    if (!(mono instanceof Float32Array)) throw new Error('Bad audio input')
    const r = await runJob({ type: 'transcribe', mono }, (p) => send({ type: 'notesProgress', fraction: p.fraction }))
    return { note: r.note, onset: r.onset, frames: r.frames, seconds: r.seconds }
  })

  ipcMain.handle('stems:cancel', () => {
    // Killing the process is the only way to interrupt a running inference call.
    if (worker && currentSeparation) worker.kill()
  })

  ipcMain.handle('stems:load', async (_e, key) => {
    const dir = cacheDir(key)
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
      if (meta.modelSha !== model.MODEL.sha256) return null
      const stems = []
      for (const name of meta.sources) {
        const data = await fsp.readFile(path.join(dir, `${name}.wav`))
        stems.push({ name, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) })
      }
      return { meta, stems }
    } catch {
      return null
    }
  })

  ipcMain.handle('stems:export', async (_e, { key, baseName }) => {
    const r = await dialog.showOpenDialog(getWindow(), { title: 'Export stems to folder', properties: ['openDirectory', 'createDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    const dir = cacheDir(key)
    const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
    const safe = String(baseName || 'stems').replace(/[\\/:*?"<>|]/g, '_')
    for (const name of meta.sources) await fsp.copyFile(path.join(dir, `${name}.wav`), path.join(r.filePaths[0], `${safe} - ${name}.wav`))
    return r.filePaths[0]
  })

  // ---- cache management ----
  ipcMain.handle('stems:cacheList', async () => {
    const root = cacheRoot()
    const names = await cacheEntries()
    const entries = []
    for (const id of names) {
      const dir = path.join(root, id)
      let meta = null
      try {
        meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'))
      } catch {
        /* an unfinished or foreign folder: still listed so it can be deleted */
      }
      const key = meta?.key ?? null
      const sourcePath = typeof key === 'string' && key.startsWith('path:') ? key.slice(5) : null
      const name = sourcePath ? path.basename(sourcePath) : typeof key === 'string' && key.startsWith('name:') ? key.slice(5).replace(/:\d+$/, '') : 'Unknown song'
      let sourceExists = null
      if (sourcePath) sourceExists = await fsp.access(sourcePath).then(() => true, () => false)
      entries.push({
        id,
        key,
        name,
        sourcePath,
        sourceExists,
        bytes: await dirSize(dir),
        createdAt: meta?.createdAt ?? null,
        backend: meta?.backend ?? null,
        seconds: meta?.seconds ?? null,
        duration: meta ? meta.length / meta.sampleRate : null,
        complete: !!meta && meta.modelSha === model.MODEL.sha256,
      })
    }
    return entries.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  })

  ipcMain.handle('stems:cacheDelete', async (_e, id) => {
    if (typeof id !== 'string' || !ENTRY_RE.test(id)) throw new Error('Bad cache entry')
    if (currentSeparation && cacheDir(currentSeparation.key).endsWith(id)) throw new Error('That song is being separated right now.')
    await fsp.rm(path.join(cacheRoot(), id), { recursive: true, force: true })
  })

  // ---- songs whose audio file moved ----
  const exists = (p) => fsp.access(p).then(() => true, () => false)
  const isPathKey = (k) => typeof k === 'string' && k.startsWith('path:') && path.isAbsolute(k.slice(5))

  /** Whether the song with this key has cached stems. */
  ipcMain.handle('stems:has', (_e, key) => exists(path.join(cacheDir(key), 'meta.json')))

  /** Keys of cached songs of `length` model samples whose audio file is no longer where it was. */
  ipcMain.handle('stems:findMoved', async (_e, length) => {
    if (typeof length !== 'number') throw new Error('Bad length')
    const out = []
    for (const id of await cacheEntries()) {
      let meta
      try {
        meta = JSON.parse(await fsp.readFile(path.join(cacheRoot(), id, 'meta.json'), 'utf8'))
      } catch {
        continue
      }
      if (meta.modelSha !== model.MODEL.sha256 || !isPathKey(meta.key) || Math.abs(meta.length - length) > 2) continue
      if (!(await exists(meta.key.slice(5)))) out.push(meta.key)
    }
    return out
  })

  /** Moves a song's cached stems from its old key to its new one (the file was moved or renamed). */
  ipcMain.handle('stems:relink', async (_e, { from, to }) => {
    if (!isPathKey(from) || !isPathKey(to)) throw new Error('Bad key')
    if (currentSeparation && (currentSeparation.key === from || currentSeparation.key === to)) throw new Error('That song is being separated right now.')
    const src = cacheDir(from)
    const dst = cacheDir(to)
    if (await exists(dst)) throw new Error('This song already has separated stems.')
    const meta = JSON.parse(await fsp.readFile(path.join(src, 'meta.json'), 'utf8'))
    await fsp.rename(src, dst)
    await fsp.writeFile(path.join(dst, 'meta.json'), JSON.stringify({ ...meta, key: to }, null, 2))
  })

  const cacheDirInfo = () => ({ dir: cacheRoot(), isDefault: customCacheRoot === null, defaultDir: defaultCacheRoot() })
  ipcMain.handle('stems:cacheDir', () => cacheDirInfo())

  /** Moves every cache entry from the current folder to `target`, then makes `target` the cache folder. */
  async function relocate(target) {
    const from = cacheRoot()
    const to = path.resolve(target)
    if (path.resolve(from) === to) return cacheDirInfo()
    if (to.startsWith(path.resolve(from) + path.sep)) throw new Error('The new folder can’t be inside the current cache folder.')
    if (currentSeparation) throw new Error('Wait for the running separation to finish first.')
    await fsp.mkdir(to, { recursive: true })
    // fail early if we can't write there
    const probe = path.join(to, `.musikatu-write-test-${process.pid}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe, { force: true })

    const names = await cacheEntries()
    for (let i = 0; i < names.length; i++) {
      const src = path.join(from, names[i])
      const dst = path.join(to, names[i])
      getWindow()?.webContents.send('stems:event', { type: 'cacheMove', done: i, total: names.length })
      await fsp.rm(dst, { recursive: true, force: true })
      try {
        await fsp.rename(src, dst)
      } catch (err) {
        if (err.code !== 'EXDEV') throw err
        // different disk: copy, then remove the original
        await fsp.cp(src, dst, { recursive: true })
        await fsp.rm(src, { recursive: true, force: true })
      }
    }
    customCacheRoot = to === path.resolve(defaultCacheRoot()) ? null : to
    await writeSettings({ ...(await readSettings()), cacheDir: customCacheRoot })
    getWindow()?.webContents.send('stems:event', { type: 'cacheMove', done: names.length, total: names.length })
    return cacheDirInfo()
  }

  ipcMain.handle('stems:chooseCacheDir', async () => {
    const r = await dialog.showOpenDialog(getWindow(), {
      title: 'Choose a folder for separated stems',
      defaultPath: cacheRoot(),
      properties: ['openDirectory', 'createDirectory'],
    })
    if (r.canceled || !r.filePaths[0]) return null
    return relocate(r.filePaths[0])
  })

  ipcMain.handle('stems:resetCacheDir', () => relocate(defaultCacheRoot()))

  ipcMain.handle('stems:openCacheDir', async () => {
    await fsp.mkdir(cacheRoot(), { recursive: true })
    return shell.openPath(cacheRoot())
  })

  ipcMain.handle('stems:clearCache', async () => {
    // Only our own entries: the folder may be one the user chose and share with other files.
    let bytes = 0
    for (const id of await cacheEntries()) {
      if (currentSeparation && cacheDir(currentSeparation.key).endsWith(id)) continue
      const dir = path.join(cacheRoot(), id)
      bytes += await dirSize(dir)
      await fsp.rm(dir, { recursive: true, force: true })
    }
    return bytes
  })

  app.on('will-quit', () => worker?.kill())
}

module.exports = { register }
