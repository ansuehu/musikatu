import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as alphaTab from '@coderline/alphatab'
import { loadTab } from '../src/tabs/alphatab.ts'
import { expandBars } from '../src/tabs/expand.ts'
import type { AudioBeats } from '../src/tabs/align.ts'
import { barSeconds, mainTrack, TICKS_PER_QUARTER, type TabBar, type TabScore } from '../src/tabs/model.ts'
import { barAt, beatToSample, regularBeats, sampleAt, syncTab, tickAt, type TabSync } from '../src/tabs/sync.ts'

const tex = (s: string) => new TextEncoder().encode(s)
const order = (bars: TabBar[]) => expandBars(bars).map((p) => p.bar + 1)

// ---- reading tabs ----

test('alphaTex tabs are read with sounding pitches, capo, tuning, sections and repeats', () => {
  const tab = loadTab(
    tex(`\\title "T" \\tempo 100
\\track "Guitar"
\\staff {tabs}
\\tuning (e4 b3 g3 d3 a2 e2)
\\capo 2
\\section "Intro" \\ro :4 0.6 2.5 (0.1 1.2) r | \\rc 3 \\ts 2 4 :2 3.6 |`),
  )
  assert.equal(tab.title, 'T')
  assert.equal(tab.tempo, 100)
  assert.equal(tab.bars.length, 2)
  assert.deepEqual(
    tab.bars.map((b) => [b.num, b.den, b.ticks, b.repeatStart, b.repeatEnd, b.section]),
    [
      [4, 4, 4 * TICKS_PER_QUARTER, true, 0, 'Intro'],
      [2, 4, 2 * TICKS_PER_QUARTER, false, 3, null],
    ],
  )
  const g = tab.tracks[0]
  assert.deepEqual(g.tuning, [40, 45, 50, 55, 59, 64])
  assert.equal(g.capo, 2)
  // the rest is dropped; strings count from the lowest; pitches include the capo
  assert.deepEqual(
    g.bars[0].map((b) => [b.start, b.notes.map((n) => [n.string, n.fret, n.midi])]),
    [
      [0, [[1, 0, 42]]],
      [960, [[2, 2, 49]]],
      [1920, [[6, 0, 66], [5, 1, 62]]],
    ],
  )
})

test('Guitar Pro files are read (written with alphaTab, read back)', () => {
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(`\\track "G" \\staff {tabs} . \\section "A" :4 3.6 2.5 0.4 0.3 | \\ae 1 :1 0.1 | \\ae 2 :1 1.1`, new alphaTab.Settings())
  const gp = new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings())
  const tab = loadTab(gp)
  assert.equal(tab.bars[0].section, 'A')
  assert.deepEqual(
    tab.bars.map((b) => b.endings),
    [0, 1, 2],
  )
  assert.deepEqual(
    tab.tracks[0].bars[0].map((b) => b.notes[0].midi),
    [43, 47, 50, 55],
  )
})

