// Main-process side of stem separation: model management, device choice, the inference
// utility process, the per-file stems cache, and the IPC surface for the renderer.
const { app, dialog, ipcMain, utilityProcess } = require('electron')
const path = require('node:path')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')
const model = require('./model.cjs')

const settingsPath = () => path.join(app.getPath('userData'), 'stems-settings.json')
const cacheRoot = () => path.join(app.getPath('userData'), 'stems')
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
  worker = utilityProcess.fork(path.join(__dirname, 'separator-process.cjs'), [], { serviceName: 'Earwork stem separator' })
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
      cacheBytes: await dirSize(cacheRoot()),
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

  ipcMain.handle('stems:clearCache', async () => {
    const bytes = await dirSize(cacheRoot())
    await fsp.rm(cacheRoot(), { recursive: true, force: true })
    return bytes
  })

  app.on('will-quit', () => worker?.kill())
}

module.exports = { register }
