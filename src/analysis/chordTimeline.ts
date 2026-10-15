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
  /**
   * Beat positions (samples of `mono`), ascending. When given, the chart is decoded one chord per beat and
   * changes land on beats, preferably on downbeats.
   */
  beats?: number[]
  /** Indices into `beats` that start a bar. */
  downbeats?: number[]
  /**
   * Transcribed notes (positions in samples of `mono`). When given, they describe the harmony instead of, or
   * blended with, the audio spectrum: no overtones or drums, and exact note lengths.
   */
  notes?: ChordNote[]
  /** Share of the notes in the blend with the audio, 0..1 (default NOTE_WEIGHT). */
  noteWeight?: number
}

export interface ChordNote {
  start: number
  end: number
  midi: number
  velocity: number
}

/** How much the transcribed notes count against the audio spectrum when both are there (see scripts/chord-eval). */
export const NOTE_WEIGHT = 0.7

/** Cost of changing chord on a beat, by where the beat falls in the bar (tuned on the evaluation set, see scripts/chord-eval). */
export const BEAT_SWITCH_PENALTY = { downbeat: 0.18, midBar: 0.33, other: 0.65, unknownBar: 0.38 }

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
  const notes = options.notes?.length ? options.notes : null
  if ((options.beats && options.beats.length >= 4) || notes) {
    // without a beat grid, notes are pooled on a steady half-second grid instead
    const beats = options.beats && options.beats.length >= 4 ? options.beats : Array.from({ length: Math.floor(mono.length / (0.5 * sampleRate)) }, (_, i) => Math.round((i + 0.5) * 0.5 * sampleRate))
    const downbeats = options.beats && options.beats.length >= 4 ? (options.downbeats ?? []) : []
    const edges = beatSlots(beats, mono.length)
    let slots = poolFrames(frames, hop, edges)
    if (notes) slots = blend(slots, poolNotes(notes, edges), options.noteWeight ?? NOTE_WEIGHT)
    const segs = decodeOnBeats(slots, edges, options.vocabulary, beats, downbeats)
    onProgress?.(1)
    return segs
  }
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

/**
 * Slots between consecutive beats; before the first and after the last beat the median beat spacing is
 * continued, so intros and endings are charted at the same resolution. Returns slot starts plus the end.
 */
function beatSlots(beats: number[], length: number): number[] {
  const inside = beats.filter((b) => b > 0 && b < length)
  const gaps = inside.slice(1).map((b, i) => b - inside[i]).sort((a, b) => a - b)
  const spacing = Math.max(1, gaps[gaps.length >> 1] ?? length)
  const head: number[] = []
  for (let b = inside[0] - spacing; b > spacing / 2; b -= spacing) head.unshift(Math.round(b))
  const tail: number[] = []
  for (let b = inside[inside.length - 1] + spacing; b < length - spacing / 2; b += spacing) tail.push(Math.round(b))
  return [0, ...head, ...inside, ...tail, length]
}

/** Per-beat description of the harmony: pitch-class weights (sum 1), loudness and bass note. */
interface Slots {
  chroma: Float32Array[]
  level: Float32Array
  bass: (number | null)[]
}

/** Audio chroma pooled per slot (louder frames count more); bass by level-weighted vote. */
function poolFrames(frames: Frame[], hop: number, edges: number[]): Slots {
  const B = edges.length - 1
  const chroma: Float32Array[] = []
  const level = new Float32Array(B)
  const bass: (number | null)[] = []
  for (let k = 0; k < B; k++) {
    const a = edges[k]
    const b = edges[k + 1]
    let f0 = Math.max(0, Math.ceil((a - hop / 2) / hop))
    let f1 = Math.min(frames.length - 1, Math.floor((b - hop / 2 - 1) / hop))
    if (f1 < f0) f0 = f1 = Math.min(frames.length - 1, Math.max(0, Math.round((a + b) / 2 / hop - 0.5)))
    const c = new Float32Array(12)
    const votes = new Float32Array(12)
    for (let f = f0; f <= f1; f++) {
      const fr = frames[f]
      level[k] = Math.max(level[k], fr.level)
      for (let pc = 0; pc < 12; pc++) c[pc] += fr.level * fr.chroma[pc]
      if (fr.bass !== null) votes[fr.bass] += fr.level
    }
    normalise(c)
    chroma.push(c)
    let bk: number | null = null
    for (let pc = 0; pc < 12; pc++) if (votes[pc] > 0 && (bk === null || votes[pc] > votes[bk])) bk = pc
    bass.push(bk)
  }
  return { chroma, level, bass }
}

/**
 * Transcribed notes pooled per slot: each pitch class weighted by how much of the slot it fills and how loud
 * it is. The bass is the lowest note that holds for at least a quarter of the slot.
 */
