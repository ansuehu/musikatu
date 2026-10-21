// Runs in an Electron utility process: ONNX Runtime inference for stem separation,
// isolated from the UI and audio threads. Talks to the main process via process.parentPort.
const fsp = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const beatTracker = require('../beats/beat-tracker.cjs')
const basicPitch = require('../transcription/basic-pitch.cjs')

// A native library that won't load (on Windows: a missing Visual C++ runtime DLL) must fail each job
// with a readable message, not kill the process before it can answer.
let ort = null
let ortError = null
try {
  ort = require('onnxruntime-node')
  // Probing GPU backends that aren't installed is expected; keep those failures out of the log.
  ort.env.logLevel = 'fatal'
} catch (err) {
  ortError = err
}

const SAMPLE_RATE = 44100
const SEGMENT = 343980 // 7.8 s, fixed by the exported graph
const OVERLAP = SEGMENT / 4
const STRIDE = SEGMENT - OVERLAP

/** GPU backends to try, best first, per platform. WebGPU runs on Vulkan/Metal/D3D12, so it covers AMD and Intel. */
const GPU_EPS = { win32: ['dml', 'webgpu'], darwin: ['webgpu', 'coreml'], linux: ['cuda', 'webgpu'] }[process.platform] ?? ['webgpu']

let session = null
let sessionKey = ''

const post = (msg) => process.parentPort.postMessage(msg)

async function openSession(modelPath, ep) {
  const key = `${modelPath}|${ep}`
  if (session && sessionKey === key) return
  if (session) await session.release().catch(() => {})
  session = null
  sessionKey = ''
  session = await ort.InferenceSession.create(modelPath, {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    logSeverityLevel: 4,
    // The arena and memory patterns trade ~3 GB of RAM for no measurable speed on this model.
    enableCpuMemArena: false,
    enableMemPattern: false,
    // Leave half the cores to the UI, the audio thread and everything else.
    ...(ep === 'cpu' ? { intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)) } : {}),
  })
  sessionKey = key
}

/** Opens the session on the requested device; returns the execution provider actually used. */
async function openFor(modelPath, device) {
  if (device === 'cpu') {
    await openSession(modelPath, 'cpu')
    return 'cpu'
  }
  const errors = []
  for (const ep of GPU_EPS) {
    try {
      await openSession(modelPath, ep)
      return ep
    } catch (err) {
      errors.push(`${ep}: ${String(err?.message ?? err).split('\n')[0]}`)
    }
  }
  throw new Error(`No GPU backend could start (${errors.join('; ')})`)
}

async function runChunk(left, right, start) {
  const x = new Float32Array(2 * SEGMENT)
  const end = Math.min(start + SEGMENT, left.length)
  x.set(left.subarray(start, end), 0)
  x.set(right.subarray(start, end), SEGMENT)
  const out = await session.run({ mix: new ort.Tensor('float32', x, [1, 2, SEGMENT]) })
  const data = out.stems.data
  out.stems.dispose?.()
  return { data, length: end - start }
}

function fadeWindow() {
  const w = new Float32Array(SEGMENT).fill(1)
  for (let i = 0; i < OVERLAP; i++) {
    const v = i / (OVERLAP - 1)
    w[i] = v
    w[SEGMENT - 1 - i] = v
  }
  return w
}

function wav16(left, right) {
  const n = left.length
  const buf = Buffer.alloc(44 + n * 4)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + n * 4, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 4, 28)
  buf.writeUInt16LE(4, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(n * 4, 40)
  const toI16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)))
  for (let i = 0, o = 44; i < n; i++, o += 4) {
    buf.writeInt16LE(toI16(left[i]), o)
    buf.writeInt16LE(toI16(right[i]), o + 2)
  }
  return buf
}

