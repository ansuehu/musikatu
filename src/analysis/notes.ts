/** Note naming, transposition and a simple note/chord estimator over a magnitude spectrum. */

export const LOWEST_KEY = 21 // A0
export const HIGHEST_KEY = 108 // C8

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

export interface Transposition {
  id: string
  label: string
  /** Written pitch = concert pitch + semitones. */
  semitones: number
}

export const TRANSPOSITIONS: Transposition[] = [
  { id: 'C', label: 'Concert (C)', semitones: 0 },
  { id: 'Bb', label: 'B♭ — trumpet, clarinet, soprano sax', semitones: 2 },
  { id: 'Bb-tenor', label: 'B♭ — tenor sax (+9th)', semitones: 14 },
  { id: 'Eb', label: 'E♭ — alto sax', semitones: 9 },
  { id: 'Eb-bari', label: 'E♭ — baritone sax', semitones: 21 },
  { id: 'F', label: 'F — horn, cor anglais', semitones: 7 },
  { id: 'guitar', label: 'Guitar / bass (8va)', semitones: 12 },
]

/** 'auto' uses lead-sheet conventions (B♭, E♭, A♭, F♯ …); the others force one accidental. */
export type Spelling = 'auto' | 'sharps' | 'flats'

const AUTO = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
// Chord roots: major-type chords read best with flats (D♭, A♭), minor ones with sharps (C♯m, G♯m).
const AUTO_MAJOR_ROOT = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const AUTO_MINOR_ROOT = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B♭', 'B']

const pcOf = (pc: number) => ((pc % 12) + 12) % 12

export function pitchClassName(pc: number, spelling: Spelling | boolean = 'auto'): string {
  const table = spelling === true || spelling === 'flats' ? FLATS : spelling === false || spelling === 'sharps' ? SHARPS : AUTO
  return table[pcOf(pc)]
}

/** Name of a (concert) MIDI note as written for the given transposition. */
export function noteName(midi: number, transpose = 0, spelling: Spelling | boolean = 'auto', withOctave = true): string {
  const m = midi + transpose
  const name = pitchClassName(m, spelling)
  return withOctave ? `${name}${Math.floor(m / 12) - 1}` : name
}

export function midiToFreq(midi: number, a4 = 440): number {
  return a4 * 2 ** ((midi - 69) / 12)
}

export function freqToMidi(freq: number, a4 = 440): number {
  return 69 + 12 * Math.log2(freq / a4)
}

// ---------- chords ----------

export const QUALITIES: { suffix: string; tones: number[] }[] = [
  { suffix: '', tones: [0, 4, 7] },
  { suffix: 'm', tones: [0, 3, 7] },
  { suffix: '7', tones: [0, 4, 7, 10] },
  { suffix: 'maj7', tones: [0, 4, 7, 11] },
  { suffix: 'm7', tones: [0, 3, 7, 10] },
  { suffix: '6', tones: [0, 4, 7, 9] },
  { suffix: 'm6', tones: [0, 3, 7, 9] },
  { suffix: 'm7♭5', tones: [0, 3, 6, 10] },
  { suffix: 'dim', tones: [0, 3, 6] },
  { suffix: 'dim7', tones: [0, 3, 6, 9] },
  { suffix: 'aug', tones: [0, 4, 8] },
  { suffix: 'sus2', tones: [0, 2, 7] },
  { suffix: 'sus4', tones: [0, 5, 7] },
  { suffix: '7sus4', tones: [0, 5, 7, 10] },
  { suffix: 'add9', tones: [0, 2, 4, 7] },
  { suffix: '5', tones: [0, 7] },
]

export interface ChordGuess {
  root: number
  suffix: string
  bass: number | null
  score: number
}

export function chordName(c: ChordGuess, transpose = 0, spelling: Spelling | boolean = 'auto'): string {
  const minor = /^m(?!aj)|^dim/.test(c.suffix)
  const root = spelling === 'auto' ? (minor ? AUTO_MINOR_ROOT : AUTO_MAJOR_ROOT)[pcOf(c.root + transpose)] : pitchClassName(c.root + transpose, spelling)
  const bass = c.bass !== null && c.bass !== c.root ? `/${pitchClassName(c.bass + transpose, spelling)}` : ''
  return `${root}${c.suffix}${bass}`
}

