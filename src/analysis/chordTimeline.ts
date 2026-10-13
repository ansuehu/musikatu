import { SpectrumAnalyzer } from './spectrum.ts'
import { estimateNotes, QUALITIES } from './notes.ts'

export type Vocabulary = 'simple' | 'standard' | 'full'

export const VOCABULARIES: { id: Vocabulary; label: string; suffixes: string[] | null }[] = [
  { id: 'simple', label: 'Simple (major / minor)', suffixes: ['', 'm'] },
  { id: 'standard', label: 'Standard (+ 7ths, sus, dim, power)', suffixes: ['', 'm', '7', 'maj7', 'm7', 'dim', 'sus2', 'sus4', '5'] },
  { id: 'full', label: 'Full (all 16 qualities)', suffixes: null },
]

export interface Chord {
  root: number
  suffix: string
  bass: number | null
}

/** A span of the song (in samples of the analysed buffer) with one chord, or null for "no chord". */
export interface ChordSegment {
  start: number
  end: number
  chord: Chord | null
  /** 0..1, how clearly the template matched on average. */
  confidence: number
}

export interface ChordTrackOptions {
  vocabulary: Vocabulary
  hopSeconds?: number
  a4?: number
  /** Score a new chord must gain before the decoder switches to it. */
  switchPenalty?: number
}

interface Frame {
  chroma: Float32Array
  bass: number | null
  level: number
}

const SILENCE = 2e-3 // ≈ -54 dBFS fundamental
const NO_CHORD_SCORE = -0.05

/** Chroma (≈ which pitch classes sound) every `hop` seconds. */
function analyzeFrames(mono: Float32Array, sampleRate: number, hopSeconds: number, a4: number, onProgress?: (f: number) => void): Frame[] {
  const analyzer = new SpectrumAnalyzer(16384)
  const hop = Math.round(hopSeconds * sampleRate)
  const binHz = sampleRate / analyzer.size
  const frames: Frame[] = []
  const total = Math.max(1, Math.ceil(mono.length / hop))
  for (let i = 0, pos = hop / 2; pos < mono.length; i++, pos += hop) {
    const mags = analyzer.analyze([mono], pos, 'stereo', sampleRate)
    const e = estimateNotes(mags, binHz, a4)
    frames.push({ chroma: e.chroma, bass: e.bass, level: e.level })
    if (onProgress && i % 20 === 0) onProgress(i / total)
  }
  return frames
}

/** Light temporal smoothing of the chroma: notes ring past their onset, and passing tones shouldn't flip the chord. */
function smooth(frames: Frame[], radius: number): Float32Array[] {
  return frames.map((_, t) => {
    const out = new Float32Array(12)
    for (let d = -radius; d <= radius; d++) {
      const f = frames[t + d]
      if (!f) continue
      const w = 1 - Math.abs(d) / (radius + 1)
      for (let pc = 0; pc < 12; pc++) out[pc] += w * f.chroma[pc]
    }
    let sum = 0
    for (let pc = 0; pc < 12; pc++) sum += out[pc]
    if (sum > 0) for (let pc = 0; pc < 12; pc++) out[pc] /= sum
    return out
  })
}

interface Template {
  root: number
  suffix: string
  tones: number[]
}

function templates(vocabulary: Vocabulary): Template[] {
  const allowed = VOCABULARIES.find((v) => v.id === vocabulary)?.suffixes ?? null
  const out: Template[] = []
  for (const q of QUALITIES) {
    if (allowed && !allowed.includes(q.suffix)) continue
    for (let root = 0; root < 12; root++) out.push({ root, suffix: q.suffix, tones: q.tones.map((t) => (root + t) % 12) })
  }
  return out
}

/** How well a normalised chroma fits a chord: in-chord energy, minus out-of-chord energy and missing tones. */
function score(c: Float32Array, t: Template, bass: number | null): number {
  let max = 0
  for (let pc = 0; pc < 12; pc++) if (c[pc] > max) max = c[pc]
  if (max === 0) return -1
  let inside = 0
  let missing = 0
  for (const pc of t.tones) {
    inside += c[pc]
    if (c[pc] < 0.12 * max) missing++
  }
  if (c[t.root] < 0.12 * max) return -1
  let s = inside - 1.1 * (1 - inside) - 0.2 * missing - 0.02 * t.tones.length
  if (bass === t.root) s += 0.08
  return s
}

/**
 * Whole-song chord track: per-frame template scores decoded with Viterbi so the
 * chart changes chord only when the music clearly does.
 */
