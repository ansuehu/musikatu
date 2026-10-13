import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMON_SHAPE_NAMES, LETTER_PC, STANDARD_TUNING, chordVoicings, commonShapes, fingering, parseShape, shapeToString } from '../src/analysis/guitar.ts'
import { QUALITIES } from '../src/analysis/notes.ts'

const pcsOf = (frets: number[]) => frets.flatMap((f, s) => (f >= 0 ? [(STANDARD_TUNING[s] + f) % 12] : []))

test('every curated shape plays exactly its chord tones, root in the bass', () => {
  for (const name of COMMON_SHAPE_NAMES) {
    const [, letter, suffix] = /^([A-G])(.*)$/.exec(name)!
    const root = LETTER_PC[letter]
    const quality = QUALITIES.find((q) => q.suffix === suffix)
    assert.ok(quality, `unknown quality in ${name}`)
    const tones = new Set(quality.tones.map((t) => (root + t) % 12))
    for (const shape of commonShapes(name)) {
      const pcs = pcsOf(parseShape(shape))
      assert.equal(pcs[0], root, `${name} ${shape}: bass is not the root`)
      for (const pc of pcs) assert.ok(tones.has(pc), `${name} ${shape}: non-chord tone ${pc}`)
      const missing = [...tones].filter((pc) => !pcs.includes(pc) && pc !== (root + 7) % 12)
      assert.deepEqual(missing, [], `${name} ${shape}: missing tones`)
      assert.ok(fingering(parseShape(shape)), `${name} ${shape}: unplayable`)
    }
  }
})

test('familiar shapes come first', () => {
  assert.equal(shapeToString(chordVoicings(0, '')[0].frets), 'x32010') // C
  assert.equal(shapeToString(chordVoicings(9, 'm')[0].frets), 'x02210') // Am
  assert.equal(shapeToString(chordVoicings(5, '')[0].frets), '133211') // F
})

test('the generator finds the classic barre shapes on its own', () => {
  // F♯m and B♭ have no curated shapes
  const fsm = chordVoicings(6, 'm').map((v) => shapeToString(v.frets))
  assert.ok(fsm.includes('244222'), `F♯m: ${fsm}`)
  const bb = chordVoicings(10, '').map((v) => shapeToString(v.frets))
  assert.ok(bb.includes('x13331'), `B♭: ${bb}`)
})

test('slash chords keep the requested bass', () => {
  const v = chordVoicings(0, '', 4) // C/E
  assert.ok(v.length > 0)
  for (const x of v) assert.equal(pcsOf(x.frets)[0], 4)
  assert.ok(v.some((x) => shapeToString(x.frets) === '032010'), v.map((x) => shapeToString(x.frets)).join(' '))
})

test('every root and quality has at least one playable voicing', () => {
  for (let root = 0; root < 12; root++) {
    for (const q of QUALITIES) {
      const v = chordVoicings(root, q.suffix)
      assert.ok(v.length > 0, `no voicing for root ${root} ${q.suffix}`)
      for (const x of v) {
        const tones = new Set(q.tones.map((t) => (root + t) % 12))
        for (const pc of pcsOf(x.frets)) assert.ok(tones.has(pc))
        assert.ok(x.fingers.filter((f) => f > 0).length <= 6)
        assert.ok(Math.max(...x.fingers) <= 4)
      }
    }
  }
})

test('barre detection: only when needed', () => {
  assert.equal(fingering(parseShape('xx0232'))!.barre, null)
  assert.deepEqual(fingering(parseShape('133211'))!.barre, { fret: 1, from: 0, to: 5 })
  assert.deepEqual(fingering(parseShape('x24432'))!.barre, { fret: 2, from: 1, to: 5 })
  assert.equal(fingering(parseShape('x12345')), null)
})
