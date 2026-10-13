import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NOTE_PARAMS, extractNotes, frameTime, N_KEYS } from '../src/transcription/basicPitch.ts'
import { TPQ, tickMap, writeMidi } from '../src/transcription/midi.ts'
import { NoteSynth } from '../src/dsp/NoteSynth.ts'
import { buildGrid } from '../src/rhythm/grid.ts'

/** Synthetic activations: one note on key k from frame a to b with an onset spike at a. */
function activations(n: number, notes: [number, number, number][]) {
  const note = new Float32Array(n * N_KEYS)
  const onset = new Float32Array(n * N_KEYS)
  for (const [k, a, b] of notes) {
    for (let t = a; t < b; t++) note[t * N_KEYS + k] = 0.8
    onset[a * N_KEYS + k] = 0.9
  }
  return { note, onset }
}

test('notes come out of onset + sustained frame activations; short blips are dropped', () => {
  const { note, onset } = activations(300, [
    [39, 20, 80], // C4 (key 39 = MIDI 60), 60 frames
    [43, 50, 120], // E4
    [46, 200, 205], // too short (5 frames < 11)
  ])
  const notes = extractNotes(note, onset, 300, { ...DEFAULT_NOTE_PARAMS, melodiaTrick: false })
  const byMidi = Object.fromEntries(notes.map((n) => [n.midi, n]))
  assert.deepEqual(Object.keys(byMidi).map(Number).sort(), [60, 64])
  assert.equal(byMidi[60].start, 20)
  assert.equal(byMidi[60].end, 80)
  assert.ok(Math.abs(byMidi[60].amplitude - 0.8) < 1e-6)
})

test('pitch range limits are honoured', () => {
  const { note, onset } = activations(200, [
    [10, 20, 80], // MIDI 31
    [60, 20, 80], // MIDI 81
  ])
  const notes = extractNotes(note, onset, 200, { ...DEFAULT_NOTE_PARAMS, minMidi: 40, maxMidi: 72 })
  assert.equal(notes.length, 0)
})

test('frame times follow the reference alignment correction', () => {
  assert.equal(frameTime(0), 0)
  assert.ok(Math.abs(frameTime(86) - (86 * 256) / 22050) < 1e-9)
  assert.ok(frameTime(172) < (172 * 256) / 22050) // shifted back once per 2 s window
})

test('MIDI tick map: beats become quarters, audio 0 stays tick 0, pickup becomes a short bar', () => {
  const SR = 1000
  // 100 BPM (600 ms beats) starting at 0.9 s; the first downbeat is the 2nd beat → one-beat pickup
  const beats = Array.from({ length: 12 }, (_, i) => 0.9 + i * 0.6)
  const grid = buildGrid(beats, [1.5, 3.9, 6.3], SR)
  const map = tickMap(grid, SR)
  assert.equal(map.toTick(0), 0)
  const firstBeatTick = map.toTick(900)
  assert.equal(firstBeatTick % TPQ, 0)
  assert.equal(map.toTick(1500) - map.toTick(900), TPQ)
  // the pickup measure ends exactly where the first downbeat is
  const pickup = map.signatures[0]
  const full = map.signatures[map.signatures.length - 1]
  assert.equal(full.num, 4)
  assert.equal(full.tick, map.toTick(1500))
  assert.ok(pickup.num < 4)
  // 600 ms per quarter
  assert.ok(map.tempos.some((t) => Math.abs(t.usPerQuarter - 600000) <= 1))
})

test('writeMidi produces a valid format-1 file with notes on the right ticks', () => {
  const SR = 1000
  const data = writeMidi([{ name: 'Bass', program: 33, notes: [{ start: 1000, end: 1500, midi: 40, velocity: 100 }] }], null, SR)
  const str = (a: number, n: number) => String.fromCharCode(...data.slice(a, a + n))
  assert.equal(str(0, 4), 'MThd')
  assert.equal((data[10] << 8) | data[11], 2) // tracks: conductor + bass
  assert.equal((data[12] << 8) | data[13], TPQ)
  // find the note-on and check its absolute tick: 1 s at 120 BPM = 2 quarters
  let p = 14
  const tracks: number[][] = []
  while (p < data.length) {
    const len = (data[p + 4] << 24) | (data[p + 5] << 16) | (data[p + 6] << 8) | data[p + 7]
    tracks.push([...data.slice(p + 8, p + 8 + len)])
    p += 8 + len
  }
  const t = tracks[1]
  let i = 0
  let tick = 0
  let noteOnTick = -1
  let noteOffTick = -1
  while (i < t.length) {
    let delta = 0
    let b
    do {
      b = t[i++]
      delta = (delta << 7) | (b & 0x7f)
    } while (b & 0x80)
    tick += delta
    const status = t[i]
    if (status === 0xff) {
      const len = t[i + 2]
      i += 3 + len
    } else if ((status & 0xf0) === 0xc0) i += 2
    else {
      if ((status & 0xf0) === 0x90) noteOnTick = tick
      if ((status & 0xf0) === 0x80) noteOffTick = tick
      i += 3
    }
  }
  assert.equal(noteOnTick, 2 * TPQ)
  assert.equal(noteOffTick, 3 * TPQ)
})

test('note synth starts a note when playback crosses it and releases it after its end', () => {
  const SR = 48000
  const s = new NoteSynth(SR)
  s.enabled = true
  s.setNotes(Float64Array.of(1040), Float64Array.of(1100), Uint8Array.of(69), Float32Array.of(100))
  const out = [new Float32Array(128), new Float32Array(128)]
  s.render(out, 128, 1000, 1128, null, 1)
  const onset = out[0].findIndex((v) => v !== 0)
  assert.ok(Math.abs(onset - 40) <= 1, `onset ${onset}`)
  assert.ok(s.busy)
  // keep playing well past the end: the release fades it out
  for (let k = 0; k < 40; k++) s.render([new Float32Array(128), new Float32Array(128)], 128, 1128 + k * 128, 1256 + k * 128, null, 1)
  assert.equal(s.busy, false)
})

test('MIDI bars follow irregular grid bars with time-signature changes', () => {
  const SR = 1000
  const beats = Array.from({ length: 14 }, (_, i) => i * 0.5)
  // bars of 4, 2, 4, 4 beats starting at beat 0 (no pickup)
  const grid = buildGrid(beats, [0, 2, 3, 5], SR)
  const map = tickMap(grid, SR)
  assert.deepEqual(
    map.signatures.map((s) => [s.tick / TPQ, s.num]),
    [
      [0, 4],
      [4, 2],
      [6, 4],
    ],
  )
  // every downbeat sits on a bar line implied by those signatures
  for (const d of grid.downbeats) assert.equal(map.toTick(grid.beats[d]) % TPQ, 0)
})
