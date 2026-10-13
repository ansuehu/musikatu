// Stem-separation model: where it lives, how it's fetched and verified.
const { app } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const crypto = require('node:crypto')

/**
 * HTDemucs v4, 6 sources (drums, bass, other, vocals, guitar, piano) — Défossez et al., Meta AI, MIT licence.
 * ONNX export with fp16-stored weights by adowu (MIT). Pinned to a commit so the checksum stays valid.
 */
const MODEL = {
  id: 'htdemucs_6s',
  name: 'HTDemucs 6-stem',
  file: 'htdemucs_6s_fp16weights.onnx',
  url: 'https://huggingface.co/adowu/htdemucs-6s-onnx/resolve/d83893853e32af79f4ddc8d97d7e513eb5058d14/htdemucs_6s_fp16weights.onnx',
  sha256: '7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869',
  size: 136428532,
  sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'],
  sampleRate: 44100,
  segment: 343980,
  credit: 'HTDemucs (Défossez et al., Meta AI) · ONNX export by adowu · MIT licence',
}

const modelsDir = () => path.join(app.getPath('userData'), 'models')
const modelPath = () => path.join(modelsDir(), MODEL.file)

async function status() {
  try {
    const st = await fsp.stat(modelPath())
    return { installed: st.size === MODEL.size, path: modelPath(), size: MODEL.size, name: MODEL.name, credit: MODEL.credit }
  } catch {
    return { installed: false, path: modelPath(), size: MODEL.size, name: MODEL.name, credit: MODEL.credit }
  }
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

/** Downloads the model to a .part file, verifies it, then moves it into place. */
async function download(onProgress, signal) {
  await fsp.mkdir(modelsDir(), { recursive: true })
  const part = modelPath() + '.part'
  const res = await fetch(MODEL.url, { signal, redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || MODEL.size
  const hash = crypto.createHash('sha256')
  const out = fs.createWriteStream(part)
  let received = 0
  let lastReport = 0
  try {
    for await (const chunk of res.body) {
      hash.update(chunk)
      received += chunk.length
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      const now = Date.now()
      if (now - lastReport > 150) {
        lastReport = now
        onProgress(received, total)
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  } catch (err) {
    out.destroy()
    await fsp.rm(part, { force: true })
    throw err
  }
  onProgress(received, total)
  if (hash.digest('hex') !== MODEL.sha256) {
    await fsp.rm(part, { force: true })
    throw new Error('Downloaded model failed its checksum; please try again.')
  }
  await fsp.rename(part, modelPath())
  return status()
}

/** Copies a user-supplied model file in, after checking it is exactly the expected model. */
async function importFrom(file) {
  if ((await sha256File(file)) !== MODEL.sha256) {
    throw new Error(`That file is not ${MODEL.file} (checksum mismatch).`)
  }
  await fsp.mkdir(modelsDir(), { recursive: true })
  await fsp.copyFile(file, modelPath())
  return status()
}

module.exports = { MODEL, modelPath, status, download, importFrom }
