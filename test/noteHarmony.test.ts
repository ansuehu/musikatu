import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeChords, type ChordNote } from '../src/analysis/chordTimeline.ts'
import { chartNotes, liveNotes, noteChromaAt, withNotes, type NoteSet } from '../src/analysis/noteHarmony.ts'
import { chordName, type NoteEstimate } from '../src/analysis/notes.ts'
import type { NoteTrack } from '../src/transcription/types.ts'
import { DEFAULT_NOTE_PARAMS } from '../src/transcription/basicPitch.ts'

const SR = 1000
const chord = (start: number, end: number, midis: number[]): ChordNote[] => midis.map((midi) => ({ start: start * SR, end: end * SR, midi, velocity: 100 }))
const set = (notes: ChordNote[]): NoteSet => ({ key: 'k', notes: [...notes].sort((a, b) => a.start - b.start), maxLength: Math.max(...notes.map((n) => n.end - n.start)) })
const track = (source: NoteTrack['source'], notes: ChordNote[]): NoteTrack => ({ source, notes, params: DEFAULT_NOTE_PARAMS, visible: true, play: false, edited: false })

test('note chroma at a position: overlapping notes by length and velocity, lowest held note as bass', () => {
  const s = set([...chord(0, 2, [45, 57, 60, 64]), ...chord(1.9, 2.0, [61])])
  const n = noteChromaAt(s, 1 * SR, 0.2 * SR)!
  assert.equal(n.bass, 9) // A
  assert.ok(n.chroma[9] > n.chroma[0] && n.chroma[0] > 0 && n.chroma[4] > 0)
  assert.equal(n.chroma[1], 0) // the C♯ at 1.9 s is outside the window
  assert.equal(noteChromaAt(s, 5 * SR, 0.2 * SR), null)
})

test('the chord chart reads transcribed notes, even where the audio says nothing', () => {
  const notes = [...chord(0, 2, [48, 60, 64, 67]), ...chord(2, 4, [45, 57, 60, 64]), ...chord(4, 6, [41, 53, 57, 60])]
  const silent = new Float32Array(6 * SR)
  const beats = Array.from({ length: 12 }, (_, i) => i * 0.5 * SR)
  const segs = analyzeChords(silent, SR, { vocabulary: 'standard', beats, downbeats: [0, 4, 8], notes, noteWeight: 1 })
  assert.deepEqual(segs.map((s) => (s.chord ? chordName({ ...s.chord, score: 0 }) : 'N')), ['C', 'Am', 'F'])
  assert.deepEqual(segs.map((s) => s.start / SR), [0, 2, 4])
})

test('the live guess blends notes in, shifted to the pitch you hear', () => {
  const s = set(chord(0, 2, [45, 57, 60, 64])) // Am at the recording's pitch
  const est: NoteEstimate = { energy: new Float32Array(128), notes: [], chord: null, peak: null, chroma: new Float32Array(12), bass: null, level: 0.1 }
  assert.equal(chordName(withNotes(est, s, 1 * SR, SR, 0).chord!), 'Am')
  // played 2 semitones up, it sounds as Bm
  assert.equal(chordName(withNotes(est, s, 1 * SR, SR, 2).chord!), 'Bm')
})

test('which transcriptions are used: harmony stems before the mix, and the live guess follows the analysis', () => {
  const tracks = [track('mix', chord(0, 1, [60])), track('guitar', chord(0, 1, [64])), track('vocals', chord(0, 1, [67])), track('drums', chord(0, 1, [36]))]
  assert.deepEqual(chartNotes(tracks)!.notes.map((n) => n.midi), [64])
  assert.deepEqual(chartNotes([tracks[0]])!.notes.map((n) => n.midi), [60])
  assert.deepEqual(liveNotes(tracks, ['vocals', 'drums'])!.notes.map((n) => n.midi), [67])
  assert.deepEqual(liveNotes(tracks, null)!.notes.map((n) => n.midi), [60])
  assert.equal(liveNotes(tracks, ['bass']), null)
})
