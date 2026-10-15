import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LAYOUT, movePanel, panelsIn, raise, reorder, toggleFloat } from '../src/layout/layout.ts'

test('defaults: slim sidebar, metronome / EQ / mix float, analysis at the bottom', () => {
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'sidebar'), ['stems', 'chords', 'notes', 'beats', 'practice'])
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'float'), ['metronome', 'eq', 'mix'])
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'bottom'), ['keyboard', 'chordGuess', 'guitar'])
})

test('moving a panel to a floating window opens it on top; docking selects its tab', () => {
  let l = movePanel(DEFAULT_LAYOUT, 'chords', 'float')
  assert.equal(l.open.chords, true)
  assert.ok(l.rects.chords && l.rects.chords.w > 0)
  assert.equal(l.zOrder[l.zOrder.length - 1], 'chords')
  l = movePanel(l, 'chords', 'sidebar')
  assert.equal(l.place.chords, 'sidebar')
  assert.equal(l.tab, 'chords')
})

test('hiding the active tab falls back to another sidebar panel', () => {
  const l = movePanel({ ...DEFAULT_LAYOUT, tab: 'stems' }, 'stems', 'hidden')
  assert.equal(l.tab, 'chords')
})

test('toggle, raise and reorder', () => {
  let l = toggleFloat(DEFAULT_LAYOUT, 'eq')
  l = toggleFloat(l, 'mix')
  assert.deepEqual(l.zOrder, ['eq', 'mix'])
  l = raise(l, 'eq')
  assert.deepEqual(l.zOrder, ['mix', 'eq'])
  l = toggleFloat(l, 'eq')
  assert.equal(l.open.eq, false)
  l = reorder(l, 'practice', 'stems')
  assert.deepEqual(panelsIn(l, 'sidebar'), ['practice', 'stems', 'chords', 'notes', 'beats'])
})