test('files that are not tabs are refused with a message', () => {
  assert.throws(() => loadTab(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /Not a tab file/)
})

// ---- writing out repeats ----

const bar = (o: Partial<TabBar> = {}): TabBar => ({ num: 4, den: 4, ticks: 3840, repeatStart: false, repeatEnd: 0, endings: 0, section: null, directions: [], tempo: 120, ...o })

test('repeats are written out, with an implicit start at the beginning', () => {
  assert.deepEqual(order([bar(), bar({ repeatEnd: 2 }), bar()]), [1, 2, 1, 2, 3])
  assert.deepEqual(order([bar(), bar({ repeatStart: true }), bar({ repeatEnd: 3 }), bar()]), [1, 2, 3, 2, 3, 2, 3, 4])
  // after a repeat, a later repeat without a start sign goes back to the bar after the first one
  assert.deepEqual(order([bar({ repeatEnd: 2 }), bar(), bar({ repeatEnd: 2 })]), [1, 1, 2, 3, 2, 3])
})

test('alternate endings are played on their passes', () => {
  const bars = [bar({ repeatStart: true }), bar({ endings: 0b01, repeatEnd: 2 }), bar({ endings: 0b10 }), bar()]
  assert.deepEqual(order(bars), [1, 2, 1, 3, 4])
  const three = [bar({ repeatStart: true }), bar({ endings: 0b011, repeatEnd: 3 }), bar({ endings: 0b100 }), bar()]
  assert.deepEqual(order(three), [1, 2, 1, 2, 1, 3, 4])
  const passes = expandBars(bars).map((p) => p.pass)
  assert.deepEqual(passes, [0, 0, 1, 1, 0])
})

test('D.S. al Coda, D.C. al Fine and plain D.C. are followed once', () => {
  const ds = [bar(), bar({ directions: ['Segno'] }), bar({ directions: ['DaCoda'] }), bar({ directions: ['DalSegnoAlCoda'] }), bar({ directions: ['Coda'] })]
  assert.deepEqual(order(ds), [1, 2, 3, 4, 2, 3, 5])
  const dc = [bar({ repeatStart: true }), bar({ repeatEnd: 2, directions: ['Fine'] }), bar({ directions: ['DaCapoAlFine'] })]
  // repeats are not taken again after the jump
  assert.deepEqual(order(dc), [1, 2, 1, 2, 3, 1, 2])
  assert.deepEqual(order([bar(), bar({ directions: ['DaCapo'] })]), [1, 2, 1, 2])
})

test('blocks change at sections, repeat passes and jumps', () => {
  const bars = [bar({ section: 'Intro' }), bar({ section: 'Verse', repeatStart: true }), bar({ repeatEnd: 2 }), bar({ section: 'Chorus' })]
  const played = expandBars(bars)
  assert.deepEqual(
    played.map((p) => [p.bar + 1, p.block, p.section]),
    [
      [1, 0, 'Intro'],
      [2, 1, 'Verse'],
      [3, 1, 'Verse'],
      [2, 2, 'Verse'],
      [3, 2, 'Verse'],
      [4, 3, 'Chorus'],
    ],
  )
})

test('a repeat that never ends does not hang', () => {
  const played = expandBars([bar({ repeatEnd: 1e9 })])
  assert.ok(played.length <= 20000)
})

// ---- alignment on synthetic recordings ----

const SR = 1000
const CHORDS: Record<string, number[]> = {
  C: [48, 52, 55, 60, 64],
  G: [43, 47, 50, 55, 59],
  Am: [45, 52, 57, 60, 64],
  F: [41, 48, 53, 57, 60],
  Dm: [50, 57, 62, 65],
  E: [40, 47, 52, 56, 59],
  Bb: [46, 50, 53, 58],
  Eb: [51, 55, 58, 63],
}

interface Section {
  name: string
  /** One chord per bar (4/4). */
  bars: string[]
  repeat?: number
}

/** A tab of strummed quarter-note chords, sections in order, with repeat signs. */
function makeTab(sections: Section[], transpose = 0): TabScore {
  const bars: TabBar[] = []
  const beats: TabScore['tracks'][0]['bars'] = []
  for (const s of sections)
    s.bars.forEach((c, i) => {
      const r = s.repeat ?? 1
      bars.push(bar({ section: i === 0 ? s.name : null, repeatStart: i === 0 && r > 1, repeatEnd: i === s.bars.length - 1 && r > 1 ? r : 0 }))
      beats.push(
        [0, 1, 2, 3].map((q) => ({
          start: q * TICKS_PER_QUARTER,
          duration: TICKS_PER_QUARTER,
          notes: CHORDS[c].map((m, k) => ({ string: k + 1, fret: 0, midi: m + transpose, tie: false, dead: false })),
        })),
      )
    })
  return { title: '', artist: '', tempo: 120, bars, tracks: [{ name: 'Guitar', tuning: [40, 45, 50, 55, 59, 64], capo: 0, percussion: false, bars: beats }] }
}

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

/**
 * The beat-synchronous harmony of a recording that plays `chords` (one per bar of 4 beats), with noise,
 * plus its beat times: starting at 1 s, `spacing` seconds per beat, growing by `drift` each beat.
 */
function recording(chords: string[], { spacing = 0.5, drift = 0, noise = 0.3, seed = 1 } = {}): { beats: number[]; audio: AudioBeats } {
  const r = rand(seed)
  const beats: number[] = []
  const chroma: Float32Array[] = []
  const bass: (number | null)[] = []
  let t = 1
  let d = spacing
  for (const c of chords)
    for (let q = 0; q < 4; q++) {
      beats.push(Math.round(t * SR))
      t += d
      d += drift
      const v = new Float32Array(12)
      for (const m of CHORDS[c]) v[m % 12] += 1
      for (let i = 0; i < 12; i++) v[i] += noise * r()
      const sum = v.reduce((a, b) => a + b, 0)
      chroma.push(v.map((x) => x / sum))
      bass.push(CHORDS[c][0] % 12)
    }
  return { beats, audio: { chroma, level: new Float32Array(beats.length).fill(0.5), bass, downbeats: beats.map((_, i) => i).filter((i) => i % 4 === 0) } }
}

const VERSE = ['C', 'G', 'Am', 'F']
const CHORUS = ['F', 'C', 'Dm', 'E']
const BRIDGE = ['Bb', 'Eb', 'Bb', 'Eb']

/** Beat index each played bar of the sync starts on. */
function startBeats(sync: TabSync, beats: number[]): Map<number, number[]> {
  const out = new Map<number, number[]>()
  for (const b of sync.bars) out.set(b.played, [...(out.get(b.played) ?? []), beats.indexOf(b.start)])
  return out
}

test('a tab that matches the recording is placed bar for bar', () => {
  const tab = makeTab([
    { name: 'Verse', bars: VERSE, repeat: 2 },
    { name: 'Chorus', bars: CHORUS },
  ])
  const { beats, audio } = recording([...VERSE, ...VERSE, ...CHORUS])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.equal(sync.shift, 0)
  assert.equal(sync.factor, 1)
  assert.deepEqual(
    sync.bars.map((b) => [b.played, beats.indexOf(b.start)]),
    Array.from({ length: 12 }, (_, p) => [p, 4 * p]),
  )
  assert.equal(sync.missing.length, 0)
  for (const s of sync.sections) assert.ok(s.confidence > 0.5, `${s.label}: ${s.confidence}`)
})

test('an intro the tab leaves out is skipped', () => {
  const tab = makeTab([
    { name: 'Verse', bars: VERSE },
    { name: 'Chorus', bars: CHORUS },
  ])
  const { beats, audio } = recording([...BRIDGE, ...VERSE, ...CHORUS])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.equal(barAt(sync, beats[2]), -1)
  assert.deepEqual(
    sync.bars.map((b) => beats.indexOf(b.start)),
    [16, 20, 24, 28, 32, 36, 40, 44],
  )
})

test('an outro the tab leaves out is left unplaced', () => {
  const tab = makeTab([{ name: 'Verse', bars: VERSE }])
  const { beats, audio } = recording([...VERSE, ...BRIDGE])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.deepEqual(
    sync.bars.map((b) => beats.indexOf(b.start)),
    [0, 4, 8, 12],
  )
  assert.equal(barAt(sync, beats[20]), -1)
})

test('a repeat the recording plays fewer times than written is skipped', () => {
  const tab = makeTab([
    { name: 'Verse', bars: VERSE, repeat: 3 },
    { name: 'Chorus', bars: CHORUS },
  ])
  const { beats, audio } = recording([...VERSE, ...VERSE, ...CHORUS])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  const starts = startBeats(sync, beats)
  // the chorus (played bars 12–15) comes right after two verses
  assert.deepEqual(
    [12, 13, 14, 15].map((p) => starts.get(p)),
    [[32], [36], [40], [44]],
  )
  assert.equal(sync.missing.length, 4)
})

test('a repeat the recording plays more times than written is followed', () => {
  const tab = makeTab([
    { name: 'Verse', bars: VERSE, repeat: 2 },
    { name: 'Chorus', bars: CHORUS },
  ])
  const { beats, audio } = recording([...VERSE, ...VERSE, ...VERSE, ...CHORUS])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.equal(sync.bars.length, 16)
  assert.deepEqual(
    sync.bars.slice(12).map((b) => [b.played, beats.indexOf(b.start)]),
    [
      [8, 48],
      [9, 52],
      [10, 56],
      [11, 60],
    ],
  )
  assert.ok(sync.sections.some((s) => s.jumped))
})

test('tempo drift is followed beat by beat', () => {
  const tab = makeTab([{ name: 'Verse', bars: [...VERSE, ...CHORUS, ...VERSE] }])
  // from 0.5 s to about 0.69 s per beat over the song
  const { beats, audio } = recording([...VERSE, ...CHORUS, ...VERSE], { drift: 0.004 })
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.deepEqual(
    sync.bars.map((b) => beats.indexOf(b.start)),
    Array.from({ length: 12 }, (_, p) => 4 * p),
  )
  // beats inside a bar land on the tracked beats too
  assert.deepEqual(sync.bars[11].beats, beats.slice(44, 48))
})

test('a tab in another key (capo, tuning) is transposed to match', () => {
  const tab = makeTab([{ name: 'Verse', bars: [...VERSE, ...CHORUS] }], -2)
  const { beats, audio } = recording([...VERSE, ...CHORUS])
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  assert.equal(sync.shift, 2)
  assert.deepEqual(
    sync.bars.map((b) => beats.indexOf(b.start)),
    [0, 4, 8, 12, 16, 20, 24, 28],
  )
})

test('a tracker counting at double speed is detected', () => {
  const tab = makeTab([{ name: 'Verse', bars: [...VERSE, ...CHORUS] }])
  const { beats, audio } = recording([...VERSE, ...CHORUS])
  // every beat split in two, each half with the same harmony
  const half = beats.flatMap((b, i) => [b, b + Math.round(((beats[i + 1] ?? b + 500) - b) / 2)])
  const doubled: AudioBeats = { chroma: audio.chroma.flatMap((c) => [c, c]), level: new Float32Array(half.length).fill(0.5), bass: audio.bass.flatMap((b) => [b, b]), downbeats: audio.downbeats.map((d) => 2 * d) }
  const sync = syncTab(tab, { beats: half, sampleRate: SR, audio: doubled })
  assert.equal(sync.factor, 2)
  assert.deepEqual(
    sync.bars.map((b) => half.indexOf(b.start) / 2),
    [0, 4, 8, 12, 16, 20, 24, 28],
  )
})

test('a bar placed by hand stays where it was put, and the rest follow', () => {
  // two identical verses: without help, the tab's single verse could be either
  const tab = makeTab([
    { name: 'Verse', bars: VERSE },
    { name: 'Chorus', bars: CHORUS },
  ])
  const { beats, audio } = recording([...VERSE, ...VERSE, ...CHORUS])
  const free = syncTab(tab, { beats, sampleRate: SR, audio })
  const freeVerse = free.bars.find((b) => b.played === 0)!
  const other = beats.indexOf(freeVerse.start) === 0 ? 16 : 0
  const pinned = syncTab(tab, { beats, sampleRate: SR, audio, anchors: [{ played: 0, pos: beats[other] + 30 }] })
  const first = pinned.bars.find((b) => b.played === 0 && Math.abs(b.start - beats[other]) < 100)!
  assert.ok(first, 'verse placed at the anchor')
  assert.equal(first.start, beats[other] + 30)
  assert.ok(first.pinned)
  // the chorus is still where the recording plays it
  assert.equal(beats.indexOf(pinned.bars.find((b) => b.played === 4)!.start), 32)
})

test('missing and stray tracked beats are repaired', () => {
  const beats = Array.from({ length: 40 }, (_, i) => i * 500)
  const holed = beats.filter((_, i) => i !== 10 && i !== 21 && i !== 22)
  holed.splice(30, 0, 14_900 + 60)
  const { beats: fixed, downbeats } = regularBeats(holed, [0, 8])
  assert.equal(fixed.length, 40)
  for (let i = 0; i < 40; i++) assert.ok(Math.abs(fixed[i] - beats[i]) <= 1, `beat ${i}: ${fixed[i]}`)
  assert.deepEqual(downbeats, [0, 8])
})

// ---- bar ↔ time ----

test('bars map to times and back', () => {
  const beats = [1000, 1500, 2000, 2600, 3200, 3700, 4200, 4700]
  assert.equal(beatToSample(beats, 2.5), 2300)
  assert.equal(beatToSample(beats, 7.5), 4950)
  assert.equal(beatToSample(beats, -1), 500)
  const sync: TabSync = {
    bars: [
      { played: 0, start: 1000, end: 3200, beats: [1000, 1500, 2000, 2600], unitTicks: TICKS_PER_QUARTER, section: 0, pinned: false, match: 1 },
      { played: 1, start: 3200, end: 5200, beats: [3200, 3700, 4200, 4700], unitTicks: TICKS_PER_QUARTER, section: 0, pinned: false, match: 1 },
    ],
    sections: [{ label: '', first: 0, last: 1, confidence: 1, jumped: false }],
    shift: 0,
    factor: 1,
    tracks: [0],
    missing: [],
    tempoLocked: 0,
  }
  assert.equal(barAt(sync, 999), -1)
  assert.equal(barAt(sync, 1000), 0)
  assert.equal(barAt(sync, 3199), 0)
  assert.equal(barAt(sync, 3200), 1)
  assert.equal(barAt(sync, 5200), -1)
  // the third beat of bar 0, and halfway through its last (longer) beat
  assert.equal(tickAt(sync.bars[0], 2000), 2 * TICKS_PER_QUARTER)
  assert.equal(tickAt(sync.bars[0], 2900), 3.5 * TICKS_PER_QUARTER)
  for (const tick of [0, 480, 1000, 2000, 3500]) assert.ok(Math.abs(tickAt(sync.bars[1], sampleAt(sync.bars[1], tick)) - tick) < 2)
  assert.equal(sampleAt(sync.bars[1], 4 * TICKS_PER_QUARTER), 5200)
})

test('the busiest guitar track is shown first', () => {
  const beat = (n: number) => ({ start: 0, duration: 960, notes: Array.from({ length: n }, (_, k) => ({ string: k + 1, fret: 0, midi: 40 + k, tie: false, dead: false })) })
  const track = (name: string, strings: number, notes: number, percussion = false) => ({ name, tuning: Array(strings).fill(40), capo: 0, percussion, bars: [[beat(notes)]] })
  const score: TabScore = { title: '', artist: '', tempo: 120, bars: [bar()], tracks: [track('Clean', 6, 1), track('Bass', 4, 9), track('Drums', 0, 0, true), track('Rhythm', 6, 5)] }
  assert.equal(mainTrack(score), 3)
})

test('a bar the tracker put half a beat late is moved back onto the tab tempo', () => {
  const chords = [...VERSE, ...CHORUS, ...VERSE, ...CHORUS, ...VERSE]
  const tab = makeTab([{ name: 'Song', bars: chords }])
  const { beats, audio } = recording(chords)
  // the tracker sat on the off-beats through bar 10 (beats 36–39)
  const tracked = beats.map((b, i) => (i >= 36 && i < 40 ? b + 250 : b))
  const off = syncTab(tab, { beats: tracked, sampleRate: SR, audio, tempoLock: false })
  const on = syncTab(tab, { beats: tracked, sampleRate: SR, audio })
  const bar9 = (s: TabSync) => s.bars.find((b) => b.played === 9)!
  assert.equal(bar9(off).start, beats[36] + 250)
  assert.ok(Math.abs(bar9(on).start - beats[36]) <= 2, `moved to ${bar9(on).start}, true start ${beats[36]}`)
  assert.equal(on.tempoLocked, 1)
  // its beats are even again, and the bar before ends where it starts
  assert.deepEqual(bar9(on).beats.map((b) => Math.round((b - beats[36]) / 500)), [0, 1, 2, 3])
  assert.equal(on.bars.find((b) => b.played === 8)!.end, bar9(on).start)
})

test('a freely played recording is left on its beats', () => {
  const chords = [...VERSE, ...CHORUS, ...VERSE, ...CHORUS, ...VERSE]
  const tab = makeTab([{ name: 'Song', bars: chords }])
  const { beats, audio } = recording(chords)
  // rubato: the tempo swells and relaxes by ±10% every eight bars
  let t = beats[0]
  const free = beats.map((_, i) => {
    const at = t
    t += 500 * (1 + 0.1 * Math.sin((2 * Math.PI * i) / 32))
    return Math.round(at)
  })
  const sync = syncTab(tab, { beats: free, sampleRate: SR, audio })
  assert.equal(sync.tempoLocked, 0)
  assert.deepEqual(
    sync.bars.map((b) => free.indexOf(b.start)),
    Array.from({ length: 20 }, (_, p) => 4 * p),
  )
})

test('tempo changes inside a bar are kept and timed', () => {
  const score = alphaTab.importer.ScoreLoader.loadAlphaTex(`\\tempo 120 . :4 0.6 0.6 0.6 0.6 | :4 0.6 0.6 0.6 0.6 | :4 0.6 0.6 0.6 0.6`, new alphaTab.Settings())
  // halfway through bar 2, 60 BPM; it stays for bar 3
  const auto = new alphaTab.model.Automation()
  auto.type = alphaTab.model.AutomationType.Tempo
  auto.value = 60
  auto.ratioPosition = 0.5
  score.masterBars[1].tempoAutomations.push(auto)
  const tab = loadTab(new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings()))
  assert.deepEqual(
    tab.bars.map((b) => [b.tempo, b.tempoChanges?.map((c) => [c.at, c.bpm]) ?? []]),
    [
      [120, []],
      [120, [[0.5, 60]]],
      [60, []],
    ],
  )
  assert.equal(barSeconds(tab.bars[0]), 2)
  assert.equal(barSeconds(tab.bars[1]), 1 + 2)
  assert.equal(barSeconds(tab.bars[1], 2 * TICKS_PER_QUARTER), 1)
  assert.equal(barSeconds(tab.bars[2]), 4)
})