async function separate({ jobId, modelPath, device, left, right, outDir, sources }) {
  const t0 = performance.now()
  const ep = await openFor(modelPath, device)
  const total = left.length
  const chunks = Math.max(1, Math.ceil(total / STRIDE))
  const window = fadeWindow()
  const nSrc = sources.length
  const acc = Array.from({ length: nSrc }, () => [new Float32Array(total), new Float32Array(total)])
  const weight = new Float32Array(total)
  post({ type: 'progress', jobId, done: 0, total: chunks, ep })

  for (let c = 0; c < chunks; c++) {
    const start = c * STRIDE
    const { data, length } = await runChunk(left, right, start)
    for (let s = 0; s < nSrc; s++) {
      for (let ch = 0; ch < 2; ch++) {
        const dst = acc[s][ch]
        const off = (s * 2 + ch) * SEGMENT
        for (let i = 0; i < length; i++) dst[start + i] += data[off + i] * window[i]
      }
    }
    for (let i = 0; i < length; i++) weight[start + i] += window[i]
    post({ type: 'progress', jobId, done: c + 1, total: chunks, ep, elapsed: (performance.now() - t0) / 1000 })
  }

  for (let i = 0; i < total; i++) weight[i] = 1 / Math.max(weight[i], 1e-8)
  await fsp.mkdir(outDir, { recursive: true })
  for (let s = 0; s < nSrc; s++) {
    const [l, r] = acc[s]
    for (let i = 0; i < total; i++) {
      l[i] *= weight[i]
      r[i] *= weight[i]
    }
    await fsp.writeFile(path.join(outDir, `${sources[s]}.wav`), wav16(l, r))
  }
  const seconds = (performance.now() - t0) / 1000
  post({ type: 'done', jobId, ep, seconds })
}

/** Times one chunk on CPU and on the GPU so "Auto" can pick the faster one for this machine. */
async function benchmark({ jobId, modelPath }) {
  const left = new Float32Array(SEGMENT)
  for (let i = 0; i < SEGMENT; i++) left[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE) + 0.05 * (Math.random() - 0.5)
  const time = async () => {
    const t = performance.now()
    await runChunk(left, left, 0)
    return (performance.now() - t) / 1000
  }
  const result = { cpu: null, gpu: null, gpuEp: null, gpuError: null }
  try {
    result.gpuEp = await openFor(modelPath, 'gpu')
    await time() // first run compiles shaders
    result.gpu = await time()
  } catch (err) {
    result.gpuError = String(err?.message ?? err)
  }
  await openFor(modelPath, 'cpu')
  result.cpu = await time()
  post({ type: 'benchmark', jobId, ...result })
}

let beatSessions = null

/** Beat and downbeat tracking (Beat This! small, ~10 MB): fast enough on CPU that it never needs the GPU. */
async function beats({ jobId, mono }) {
  beatSessions ??= await beatTracker.createSessions(ort, { executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)) })
  const t0 = performance.now()
  const result = await beatTracker.trackBeats(ort, beatSessions, mono, (fraction) => post({ type: 'progress', jobId, fraction }))
  post({ type: 'beats', jobId, ...result, seconds: (performance.now() - t0) / 1000 })
}

let pitchSession = null

/** Note transcription activations (Basic Pitch, 230 KB model): CPU is plenty. */
async function transcribe({ jobId, mono }) {
  pitchSession ??= await basicPitch.createSession(ort, { executionProviders: ['cpu'], intraOpNumThreads: Math.max(1, Math.floor(os.cpus().length / 2)) })
  const t0 = performance.now()
  const r = await basicPitch.posteriors(ort, pitchSession, mono, (fraction) => post({ type: 'progress', jobId, fraction }))
  post({ type: 'transcribed', jobId, ...r, seconds: (performance.now() - t0) / 1000 })
}

process.parentPort.on('message', async (e) => {
  const msg = e.data
  try {
    if (!ort) throw new Error(`The AI engine (ONNX Runtime) could not be loaded: ${String(ortError?.message ?? ortError).split('\n')[0]}`)
    if (msg.type === 'separate') await separate(msg)
    else if (msg.type === 'benchmark') await benchmark(msg)
    else if (msg.type === 'beats') await beats(msg)
    else if (msg.type === 'transcribe') await transcribe(msg)
  } catch (err) {
    post({ type: 'error', jobId: msg.jobId, message: String(err?.message ?? err) })
  }
})