/** Best-matching chord for a 12-bin chroma (non-negative weights). */
export function guessChord(chroma: Float32Array | number[], bassPc: number | null): ChordGuess | null {
  let total = 0
  let present = 0
  for (let pc = 0; pc < 12; pc++) {
    total += chroma[pc]
    if (chroma[pc] > 0) present++
  }
  if (total <= 0 || present < 2) return null
  let best: ChordGuess | null = null
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      let inside = 0
      const mask = new Array(12).fill(false)
      for (const t of q.tones) {
        const pc = (root + t) % 12
        mask[pc] = true
        inside += chroma[pc]
      }
      // a missing chord tone costs; the root must actually sound
      let missing = 0
      for (const t of q.tones) if (chroma[(root + t) % 12] <= 0) missing++
      if (chroma[root] <= 0) continue
      const outside = total - inside
      let score = (inside - 1.1 * outside) / total - 0.2 * missing - 0.02 * q.tones.length
      if (bassPc === root) score += 0.08
      if (!best || score > best.score) {
        best = { root, suffix: q.suffix, bass: bassPc !== null && mask[bassPc] ? bassPc : null, score }
      }
    }
  }
  return best && best.score > 0.25 ? best : null
}

// ---------- estimation ----------

export interface NoteEstimate {
  /** Fundamental energy per MIDI note (0..1 relative to the loudest), index = MIDI number. */
  energy: Float32Array
  /** Detected notes (MIDI), ascending. */
  notes: number[]
  chord: ChordGuess | null
  /** Strongest spectral peak, with its deviation from equal temperament. */
  peak: { freq: number; midi: number; cents: number } | null
}

const HARMONIC_WEIGHTS = [1, 0.5, 0.33, 0.25, 0.2]

/**
 * @param mags linear magnitudes per bin
 * @param binHz frequency (as heard) of one bin
 * @param a4 tuning reference
 */
export function estimateNotes(mags: Float32Array, binHz: number, a4 = 440): NoteEstimate {
  const nBins = mags.length
  const bandEnergy = (f: number): number => {
    const lo = Math.max(1, Math.floor((f * 2 ** (-0.45 / 12)) / binHz))
    const hi = Math.min(nBins - 1, Math.ceil((f * 2 ** (0.45 / 12)) / binHz))
    let m = 0
    for (let k = lo; k <= hi; k++) if (mags[k] > m) m = mags[k]
    return m
  }

  const fund = new Float32Array(128)
  const sal = new Float32Array(128)
  let maxFund = 0
  for (let n = LOWEST_KEY; n <= HIGHEST_KEY; n++) {
    const f = midiToFreq(n, a4)
    fund[n] = bandEnergy(f)
    if (fund[n] > maxFund) maxFund = fund[n]
  }

  const energy = new Float32Array(128)
  const result: NoteEstimate = { energy, notes: [], chord: null, peak: null }
  // Below roughly -66 dBFS there's nothing worth naming.
  if (maxFund < 5e-4) return result

  let maxSal = 0
  for (let n = LOWEST_KEY; n <= HIGHEST_KEY; n++) {
    energy[n] = fund[n] / maxFund
    if (fund[n] < 0.08 * maxFund) continue
    const f = midiToFreq(n, a4)
    let s = 0
    for (let h = 0; h < HARMONIC_WEIGHTS.length; h++) s += HARMONIC_WEIGHTS[h] * bandEnergy(f * (h + 1))
    sal[n] = s
    if (s > maxSal) maxSal = s
  }

  const candidates: number[] = []
  for (let n = LOWEST_KEY; n <= HIGHEST_KEY; n++) {
    if (sal[n] < 0.3 * maxSal) continue
    if (sal[n] < sal[n - 1] || sal[n] < sal[n + 1]) continue
    // Probably just a harmonic of a stronger lower note (octave, 12th, 2 octaves)?
    const harmonicOf = [12, 19, 24].some((d) => n - d >= LOWEST_KEY && fund[n - d] > 1.4 * fund[n] && sal[n - d] > sal[n])
    if (harmonicOf) continue
    candidates.push(n)
  }
  candidates.sort((a, b) => sal[b] - sal[a])
  const notes = candidates.slice(0, 6).sort((a, b) => a - b)
  result.notes = notes

  if (notes.length > 0) {
    const chroma = new Float32Array(12)
    for (const n of notes) chroma[n % 12] += sal[n]
    result.chord = notes.length >= 2 ? guessChord(chroma, notes[0] % 12) : null
  }

  // Strongest peak, refined by parabolic interpolation on log magnitude.
  let kMax = 1
  for (let k = 2; k < nBins - 1; k++) if (mags[k] > mags[kMax]) kMax = k
  if (kMax > 1 && kMax < nBins - 1 && mags[kMax] > 0) {
    const a = Math.log(mags[kMax - 1] + 1e-12)
    const b = Math.log(mags[kMax] + 1e-12)
    const c = Math.log(mags[kMax + 1] + 1e-12)
    const d = (0.5 * (a - c)) / (a - 2 * b + c || 1e-12)
    const freq = (kMax + d) * binHz
    const exact = freqToMidi(freq, a4)
    const midi = Math.round(exact)
    result.peak = { freq, midi, cents: (exact - midi) * 100 }
  }
  return result
}
