import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  barRange,
  beatInfo,
  buildGrid,
  doubleTempo,
  estimateMeter,
  halfTempo,
  lastBar,
  positionInfo,
  setBarOneAt,
  shiftDownbeats,
  snapToBeat,
  tempoBpm,
  withMeter,
} from '../src/rhythm/grid.ts'

const SR = 1000
// 120 BPM, a one-beat pickup, then bars of 4: downbeats at beats 1, 5, 9, 13
const beatsSec = Array.from({ length: 17 }, (_, i) => 0.25 + i * 0.5)
const downSec = [0.75, 2.75, 4.75, 6.75]
const grid = buildGrid(beatsSec, downSec, SR)

test('buildGrid maps downbeats to beats and estimates tempo and meter', () => {
  assert.deepEqual(grid.downbeats, [1, 5, 9, 13])
  assert.equal(grid.meter, 4)
  assert.equal(Math.round(tempoBpm(grid, SR)!), 120)
  assert.equal(estimateMeter([0, 3, 6, 9, 13]), 3)
})

test('bar and beat lookup, including the pickup', () => {
  assert.deepEqual(beatInfo(grid, 0), { index: 0, bar: 0, beat: 4 })
  assert.deepEqual(beatInfo(grid, 1), { index: 1, bar: 1, beat: 1 })
  assert.deepEqual(beatInfo(grid, 7), { index: 7, bar: 2, beat: 3 })
  assert.deepEqual(positionInfo(grid, 3000), { index: 5, bar: 2, beat: 1 })
  assert.deepEqual(positionInfo(grid, 100), { index: -1, bar: 0, beat: 0 })
  assert.equal(lastBar(grid), 4)
})

test('bar ranges and snapping', () => {
  assert.deepEqual(barRange(grid, 2, 20000), { start: 2750, end: 4750 })
  assert.deepEqual(barRange(grid, 4, 20000), { start: 6750, end: 8750 }) // four beats, ending one beat after the last
  assert.equal(barRange(grid, 9, 20000), null)
  assert.equal(snapToBeat(grid, 1100), 1250)
  assert.equal(snapToBeat(grid, 900), 750)
})

test('corrections: meter, shift, bar one, half and double tempo', () => {
  const g3 = withMeter(grid, 3)
  assert.deepEqual(g3.downbeats.slice(0, 4), [1, 4, 7, 10])
  assert.equal(g3.edited, true)

  assert.deepEqual(shiftDownbeats(grid, 1).downbeats, [2, 6, 10, 14])

  const renumbered = setBarOneAt(grid, 5000) // inside bar 3
  assert.equal(positionInfo(renumbered, 5000).bar, 1)
  assert.equal(positionInfo(renumbered, 800).bar, -1)

  const doubled = doubleTempo(grid)
  assert.equal(doubled.beats.length, 33)
  assert.equal(Math.round(tempoBpm(doubled, SR)!), 240)
  assert.deepEqual(doubled.downbeats, [2, 10, 18, 26])

  const halved = halfTempo(grid)
  assert.equal(Math.round(tempoBpm(halved, SR)!), 60)
  for (const d of halved.downbeats) assert.ok(downSec.map((t) => t * SR).includes(halved.beats[d]))
})

test('chord changes snap to beats; bar-by-bar sheet with repeats', async () => {
  const { snapSegmentsToBeats, chordSheetByBars } = await import('../src/rhythm/sheet.ts')
  const c = { root: 0, suffix: '', bass: null }
  const am = { root: 9, suffix: 'm', bass: null }
  const f = { root: 5, suffix: '', bass: null }
  const segs = [
    { start: 0, end: 2700, chord: c, confidence: 1 },
    { start: 2700, end: 4800, chord: am, confidence: 1 }, // change ~50 ms before bar 2's downbeat (2750)
    { start: 4800, end: 5800, chord: f, confidence: 1 },
    { start: 5800, end: 20000, chord: c, confidence: 1 },
  ]
  const snapped = snapSegmentsToBeats(segs, grid.beats, 150)
  assert.deepEqual(snapped.map((s) => s.start), [0, 2750, 4750, 5750])
  assert.equal(snapped[snapped.length - 1].end, 20000)
  const names = (ch: { root: number; suffix: string }) => ({ 0: 'C', 9: 'A', 5: 'F' } as Record<number, string>)[ch.root] + ch.suffix
  const sheet = chordSheetByBars(snapped, grid, 20000, names)
  // bar 1: C ; bar 2: Am ; bar 3: F then C on beat 3 ; bar 4: C
  assert.equal(sheet, '  1 | C | Am | F C | C |')
  const repeated = chordSheetByBars([{ start: 0, end: 20000, chord: c, confidence: 1 }], grid, 20000, names)
  assert.equal(repeated, '  1 | C | % | % | % |')
})
