import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeChords, mergeShort, segmentAt, type ChordSegment } from '../src/analysis/chordTimeline.ts'
import { chordName, midiToFreq, parseChordName } from '../src/analysis/notes.ts'

const SR = 22050

/** Plucked-ish chords with harmonics, `seconds` each. */
function progression(chords: number[][], seconds: number): Float32Array {
  const per = Math.round(seconds * SR)
  const out = new Float32Array(per * chords.length)
  chords.forEach((notes, k) => {
    for (const m of notes) {
      const f = midiToFreq(m)
      for (let i = 0; i < per; i++) {
        const env = 0.12 * Math.exp(-i / (SR * 1.5))
        let v = 0
        for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * f * h * i) / SR) / h
        out[k * per + i] += env * v
      }
    }
  })
  return out
}

const names = (segs: ChordSegment[]) => segs.map((s) => (s.chord ? chordName({ ...s.chord, score: 1 }) : 'N.C.'))

test('a I–vi–IV–V7 progression is charted with stable segments at the right times', () => {
  const C = [48, 55, 60, 64, 67]
  const Am = [45, 52, 57, 60, 64]
  const F = [41, 48, 53, 57, 60]
  const G7 = [43, 50, 53, 59, 62]
  const audio = progression([C, Am, F, G7, C], 2)
  const segs = analyzeChords(audio, SR, { vocabulary: 'standard' })
  assert.deepEqual(names(segs), ['C', 'Am', 'F', 'G7', 'C'])
  segs.forEach((s, i) => {
    assert.ok(Math.abs(s.start / SR - 2 * i) < 0.35, `segment ${i} starts at ${(s.start / SR).toFixed(2)} s`)
  })
})

test('the simple vocabulary reduces sevenths to triads', () => {
  const G7 = [43, 50, 53, 59, 62]
  const segs = analyzeChords(progression([G7], 3), SR, { vocabulary: 'simple' })
  assert.deepEqual(names(segs), ['G'])
})

test('silence becomes "no chord"', () => {
  const C = [48, 55, 60, 64, 67]
  const audio = new Float32Array(SR * 6)
  audio.set(progression([C], 2), SR * 2)
  const segs = analyzeChords(audio, SR, { vocabulary: 'standard' })
  assert.deepEqual(names(segs)[1], 'C')
  assert.equal(segs[0].chord, null)
})

test('mergeShort folds blips and joins equal neighbours', () => {
  const c = { root: 0, suffix: '', bass: null }
  const g = { root: 7, suffix: '', bass: null }
  const merged = mergeShort(
    [
      { start: 0, end: 100, chord: c, confidence: 1 },
      { start: 100, end: 110, chord: g, confidence: 1 },
      { start: 110, end: 200, chord: c, confidence: 1 },
      { start: 200, end: 300, chord: g, confidence: 1 },
    ],
    50,
  )
  assert.deepEqual(
    merged.map((s) => [s.start, s.end, s.chord?.root]),
    [
      [0, 200, 0],
      [200, 300, 7],
    ],
  )
  assert.equal(segmentAt(merged, 250), 1)
  assert.equal(segmentAt(merged, 999), -1)
})

test('typed chord names parse, including aliases and slash basses', () => {
  assert.deepEqual(parseChordName('Am7'), { root: 9, suffix: 'm7', bass: null })
  assert.deepEqual(parseChordName('F#m7b5'), { root: 6, suffix: 'm7♭5', bass: null })
  assert.deepEqual(parseChordName('Bb/D'), { root: 10, suffix: '', bass: 2 })
  assert.deepEqual(parseChordName('CM7'), { root: 0, suffix: 'maj7', bass: null })
  assert.deepEqual(parseChordName('E7#9'), { root: 4, suffix: '7♯9', bass: null })
  assert.equal(parseChordName('N.C.'), null)
  assert.equal(parseChordName('hello'), undefined)
})

test('with beats, chords change exactly on the beat where the new chord takes over', () => {
  const C = [48, 55, 60, 64, 67]
  const Am = [45, 52, 57, 60, 64]
  const F = [41, 48, 53, 57, 60]
  const G = [43, 50, 55, 59, 62]
  // 2 s per chord, but every change comes 0.15 s early (strummed ahead of the bar)
  const early = Math.round(0.15 * SR)
  const audio = progression([C, Am, F, G, C], 2)
  const shifted = new Float32Array(audio.length)
  shifted.set(audio.subarray(early))
  // beats every 0.5 s from 0.25 s; a bar is 4 beats with downbeats on 0.25, 2.25, …
  const beats: number[] = []
  for (let t = 0.25; t < 10; t += 0.5) beats.push(Math.round(t * SR))
  const downbeats = beats.map((_, i) => i).filter((i) => i % 4 === 0)
  const segs = analyzeChords(shifted, SR, { vocabulary: 'standard', beats, downbeats })
  assert.deepEqual(names(segs), ['C', 'Am', 'F', 'G', 'C'])
  for (const s of segs.slice(1)) assert.ok(beats.includes(s.start), `change at ${(s.start / SR).toFixed(3)} s is on a beat`)
  // each change (at 1.85 s, 3.85 s, …) starts on the beat whose span the new chord mostly fills
  assert.deepEqual(
    segs.slice(1).map((s) => +(s.start / SR).toFixed(2)),
    [1.75, 3.75, 5.75, 7.75],
  )
  assert.equal(segs[segs.length - 1].end, shifted.length)
})

test('beats that start late still chart the intro', () => {
  const Am = [45, 52, 57, 60, 64]
  const audio = progression([Am, Am, Am], 2)
  const beats: number[] = []
  for (let t = 3; t < 6; t += 0.5) beats.push(Math.round(t * SR))
  const segs = analyzeChords(audio, SR, { vocabulary: 'standard', beats })
  assert.deepEqual(names(segs), ['Am'])
  assert.equal(segs[0].start, 0)
})