/**
 * The same recording with the tracker lost from beat `from` to beat `to`: beats every `spacing` ms
 * there instead, each with the harmony of the music at its time.
 */
function lose(rec: { beats: number[]; audio: AudioBeats }, from: number, to: number, spacing: number) {
  const { beats, audio } = rec
  const lost: number[] = []
  for (let t = beats[from]; t < beats[to]; t += spacing) lost.push(Math.round(t))
  const all = [...beats.slice(0, from), ...lost, ...beats.slice(to)]
  const src = all.map((t) => {
    let k = 0
    while (k + 1 < beats.length && beats[k + 1] <= t) k++
    return k
  })
  return {
    beats: all,
    audio: { chroma: src.map((k) => audio.chroma[k]), level: new Float32Array(all.length).fill(0.5), bass: src.map((k) => audio.bass[k]), downbeats: [] as number[] },
  }
}

test('bars where the tracker lost the pulse are rebuilt on the tempo of the bars around them', () => {
  const chords = [...VERSE, ...CHORUS, ...BRIDGE, ...VERSE, ...CHORUS, ...VERSE]
  const tab = makeTab([{ name: 'Song', bars: chords }])
  const rec = recording(chords)
  // bars 9–12 (beats 32–47): beats every 170 ms, nothing like the 500 ms pulse
  const { beats, audio } = lose(rec, 32, 48, 170)
  const sync = syncTab(tab, { beats, sampleRate: SR, audio })
  for (let p = 8; p < 12; p++) {
    const b = sync.bars.find((x) => x.played === p)!
    assert.ok(Math.abs(b.start - rec.beats[4 * p]) <= 2, `bar ${p + 1} at ${b.start}, true ${rec.beats[4 * p]}`)
  }
  assert.ok(sync.tempoLocked >= 4)
})

test('a lost start is put on the tempo, an intro the tab lacks is not', () => {
  const chords = [...VERSE, ...CHORUS, ...VERSE, ...CHORUS, ...VERSE, ...CHORUS]
  const tab = makeTab([{ name: 'Song', bars: chords }])
  // the tracker lost the first three bars
  const rec = recording(chords)
  const lost = lose(rec, 0, 12, 170)
  const sync = syncTab(tab, { beats: lost.beats, sampleRate: SR, audio: lost.audio })
  for (let p = 0; p < 3; p++) assert.ok(Math.abs(sync.bars.find((x) => x.played === p)!.start - rec.beats[4 * p]) <= 2, `bar ${p + 1}`)
  // an intro of other chords before the same song, also with the tracker lost: the tab still starts after it
  const intro = recording([...BRIDGE, ...chords])
  const lostIntro = lose(intro, 0, 16, 170)
  const sync2 = syncTab(tab, { beats: lostIntro.beats, sampleRate: SR, audio: lostIntro.audio })
  const first = sync2.bars.find((x) => x.played === 0)!
  assert.ok(first.start >= intro.beats[16] - 2, `bar 1 at ${first.start}, the intro ends at ${intro.beats[16]}`)
})
