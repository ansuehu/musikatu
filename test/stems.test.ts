import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analysisGains, analysisLabel, DEFAULT_STEM_MIX, type StemMix } from '../src/stems/types.ts'

const mix = (patch: Partial<StemMix> = {}, stems: Partial<Record<string, Partial<StemMix['stems']['bass']>>> = {}): StemMix => ({
  ...DEFAULT_STEM_MIX,
  ...patch,
  stems: Object.fromEntries(Object.entries(DEFAULT_STEM_MIX.stems).map(([n, s]) => [n, { ...s, ...stems[n] }])) as StemMix['stems'],
})

test('the analysis follows what you hear: original, all stems, solo, mute and volume', () => {
  assert.equal(analysisGains(mix(), false), null)
  assert.equal(analysisLabel(mix(), false), 'Original recording')
  assert.equal(analysisGains(mix({ enabled: false }), true), null)
  assert.equal(analysisLabel(mix(), true), 'All stems, as heard')
  assert.deepEqual(analysisGains(mix({}, { bass: { solo: true } }), true), { bass: 1 })
  assert.equal(analysisLabel(mix({}, { bass: { solo: true } }), true), 'Bass (solo)')
  const m = mix({}, { vocals: { mute: true }, drums: { mute: true }, guitar: { volume: 0.5 } })
  assert.deepEqual(analysisGains(m, true), { bass: 1, guitar: 0.5, piano: 1, other: 1 })
  assert.equal(analysisLabel(m, true), 'Bass + Guitar + Piano / keys + Other, as heard')
})

test('chosen stems are analysed at full level whatever is playing', () => {
  const m = mix({ enabled: false, analyse: ['guitar', 'bass'] }, { guitar: { mute: true } })
  assert.deepEqual(analysisGains(m, true), { guitar: 1, bass: 1 })
  assert.equal(analysisLabel(m, true), 'Chosen stems: Bass + Guitar')
  // without stems there is nothing to choose from
  assert.equal(analysisGains(m, false), null)
})
