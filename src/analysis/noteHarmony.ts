import { NOTE_WEIGHT, type ChordNote } from './chordTimeline.ts'
import { guessChord, type NoteEstimate } from './notes.ts'
import type { NoteSource, NoteTrack } from '../transcription/types.ts'
import type { StemName } from '../stems/types.ts'

/** Stems whose notes describe the harmony. */
const HARMONY: NoteSource[] = ['bass', 'guitar', 'piano', 'other']

/** A set of transcribed notes to read chords from, sorted by start, with a key that changes when they do. */
export interface NoteSet {
  key: string
  notes: ChordNote[]
  /** Longest note, so lookups know how far back a sounding note can start. */
  maxLength: number
}

function merge(tracks: NoteTrack[]): NoteSet | null {
  const used = tracks.filter((t) => t.notes.length)
  if (!used.length) return null
  const notes = used.flatMap((t) => t.notes).sort((a, b) => a.start - b.start)
  let maxLength = 0
  for (const n of notes) maxLength = Math.max(maxLength, n.end - n.start)
  // the arrays are replaced whenever notes change, so their identity plus sizes is a sound key
  return { key: used.map((t) => `${t.source}:${t.notes.length}:${t.notes[0].start}:${t.notes[t.notes.length - 1].end}`).join('|'), notes, maxLength }
}

/** Notes for the whole-song chart: the harmony stems that were transcribed, else the full mix. */
export function chartNotes(tracks: NoteTrack[]): NoteSet | null {
  return merge(tracks.filter((t) => HARMONY.includes(t.source))) ?? merge(tracks.filter((t) => t.source === 'mix'))
}

/**
 * Notes for the live chord guess, matching what the analysis listens to: those stems' notes (drums aside),
 * or for the original recording the full mix's notes, else the harmony stems'.
 */
export function liveNotes(tracks: NoteTrack[], stems: StemName[] | null): NoteSet | null {
  if (stems) return merge(tracks.filter((t) => t.source !== 'drums' && t.source !== 'mix' && stems.includes(t.source)))
  return merge(tracks.filter((t) => t.source === 'mix')) ?? merge(tracks.filter((t) => HARMONY.includes(t.source)))
}

/**
 * Pitch-class weights (sum 1) of the notes sounding within `half` samples of `pos`, by overlap and velocity,
 * and the lowest of them as the bass. Null when nothing sounds.
 */
export function noteChromaAt(set: NoteSet, pos: number, half: number): { chroma: Float32Array; bass: number | null } | null {
  const { notes } = set
  const a = pos - half
  const b = pos + half
  // last note starting before b
  let lo = 0
  let hi = notes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].start < b) lo = mid + 1
    else hi = mid
  }
  const chroma = new Float32Array(12)
  let total = 0
  let lowest = 1000
  for (let i = lo - 1; i >= 0 && notes[i].start > a - set.maxLength; i--) {
    const n = notes[i]
    const part = Math.min(n.end, b) - Math.max(n.start, a)
    if (part <= 0) continue
    const w = (part / (b - a)) * (n.velocity / 127)
    chroma[n.midi % 12] += w
    total += w
    if (part >= 0.25 * (b - a) && n.midi < lowest) lowest = n.midi
  }
  if (total < 0.05) return null
  for (let pc = 0; pc < 12; pc++) chroma[pc] /= total
  return { chroma, bass: lowest < 1000 ? lowest % 12 : null }
}

/** Half-width of the stretch of transcribed notes the live chord guess looks at, in seconds. */
const NOTE_WINDOW_S = 0.2

/**
 * The chord guess with transcribed notes blended in (as in the chord chart). `shift` is the pitch shift in
 * semitones: the spectrum is analysed as heard, the notes are at the recording's pitch.
 */
export function withNotes(est: NoteEstimate, set: NoteSet, pos: number, sampleRate: number, shift: number): NoteEstimate {
  const n = noteChromaAt(set, pos, NOTE_WINDOW_S * sampleRate)
  if (!n) return est
  let sum = 0
  for (let pc = 0; pc < 12; pc++) sum += est.chroma[pc]
  const chroma = new Float32Array(12)
  for (let pc = 0; pc < 12; pc++) {
    const fromNotes = n.chroma[(((pc - shift) % 12) + 12) % 12]
    chroma[pc] = (1 - NOTE_WEIGHT) * (sum > 0 ? est.chroma[pc] / sum : 0) + NOTE_WEIGHT * fromNotes
  }
  const bass = n.bass !== null ? (((n.bass + shift) % 12) + 12) % 12 : est.bass
  // guessChord treats exactly-zero weights as absent; drop faint leftovers so they don't count as present
  for (let pc = 0; pc < 12; pc++) if (chroma[pc] < 0.02) chroma[pc] = 0
  return { ...est, chord: guessChord(chroma, bass) }
}