export function analyzeChords(
  mono: Float32Array,
  sampleRate: number,
  options: ChordTrackOptions,
  onProgress?: (fraction: number) => void,
): ChordSegment[] {
  const hopSeconds = options.hopSeconds ?? 0.2
  const hop = Math.round(hopSeconds * sampleRate)
  const penalty = options.switchPenalty ?? 0.9
  const frames = analyzeFrames(mono, sampleRate, hopSeconds, options.a4 ?? 440, (f) => onProgress?.(f * 0.9))
  if (frames.length === 0) return []
  const chroma = smooth(frames, 2)
  const tpl = templates(options.vocabulary)
  const S = tpl.length + 1 // last state = no chord
  const NC = S - 1
  const T = frames.length

  // Viterbi with a constant switch penalty: dp[s] = emit + max(dp[s], best - penalty).
  const emit = new Float32Array(S)
  let dp = new Float32Array(S)
  let next = new Float32Array(S)
  const back = new Int32Array(T * S)
  const emits = new Float32Array(T * S)
  for (let t = 0; t < T; t++) {
    const silent = frames[t].level < SILENCE
    for (let s = 0; s < NC; s++) emit[s] = silent ? -1 : score(chroma[t], tpl[s], frames[t].bass)
    emit[NC] = silent ? 1 : NO_CHORD_SCORE
    emits.set(emit, t * S)
    if (t === 0) {
      dp.set(emit)
      continue
    }
    let best = 0
    for (let s = 1; s < S; s++) if (dp[s] > dp[best]) best = s
    for (let s = 0; s < S; s++) {
      const stay = dp[s]
      const jump = dp[best] - penalty
      if (stay >= jump) {
        next[s] = stay + emit[s]
        back[t * S + s] = s
      } else {
        next[s] = jump + emit[s]
        back[t * S + s] = best
      }
    }
    ;[dp, next] = [next, dp]
  }
  const path = new Int32Array(T)
  let s = 0
  for (let k = 1; k < S; k++) if (dp[k] > dp[s]) s = k
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s
    s = back[t * S + s]
  }

  // Collapse the state path into segments; pick a slash bass when one note dominates the bottom.
  const segments: ChordSegment[] = []
  for (let t0 = 0; t0 < T; ) {
    let t1 = t0
    while (t1 + 1 < T && path[t1 + 1] === path[t0]) t1++
    const state = path[t0]
    let chord: Chord | null = null
    let conf = 0
    if (state !== NC) {
      const t = tpl[state]
      const bassVotes = new Float32Array(12)
      let votes = 0
      for (let k = t0; k <= t1; k++) {
        const b = frames[k].bass
        if (b !== null) {
          bassVotes[b] += frames[k].level
          votes += frames[k].level
        }
        conf += emits[k * S + state]
      }
      conf = Math.max(0, Math.min(1, conf / (t1 - t0 + 1)))
      let bass: number | null = null
      for (let pc = 0; pc < 12; pc++) {
        if (pc !== t.root && t.tones.includes(pc) && votes > 0 && bassVotes[pc] / votes > 0.5) bass = pc
      }
      chord = { root: t.root, suffix: t.suffix, bass }
    }
    segments.push({ start: t0 * hop, end: Math.min(mono.length, (t1 + 1) * hop), chord, confidence: conf })
    t0 = t1 + 1
  }
  onProgress?.(1)
  return mergeShort(segments, Math.round(0.8 * sampleRate))
}

const same = (a: Chord | null, b: Chord | null) =>
  a === b || (!!a && !!b && a.root === b.root && a.suffix === b.suffix && a.bass === b.bass)

/** Folds blips shorter than `minLength` into the previous segment, then re-joins equal neighbours. */
export function mergeShort(segments: ChordSegment[], minLength: number): ChordSegment[] {
  const out: ChordSegment[] = []
  for (const seg of segments) {
    const prev = out[out.length - 1]
    if (prev && (seg.end - seg.start < minLength || same(prev.chord, seg.chord))) {
      prev.end = seg.end
      continue
    }
    if (!prev && seg.end - seg.start < minLength && segments.length > 1) {
      // a short first segment joins the next one instead
      const nextSeg = segments[1]
      nextSeg.start = seg.start
      continue
    }
    out.push({ ...seg })
  }
  return out
}

/** Index of the segment containing `pos`, or -1. */
export function segmentAt(segments: ChordSegment[], pos: number): number {
  let lo = 0
  let hi = segments.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pos < segments[mid].start) hi = mid - 1
    else if (pos >= segments[mid].end) lo = mid + 1
    else return mid
  }
  return -1
}
