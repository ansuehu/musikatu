// Basic Pitch (Spotify, ICASSP 2022, Apache-2.0) model runner: mono 22.05 kHz audio → frame-level
// note and onset activations (88 piano keys, ~86 frames/s), windowed and unwrapped exactly like
// basic_pitch.inference.run_inference (release 0.4.0). Note extraction happens in the renderer (src/transcription).
const path = require('node:path')
const fs = require('node:fs')

const SAMPLE_RATE = 22050
const FFT_HOP = 256
const AUDIO_N_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP // 43844
const FRAMES_PER_WINDOW = 172
const N_OVERLAP_FRAMES = 30
const OVERLAP_LEN = N_OVERLAP_FRAMES * FFT_HOP // 7680
const HOP = AUDIO_N_SAMPLES - OVERLAP_LEN // 36164
const N_KEYS = 88
const BATCH = 8

const MODEL_PATH = path.join(__dirname, 'models', 'basic_pitch_nmp.onnx')
const IN = 'serving_default_input_2:0'
const OUT_NOTE = 'StatefulPartitionedCall:1'
const OUT_ONSET = 'StatefulPartitionedCall:2'

async function createSession(ort, options = {}) {
  return ort.InferenceSession.create(fs.readFileSync(MODEL_PATH), { graphOptimizationLevel: 'all', logSeverityLevel: 3, ...options })
}

/** @returns {{ note: Float32Array, onset: Float32Array, frames: number }} row-major frames × 88 */
async function posteriors(ort, session, mono, onProgress) {
  const half = OVERLAP_LEN / 2
  const padded = new Float32Array(half + mono.length)
  padded.set(mono, half)
  const starts = []
  for (let i = 0; i < padded.length; i += HOP) starts.push(i)

  const keep = FRAMES_PER_WINDOW - N_OVERLAP_FRAMES // 142 frames kept per window
  const trim = N_OVERLAP_FRAMES / 2
  // trim to the audio length, as the released basic-pitch 0.4.0 does (ANNOTATIONS_FPS = 22050 // 256 = 86)
  const total = Math.min(starts.length * keep, Math.floor(mono.length * (86 / SAMPLE_RATE)))
  const note = new Float32Array(starts.length * keep * N_KEYS)
  const onset = new Float32Array(starts.length * keep * N_KEYS)

  for (let b = 0; b < starts.length; b += BATCH) {
    const batch = starts.slice(b, b + BATCH)
    const x = new Float32Array(batch.length * AUDIO_N_SAMPLES)
    batch.forEach((s, k) => x.set(padded.subarray(s, Math.min(padded.length, s + AUDIO_N_SAMPLES)), k * AUDIO_N_SAMPLES))
    const out = await session.run({ [IN]: new ort.Tensor('float32', x, [batch.length, AUDIO_N_SAMPLES, 1]) }, [OUT_NOTE, OUT_ONSET])
    const n = out[OUT_NOTE].data
    const o = out[OUT_ONSET].data
    for (let k = 0; k < batch.length; k++) {
      const src = (k * FRAMES_PER_WINDOW + trim) * N_KEYS
      const dst = (b + k) * keep * N_KEYS
      note.set(n.subarray(src, src + keep * N_KEYS), dst)
      onset.set(o.subarray(src, src + keep * N_KEYS), dst)
    }
    onProgress?.(Math.min(1, (b + batch.length) / starts.length))
  }
  return { note: note.slice(0, total * N_KEYS), onset: onset.slice(0, total * N_KEYS), frames: total }
}

module.exports = { SAMPLE_RATE, createSession, posteriors }
