// Beat and downbeat tracking with Beat This! (small), following the reference inference:
// log-mel at 50 frames/s → chunked model → sigmoid > 0.5 local-maximum peak picking.
// Pure functions over an onnxruntime module, so it runs in the utility process and in tests.
const path = require('node:path')
const fs = require('node:fs')

const SAMPLE_RATE = 22050
const FPS = 50
const CHUNK = 1500
const BORDER = 6

const MODEL_DIR = path.join(__dirname, 'models')

/** Loads both graphs from bytes (works from inside an asar archive too). */
async function createSessions(ort, options = {}) {
  const read = (f) => fs.readFileSync(path.join(MODEL_DIR, f))
  const opts = { graphOptimizationLevel: 'all', logSeverityLevel: 3, ...options }
  return {
    mel: await ort.InferenceSession.create(read('mel_spectrogram.onnx'), opts),
    model: await ort.InferenceSession.create(read('beat_this_small0.onnx'), opts),
  }
}

/** Mono 22.05 kHz audio → { spect: Float32Array(T×128), frames: T }. Long input is processed in slices to bound memory. */
async function melSpectrogram(ort, session, mono) {
  // The mel graph is frame-local apart from STFT padding, so slice on frame boundaries with some overlap.
  const hop = SAMPLE_RATE / FPS // 441
  const sliceFrames = 6000 // 2 minutes
  const padFrames = 8
  const total = Math.floor(mono.length / hop) + 1
  const spect = new Float32Array(total * 128)
  for (let f0 = 0; f0 < total; f0 += sliceFrames) {
    const a = Math.max(0, (f0 - padFrames) * hop)
    const b = Math.min(mono.length, (f0 + sliceFrames + padFrames) * hop)
    const out = await session.run({ audio_pcm: new ort.Tensor('float32', mono.slice(a, b), [1, b - a]) })
    const data = out.mel_spectrogram.data
    const got = out.mel_spectrogram.dims[1]
    const skip = (f0 * hop - a) / hop
    const n = Math.min(sliceFrames, total - f0, got - skip)
    spect.set(data.subarray(skip * 128, (skip + n) * 128), f0 * 128)
  }
  return { spect, frames: total }
}

/** Runs the model over overlapping chunks; earlier chunks win in overlaps ("keep_first"). */
async function predict(ort, session, spect, frames) {
  const beat = new Float32Array(frames).fill(-1000)
  const down = new Float32Array(frames).fill(-1000)
  const step = CHUNK - 2 * BORDER
  const starts = []
  for (let s = -BORDER; s < frames - BORDER; s += step) starts.push(s)
  if (frames > step && starts.length > 1) starts[starts.length - 1] = frames - (CHUNK - BORDER)
  const preds = []
  for (const start of starts) {
    const a = Math.max(0, start)
    const b = Math.min(frames, start + CHUNK)
    const left = a - start
    const right = Math.max(0, Math.min(BORDER, start + CHUNK - frames))
    const len = left + (b - a) + right
    // The exported graph has a fixed 1500-frame window; only very short songs need the extra zero padding.
    const x = new Float32Array(CHUNK * 128)
    x.set(spect.subarray(a * 128, b * 128), left * 128)
    const out = await session.run({ spect: new ort.Tensor('float32', x, [1, CHUNK, 128]) })
    preds.push({ start, beat: out.beat.data, down: out.downbeat.data, len })
  }
  for (let k = preds.length - 1; k >= 0; k--) {
    const { start, beat: pb, down: pd, len } = preds[k]
    for (let i = BORDER; i < len - BORDER; i++) {
      const f = start + i
      if (f < 0 || f >= frames) continue
      beat[f] = pb[i]
      down[f] = pd[i]
    }
  }
  return { beat, down }
}

/** Frames that are the maximum of ±3 frames and have logit > 0 (probability > 0.5). */
function pickPeaks(logits) {
  const peaks = []
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] <= 0) continue
    let isMax = true
    for (let d = -3; d <= 3 && isMax; d++) {
      const j = i + d
      if (j >= 0 && j < logits.length && logits[j] > logits[i]) isMax = false
    }
    if (isMax) peaks.push(i)
  }
  return peaks
}

/** Merges peaks closer than `width` frames into their mean (plateaus of equal logits). */
function dedupe(peaks, width = 1) {
  const out = []
  let group = []
  for (const p of peaks) {
    if (group.length && p - group[group.length - 1] > width) {
      out.push(group.reduce((s, v) => s + v, 0) / group.length)
      group = []
    }
    group.push(p)
  }
  if (group.length) out.push(group.reduce((s, v) => s + v, 0) / group.length)
  return out
}

/** Beat and downbeat times (seconds) for mono 22.05 kHz audio. */
async function trackBeats(ort, sessions, mono, onProgress) {
  onProgress?.(0.05)
  const { spect, frames } = await melSpectrogram(ort, sessions.mel, mono)
  onProgress?.(0.3)
  const { beat, down } = await predict(ort, sessions.model, spect, frames)
  onProgress?.(0.95)
  const beats = dedupe(pickPeaks(beat)).map((f) => f / FPS)
  const rawDown = dedupe(pickPeaks(down)).map((f) => f / FPS)
  // Downbeats must coincide with beats: snap each to its nearest beat.
  const downs = new Set()
  for (const t of rawDown) {
    let best = -1
    let bestD = Infinity
    for (let i = 0; i < beats.length; i++) {
      const d = Math.abs(beats[i] - t)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    if (best >= 0) downs.add(best)
  }
  return { beats, downbeats: [...downs].sort((a, b) => a - b).map((i) => beats[i]) }
}

module.exports = { SAMPLE_RATE, createSessions, trackBeats, pickPeaks, dedupe }