function poolNotes(notes: ChordNote[], edges: number[]): Slots {
  const B = edges.length - 1
  const chroma = Array.from({ length: B }, () => new Float32Array(12))
  const level = new Float32Array(B)
  const lowest = new Int32Array(B).fill(1000)
  for (const n of notes) {
    // first slot that ends after the note starts
    let lo = 0
    let hi = B - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (edges[mid + 1] <= n.start) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < B && edges[k] < n.end; k++) {
      const len = edges[k + 1] - edges[k]
      const part = (Math.min(n.end, edges[k + 1]) - Math.max(n.start, edges[k])) / len
      if (part <= 0) continue
      const w = part * (n.velocity / 127)
      chroma[k][n.midi % 12] += w
      level[k] += w
      if (part >= 0.25 && n.midi < lowest[k]) lowest[k] = n.midi
    }
  }
  for (const c of chroma) normalise(c)
  return { chroma, level, bass: Array.from(lowest, (m) => (m < 1000 ? m % 12 : null)) }
}

/** Notes and audio together: chroma mixed with weight `w` for the notes; the notes' bass wins when they have one. */
function blend(audio: Slots, notes: Slots, w: number): Slots {
  if (w >= 1) return { ...notes, level: notes.level.map((v) => (v > NOTE_SILENCE ? 1 : 0)) }
  const chroma = audio.chroma.map((c, k) => {
    const n = notes.chroma[k]
    const hasNotes = notes.level[k] > NOTE_SILENCE
    const out = new Float32Array(12)
    for (let pc = 0; pc < 12; pc++) out[pc] = hasNotes ? (1 - w) * c[pc] + w * n[pc] : c[pc]
    return out
  })
  return { chroma, level: audio.level, bass: audio.bass.map((b, k) => notes.bass[k] ?? b) }
}

/** Below this much note coverage (velocity-weighted share of the slot), a slot counts as silent in notes-only mode. */
const NOTE_SILENCE = 0.05

function normalise(c: Float32Array) {
  let sum = 0
  for (let pc = 0; pc < 12; pc++) sum += c[pc]
  if (sum > 0) for (let pc = 0; pc < 12; pc++) c[pc] /= sum
}

/** One chord per slot (beat): Viterbi with switch costs that depend on the position in the bar. */
function decodeOnBeats(slots: Slots, edges: number[], vocabulary: Vocabulary, beats: number[], downbeats: number[]): ChordSegment[] {
  const B = edges.length - 1
  const { chroma, level, bass: bassOf } = slots
  // position in the bar of each slot (0 = downbeat), or -1 when the bar isn't known
  const isDown = new Set(downbeats.map((i) => beats[i]))
  const barPos = new Int32Array(B).fill(-1)
  if (isDown.size) {
    let pos = -1
    for (let k = 0; k < B; k++) {
      if (isDown.has(edges[k])) pos = 0
      else if (pos >= 0) pos++
      barPos[k] = pos
    }
  }

  const tpl = templates(vocabulary)
  const S = tpl.length + 1
  const NC = S - 1
  const emits = new Float32Array(B * S)
  const back = new Int32Array(B * S)
  let dp = new Float32Array(S)
  let next = new Float32Array(S)
  const P = BEAT_SWITCH_PENALTY
  for (let k = 0; k < B; k++) {
    const silent = level[k] < SILENCE
    const emit = emits.subarray(k * S, (k + 1) * S)
    for (let s = 0; s < NC; s++) emit[s] = silent ? -1 : score(chroma[k], tpl[s], bassOf[k])
    emit[NC] = silent ? 1 : NO_CHORD_SCORE
    if (k === 0) {
      dp.set(emit)
      continue
    }
    const penalty = barPos[k] < 0 ? P.unknownBar : barPos[k] === 0 ? P.downbeat : barPos[k] === 2 ? P.midBar : P.other
    let best = 0
    for (let s = 1; s < S; s++) if (dp[s] > dp[best]) best = s
    for (let s = 0; s < S; s++) {
      const jump = dp[best] - penalty
      if (dp[s] >= jump) {
        next[s] = dp[s] + emit[s]
        back[k * S + s] = s
      } else {
        next[s] = jump + emit[s]
        back[k * S + s] = best
      }
    }
    ;[dp, next] = [next, dp]
  }
  const path = new Int32Array(B)
  let st = 0
  for (let s = 1; s < S; s++) if (dp[s] > dp[st]) st = s
  for (let k = B - 1; k >= 0; k--) {
    path[k] = st
    st = back[k * S + st]
  }

  const segments: ChordSegment[] = []
  for (let k0 = 0; k0 < B; ) {
    let k1 = k0
    while (k1 + 1 < B && path[k1 + 1] === path[k0]) k1++
    const state = path[k0]
    let chord: Chord | null = null
    let conf = 0
    if (state !== NC) {
      const t = tpl[state]
      const votes = new Float32Array(12)
      let total = 0
      for (let k = k0; k <= k1; k++) {
        conf += emits[k * S + state]
        const b = bassOf[k]
        if (b !== null) {
          votes[b] += level[k]
          total += level[k]
        }
      }
      conf = Math.max(0, Math.min(1, conf / (k1 - k0 + 1)))
      let bass: number | null = null
      for (let pc = 0; pc < 12; pc++) if (pc !== t.root && t.tones.includes(pc) && total > 0 && votes[pc] / total > 0.5) bass = pc
      chord = { root: t.root, suffix: t.suffix, bass }
    }
    segments.push({ start: edges[k0], end: edges[k1 + 1], chord, confidence: conf })
    k0 = k1 + 1
  }
  return segments
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
