/**
 * Note extraction from Basic Pitch activations — a faithful port of
 * basic_pitch.note_creation.output_to_notes_polyphonic (+ model_frames_to_time),
 * without pitch bends.
 */

export const N_KEYS = 88
export const MIDI_OFFSET = 21
const MAX_FREQ_IDX = 87
const SAMPLE_RATE = 22050
const FFT_HOP = 256
const ANNOT_N_FRAMES = 172 // ANNOTATIONS_FPS (86) × 2 s
const AUDIO_N_SAMPLES = SAMPLE_RATE * 2 - FFT_HOP
const MAGIC_ALIGNMENT_OFFSET = 0.0018
const ENERGY_TOL = 11

export interface NoteParams {
  /** Minimum onset activation (reference default 0.5). */
  onsetThreshold: number
  /** Minimum frame activation for a note to stay on (reference default 0.3). */
  frameThreshold: number
  /** Shortest note in milliseconds (reference default 127.7). */
  minNoteMs: number
  /** Lowest / highest MIDI note to keep (21..108 = full piano). */
  minMidi: number
  maxMidi: number
  inferOnsets: boolean
  melodiaTrick: boolean
}

export const DEFAULT_NOTE_PARAMS: NoteParams = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteMs: 127.7,
  minMidi: 21,
  maxMidi: 108,
  inferOnsets: true,
  melodiaTrick: true,
}

/** A detected note in model frames. */
export interface FrameNote {
  start: number
  end: number
  midi: number
  amplitude: number
}

/** Seconds for each model frame (the reference corrects for the window hop not being a whole number of frames). */
export function frameTime(f: number): number {
  const original = (f * FFT_HOP) / SAMPLE_RATE
  const windowOffset = (FFT_HOP / SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) + MAGIC_ALIGNMENT_OFFSET
  return original - windowOffset * Math.floor(f / ANNOT_N_FRAMES)
}

function inferOnsets(onsets: Float32Array, frames: Float32Array, n: number): Float32Array {
  const nDiff = 2
  const diff = new Float32Array(n * N_KEYS)
  let maxDiff = 0
  let maxOnset = 0
  for (let i = 0; i < onsets.length; i++) if (onsets[i] > maxOnset) maxOnset = onsets[i]
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < N_KEYS; k++) {
      let d = Infinity
      for (let m = 1; m <= nDiff; m++) {
        const prev = t - m >= 0 ? frames[(t - m) * N_KEYS + k] : 0
        d = Math.min(d, frames[t * N_KEYS + k] - prev)
      }
      if (d < 0 || t < nDiff) d = 0
      diff[t * N_KEYS + k] = d
      if (d > maxDiff) maxDiff = d
    }
  }
  const out = new Float32Array(onsets.length)
  const scale = maxDiff > 0 ? maxOnset / maxDiff : 0
  for (let i = 0; i < out.length; i++) out[i] = Math.max(onsets[i], diff[i] * scale)
  return out
}

/** Polyphonic note events from frame (`note`) and onset activations, both n × 88 row-major. */
export function extractNotes(note: Float32Array, onset: Float32Array, n: number, params: NoteParams): FrameNote[] {
  const minLen = Math.round((params.minNoteMs / 1000) * (SAMPLE_RATE / FFT_HOP))
  const frames = note.slice()
  let onsets: Float32Array = onset.slice()
  // constrain_frequency
  const lo = Math.max(0, params.minMidi - MIDI_OFFSET)
  const hi = Math.min(N_KEYS, params.maxMidi - MIDI_OFFSET + 1)
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < lo; k++) frames[t * N_KEYS + k] = onsets[t * N_KEYS + k] = 0
    for (let k = hi; k < N_KEYS; k++) frames[t * N_KEYS + k] = onsets[t * N_KEYS + k] = 0
  }
  if (params.inferOnsets) onsets = inferOnsets(onsets, frames, n)

  // onset peaks (strict local maxima in time), latest first — like argrelmax + [::-1]
  const peaks: [number, number][] = []
  for (let t = 1; t < n - 1; t++) {
    for (let k = 0; k < N_KEYS; k++) {
      const v = onsets[t * N_KEYS + k]
      if (v >= params.onsetThreshold && v > onsets[(t - 1) * N_KEYS + k] && v > onsets[(t + 1) * N_KEYS + k]) peaks.push([t, k])
    }
  }
  peaks.reverse()

  const energy = frames.slice()
  const at = (t: number, k: number) => t * N_KEYS + k
  const notes: FrameNote[] = []
  const meanAmp = (s: number, e: number, k: number) => {
    let sum = 0
    for (let t = s; t < e; t++) sum += frames[at(t, k)]
    return sum / Math.max(1, e - s)
  }

  for (const [start, k] of peaks) {
    if (start >= n - 1) continue
    let i = start + 1
    let quiet = 0
    while (i < n - 1 && quiet < ENERGY_TOL) {
      quiet = energy[at(i, k)] < params.frameThreshold ? quiet + 1 : 0
      i++
    }
    i -= quiet
    if (i - start <= minLen) continue
    for (let t = start; t < i; t++) {
      energy[at(t, k)] = 0
      if (k < MAX_FREQ_IDX) energy[at(t, k + 1)] = 0
      if (k > 0) energy[at(t, k - 1)] = 0
    }
    notes.push({ start, end: i, midi: k + MIDI_OFFSET, amplitude: meanAmp(start, i, k) })
  }

  if (params.melodiaTrick) {
    // Repeatedly grow a note out of the strongest leftover energy, forwards and backwards.
    for (;;) {
      let best = -1
      let bestV = params.frameThreshold
      for (let j = 0; j < energy.length; j++) {
        if (energy[j] > bestV) {
          bestV = energy[j]
          best = j
        }
      }
      if (best < 0) break
      const mid = Math.floor(best / N_KEYS)
      const k = best % N_KEYS
      energy[best] = 0
      const clear = (t: number) => {
        energy[at(t, k)] = 0
        if (k < MAX_FREQ_IDX) energy[at(t, k + 1)] = 0
        if (k > 0) energy[at(t, k - 1)] = 0
      }
      let i = mid + 1
      let quiet = 0
      while (i < n - 1 && quiet < ENERGY_TOL) {
        quiet = energy[at(i, k)] < params.frameThreshold ? quiet + 1 : 0
        clear(i)
        i++
      }
      const end = i - 1 - quiet
      i = mid - 1
      quiet = 0
      while (i > 0 && quiet < ENERGY_TOL) {
        quiet = energy[at(i, k)] < params.frameThreshold ? quiet + 1 : 0
        clear(i)
        i--
      }
      const start = i + 1 + quiet
      if (end - start <= minLen) continue
      notes.push({ start, end, midi: k + MIDI_OFFSET, amplitude: meanAmp(start, end, k) })
    }
  }
  return notes
}
