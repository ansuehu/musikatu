import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_LAYOUT, loadLayout, movePanel, openTools, panelsIn } from '../src/layout/layout.ts'

test('defaults: sidebar, bottom strip, and the rest in the Tools window', () => {
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'sidebar'), ['stems', 'chords', 'notes', 'beats'])
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'tools'), ['practice', 'metronome', 'eq', 'mix'])
  assert.deepEqual(panelsIn(DEFAULT_LAYOUT, 'bottom'), ['keyboard', 'chordGuess', 'guitar'])
})

test('dropping a panel before another one inserts it there and selects it', () => {
  const l = movePanel(DEFAULT_LAYOUT, 'eq', 'sidebar', 'chords')
  assert.deepEqual(panelsIn(l, 'sidebar'), ['stems', 'eq', 'chords', 'notes', 'beats'])
  assert.equal(l.tab, 'eq')
  assert.deepEqual(panelsIn(l, 'tools'), ['practice', 'metronome', 'mix'])
})

test('dropping without a target appends to the end of that place', () => {
  const l = movePanel(DEFAULT_LAYOUT, 'stems', 'bottom')
  assert.deepEqual(panelsIn(l, 'bottom'), ['keyboard', 'chordGuess', 'guitar', 'stems'])
  assert.equal(l.tab, 'chords') // the active sidebar tab moved away
})

test('reordering within a place and the Tools tab', () => {
  let l = movePanel(DEFAULT_LAYOUT, 'guitar', 'bottom', 'keyboard')
  assert.deepEqual(panelsIn(l, 'bottom'), ['guitar', 'keyboard', 'chordGuess'])
  l = movePanel(l, 'notes', 'tools', 'practice')
  assert.equal(l.toolsTab, 'notes')
  assert.deepEqual(panelsIn(l, 'tools'), ['notes', 'practice', 'metronome', 'eq', 'mix'])
  l = openTools(l, 'eq')
  assert.equal(l.toolsOpen, true)
  assert.equal(l.toolsTab, 'eq')
})

test('a v1 layout migrates: floating and hidden panels go to the Tools window', () => {
  const store = new Map<string, string>([['musikatu.layout.v1', JSON.stringify({ place: { stems: 'sidebar', eq: 'float', mix: 'hidden', keyboard: 'bottom' }, tab: 'stems' })]])
  ;(globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: () => {} }
  const l = loadLayout()
  assert.equal(l.place.eq, 'tools')
  assert.equal(l.place.mix, 'tools')
  assert.equal(l.place.stems, 'sidebar')
  assert.equal(l.place.keyboard, 'bottom')
})
