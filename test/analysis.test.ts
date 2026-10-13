import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SpectrumAnalyzer } from '../src/analysis/spectrum.ts'
import { chordName, estimateNotes, guessChord, midiToFreq, noteName } from '../src/analysis/notes.ts'
import { ChannelMixer } from '../src/dsp/ChannelMixer.ts'

const SR = 48000

/** Notes with decaying harmonics, like a plucked or bowed instrument. */
function chord(midis: number[], seconds = 1, cents = 0): Float32Array {
  const out = new Float32Array(SR * seconds)
  for (const m of midis) {
    const f = midiToFreq(m) * 2 ** (cents / 1200)
    for (let h = 1; h <= 6; h++) {
      const a = 0.12 / h
      for (let i = 0; i < out.length; i++) out[i] += a * Math.sin((2 * Math.PI * f * h * i) / SR)
    }
  }
  return out
}

function analyse(x: Float32Array, pitch = 1) {
  const a = new SpectrumAnalyzer()
  const mags = a.analyze([x], x.length / 2, 'stereo', SR)
  return estimateNotes(mags, (SR / a.size) * pitch)
}

test('C major triad is recognised', () => {
  const e = analyse(chord([60, 64, 67]))
  assert.deepEqual(e.notes, [60, 64, 67])
  assert.equal(e.chord && chordName(e.chord), 'C')
})

test('A minor 7 is recognised', () => {
  const e = analyse(chord([57, 60, 64, 67]))
  assert.equal(e.chord && chordName(e.chord), 'Am7')
})

test('first inversion gives a slash chord', () => {
  const e = analyse(chord([52, 55, 60]))
  assert.equal(e.chord && chordName(e.chord), 'C/E')
})

test('transposition renames notes and chords for B♭ instruments', () => {
  const e = analyse(chord([60, 64, 67]))
  assert.equal(chordName(e.chord!, 2, false), 'D')
  assert.equal(noteName(58, 2), 'C4')
  assert.equal(noteName(70, 0, true), 'B♭4')
})

test('peak frequency and cents deviation are accurate', () => {
  const x = new Float32Array(SR)
  for (let i = 0; i < x.length; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * 442 * i) / SR)
  const e = analyse(x)
  assert.equal(e.peak!.midi, 69)
  assert.ok(Math.abs(e.peak!.freq - 442) < 0.2, `freq ${e.peak!.freq}`)
  assert.ok(Math.abs(e.peak!.cents - 7.85) < 0.5, `cents ${e.peak!.cents}`)
})

test('pitch shift is reflected in the estimate', () => {
  const e = analyse(chord([60, 64, 67]), 2 ** (2 / 12))
  assert.equal(e.chord && chordName(e.chord), 'D')
})

test('silence yields nothing', () => {
  const e = analyse(new Float32Array(SR))
  assert.deepEqual(e.notes, [])
  assert.equal(e.chord, null)
})

test('vocal cut cancels centre-panned content and keeps side content', () => {
  const m = new ChannelMixer(SR)
  m.mode = 'karaoke'
  const L = new Float32Array(128).fill(0.5)
  const R = new Float32Array(128).fill(0.5)
  L[3] = 0.9
  m.process([L, R], 128)
  assert.equal(L[0], 0)
  assert.equal(R[0], 0)
  assert.ok(Math.abs(L[3] - 0.4) < 1e-6)
})

test('bass-preserving vocal cut lets the low centre through', () => {
  const m = new ChannelMixer(SR)
  m.mode = 'karaoke-bass'
  const n = SR
  const L = new Float32Array(n)
  const R = new Float32Array(n)
  for (let i = 0; i < n; i++) L[i] = R[i] = 0.5 * Math.sin((2 * Math.PI * 55 * i) / SR) + 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR)
  m.process([L, R], n)
  const a = new SpectrumAnalyzer()
  const mags = a.analyze([L], n / 2, 'stereo', SR)
  const bin = (f: number) => mags[Math.round((f / SR) * a.size)]
  assert.ok(bin(55) > 0.4, `55 Hz ${bin(55)}`)
  assert.ok(bin(1000) < 0.02, `1 kHz ${bin(1000)}`)
})

test('auto spelling follows lead-sheet conventions', () => {
  const name = (root: number, suffix: string, bass: number | null = null) => chordName({ root, suffix, bass, score: 1 })
  assert.equal(name(10, ''), 'B♭')
  assert.equal(name(3, '7'), 'E♭7')
  assert.equal(name(8, ''), 'A♭')
  assert.equal(name(8, 'm'), 'G♯m')
  assert.equal(name(1, 'm7'), 'C♯m7')
  assert.equal(name(1, 'maj7'), 'D♭maj7')
  assert.equal(name(6, ''), 'F♯')
  assert.equal(name(0, '', 10), 'C/B♭')
  assert.equal(chordName({ root: 10, suffix: '', bass: null, score: 1 }, 0, 'sharps'), 'A♯')
})

test('two pitch classes only ever make a power chord', () => {
  assert.equal(guessChord([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], 11), null) // B + C
  const p5 = guessChord([1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0], 0) // C + G
  assert.equal(p5 && chordName(p5), 'C5')
})
