/**
 * Tab sync evaluation: aligns test tabs (make-tabs.ts) to their recordings and measures where each bar
 * starts against where it really starts.
 *
 *   node scripts/tab-eval/eval.ts <eval dir> <tabs dir> [variant…]
 *
 * <eval dir> is the chord evaluation's (beats, audio, stems, notes; see scripts/chord-eval/README.md);
 * <tabs dir>/out holds <song>.<variant>.gp and .truth.json. SOURCES=mix,stems,… picks the audio features;
 * PARAMS='{"jump":3}' overrides alignment parameters (src/tabs/align.ts).
 *
 * The truth is on the tracked beats, so errors measure picking the right beat. To see how the sync copes
 * with a worse beat grid, BEAT_DROP=0.1 removes that share of the tracked beats and BEAT_JITTER=30 moves
 * the rest by up to ±30 ms before syncing; errors are still measured against the original beats.
 * BEAT_HALF=1 / BEAT_DOUBLE=1 give the sync every other beat / twice the beats (a tracker counting at
 * half or double speed).
 * ANCHOR=1 places the tab's first bar that the recording plays by hand (as a user would by dragging it).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { analyzeChords, beatHarmony, type ChordNote, type Slots } from '../../src/analysis/chordTimeline.ts'
import { loadTab } from '../../src/tabs/alphatab.ts'
import type { AudioBeats } from '../../src/tabs/align.ts'
import { QUALITIES } from '../../src/analysis/notes.ts'
import type { ChordSegment } from '../../src/analysis/chordTimeline.ts'
import { barAt, regularBeats, syncTab, type TabSync } from '../../src/tabs/sync.ts'
import { expandBars } from '../../src/tabs/expand.ts'
import type { TabScore } from '../../src/tabs/model.ts'

// the app analyses at the file's own rate; SR=48000 checks another
const SR = Number(process.env.SR ?? 44100)
const [evalDir, tabsDir] = process.argv.slice(2, 4)
const onlyVariants = process.argv.slice(4)
const outDir = path.join(tabsDir, 'out')

const decode = (file: string) => {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}
const sum = (parts: Float32Array[]) => {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)))
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]
  return out
}
function notesFor(song: string, sources: string[]): ChordNote[] {
  return sources
    .map((s) => path.join(evalDir, 'notes', `${song}.${s}.json`))
    .filter((f) => fs.existsSync(f))
    .flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as ChordNote[])
    .map((n) => ({ ...n, start: Math.round(n.start * SR), end: Math.round(n.end * SR) }))
    .sort((a, b) => a.start - b.start)
}

/**
 * The recording's harmony per beat, optionally mixed with the chord chart's tones at `chartWeight`. The
 * app uses the stems' (or the mix's) harmony alone: the chart and the notes didn't improve the sync.
 */
function audioBeats(h: Slots, downbeats: number[], chart?: { chroma: Float32Array[]; bass: (number | null)[] }, chartWeight = 0.3): AudioBeats {
  if (!chart) return { chroma: h.chroma, level: h.level, bass: h.bass, downbeats }
  const w = Math.min(1, chartWeight)
  const chroma = h.chroma.map((c, k) => {
    const t = chart.chroma[k]
    if (!t.some((v) => v > 0)) return c
    return c.map((v, i) => (1 - w) * v + w * t[i])
  })
  return { chroma, level: h.level, bass: h.bass.map((b, k) => (w >= 1 ? (chart.bass[k] ?? b) : (b ?? chart.bass[k]))), downbeats }
}

/** The chord chart as harmony per beat: the chord's tones, root doubled. */
function chartChroma(segments: ChordSegment[], beats: number[]): { chroma: Float32Array[]; bass: (number | null)[] } {
  const chroma: Float32Array[] = []
  const bass: (number | null)[] = []
  let s = 0
  beats.forEach((b, k) => {
    const mid = k + 1 < beats.length ? (b + beats[k + 1]) / 2 : b
    while (s + 1 < segments.length && segments[s].end <= mid) s++
    const chord = segments[s] && segments[s].start <= mid && mid < segments[s].end ? segments[s].chord : null
    const q = chord && QUALITIES.find((q) => q.suffix === chord.suffix)
    const c = new Float32Array(12)
    if (chord && q) {
      for (const t of q.tones) c[(chord.root + t) % 12] += 1
      c[chord.root] += 1
      const sum = c.reduce((a, v) => a + v, 0)
      for (let i = 0; i < 12; i++) c[i] /= sum
    }
    chroma.push(c)
    bass.push(chord ? (chord.bass ?? chord.root) : null)
  })
  return { chroma, bass }
}

/** Fractional beat index of a sample position. */
function beatIndexOf(beats: number[], pos: number): number {
  let i = 0
  while (i + 1 < beats.length && beats[i + 1] <= pos) i++
  const next = i + 1 < beats.length ? beats[i + 1] : beats[i] + (beats[i] - beats[i - 1])
  return i + (pos - beats[i]) / (next - beats[i])
}

interface Result {
  /** Bars where the panel shows the right music (the true bar or one with the same notes) within ½ beat. */
  rightMusic: number
  errMs: number[]
  errBeats: number[]
  unplaced: number
  expected: number
  shift: number
  factor: number
  meanConfOk: number
  meanConfBad: number
  confOk: number[]
  confBad: number[]
}

function score(sync: TabSync, truth: number[][], beats: number[], tab: TabScore): Result {
  // what each played bar sounds like: its notes in every track
  const played = expandBars(tab.bars)
  const content = played.map((p) => JSON.stringify(tab.tracks.map((t) => (t.bars[p.bar] ?? []).map((b) => [b.start, b.duration, b.notes.map((n) => n.midi)]))))
  let rightMusic = 0
  // confidence of what the panel shows at each true bar start, split by whether the music is right
  const confOk: number[] = []
  const confBad: number[] = []
  truth.forEach((ok, p) => {
    if (!ok.length) return
    // a little into the bar's first beat, so a bar starting a few ms late still counts
    const k = ok[0]
    const b = sync.bars[barAt(sync, k + 1 < beats.length ? (beats[k] + beats[k + 1]) / 2 : beats[k] + 1)]
    const right = !!b && content[b.played] === content[p] && Math.abs(beatIndexOf(beats, b.start) - ok[0]) < 0.5
    if (right) rightMusic++
    if (b) (right ? confOk : confBad).push(sync.sections[b.section].confidence)
  })
  const errMs: number[] = []
  const errBeats: number[] = []
  let unplaced = 0
  let expected = 0
  truth.forEach((ok, p) => {
    if (!ok.length) return
    expected++
    const placed = sync.bars.filter((b) => b.played === p)
    if (!placed.length) {
      if (process.env.VERBOSE) console.log(`  unplaced: played bar ${p} (beats ${ok.join('/')})`)
      return void unplaced++
    }
    let best = Infinity
    let bestMs = Infinity
    for (const b of placed)
      for (const k of ok) {
        const e = Math.abs(beatIndexOf(beats, b.start) - k)
        if (e < best) {
          best = e
          bestMs = (Math.abs(b.start - beats[k]) / SR) * 1000
        }
      }
    errBeats.push(best)
    errMs.push(bestMs)
  })
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN)
  return { rightMusic, errMs, errBeats, unplaced, expected, shift: sync.shift, factor: sync.factor, meanConfOk: mean(confOk), meanConfBad: mean(confBad), confOk, confBad }
}

/** Deterministic random numbers, so runs compare. */
function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

const perturbArgs = (beats: number[], downbeats: number[]): [number[], number[]] => {
  const p = perturb(beats, downbeats)
  return [p.beats, p.downbeats]
}

/** The tracked beats made worse as BEAT_DROP / BEAT_JITTER ask; downbeats follow their beats. */
function perturb(beats: number[], downbeats: number[]): { beats: number[]; downbeats: number[] } {
  const drop = Number(process.env.BEAT_DROP ?? 0)
  const jitter = (Number(process.env.BEAT_JITTER ?? 0) / 1000) * SR
  if (process.env.BEAT_HALF) return { beats: beats.filter((_, i) => i % 2 === 0), downbeats: downbeats.filter((d) => d % 2 === 0).map((d) => d / 2) }
  if (process.env.BEAT_DOUBLE)
    return { beats: beats.flatMap((b, i) => (i + 1 < beats.length ? [b, Math.round((b + beats[i + 1]) / 2)] : [b])), downbeats: downbeats.map((d) => 2 * d) }
  if (!drop && !jitter) return { beats, downbeats }
  const r = rng(7)
  const keep = beats.map((_, i) => i === 0 || r() >= drop)
  const index = new Map<number, number>()
  const out: number[] = []
  beats.forEach((b, i) => {
    if (!keep[i]) return
    index.set(i, out.length)
    out.push(Math.round(b + (r() * 2 - 1) * jitter))
  })
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + 1)
  return { beats: out, downbeats: downbeats.filter((d) => index.has(d)).map((d) => index.get(d)!) }
}

const q = (a: number[], f: number) => {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(f * s.length))]
}

const songs = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith('.clean.gp'))
  .map((f) => f.slice(0, -'.clean.gp'.length))
const wanted = (process.env.SOURCES ?? 'mix,stems,stems+notes,stems+notes+chart').split(',')
const rows: { song: string; source: string; variant: string; r: Result }[] = []

for (const song of songs) {
  const { beats: bs, downbeats: ds } = JSON.parse(fs.readFileSync(path.join(evalDir, `${song}.beats.json`), 'utf8')) as { beats: number[]; downbeats: number[] }
  const truthBeats = bs.map((t) => Math.round(t * SR))
  // as the app does: the tracked beats, repaired
  const { beats, downbeats } = regularBeats(...perturbArgs(
    truthBeats,
    ds.map((t) => bs.reduce((best, b, i) => (Math.abs(b - t) < Math.abs(bs[best] - t) ? i : best), 0)),
  ))
  const stemDir = path.join(evalDir, 'stems', song)
  const src = fs.readFileSync(path.join(evalDir, `${song}.src`), 'utf8').trim()

  const harmony: Record<string, () => { h: Slots; mono: Float32Array; notes: ChordNote[] }> = {
    mix: () => {
      const mono = decode(src)
      return { mono, notes: [], h: beatHarmony(mono, SR, beats) }
    },
    stems: () => {
      const mono = sum(['guitar', 'bass'].map((s) => decode(path.join(stemDir, `${s}.wav`))))
      return { mono, notes: [], h: beatHarmony(mono, SR, beats) }
    },
  }
  const cache = new Map<string, ReturnType<(typeof harmony)['mix']>>()
  const get = (k: string) => {
    if (!cache.has(k)) cache.set(k, harmony[k]())
    return cache.get(k)!
  }
  const sources: Record<string, () => AudioBeats> = {
    mix: () => audioBeats(get('mix').h, downbeats),
    stems: () => audioBeats(get('stems').h, downbeats),
    'stems+notes': () => {
      const notes = notesFor(song, ['guitar', 'bass'])
      return audioBeats(beatHarmony(get('stems').mono, SR, beats, { notes }), downbeats)
    },
    'stems+notes+chart': () => {
      const notes = notesFor(song, ['guitar', 'bass'])
      const mono = get('stems').mono
      const segs = analyzeChords(mono, SR, { vocabulary: 'standard', beats, downbeats, notes })
      return audioBeats(beatHarmony(mono, SR, beats, { notes }), downbeats, chartChroma(segs, beats), 0.3)
    },
    chart: () => {
      const notes = notesFor(song, ['guitar', 'bass'])
      const segs = analyzeChords(get('stems').mono, SR, { vocabulary: 'standard', beats, downbeats, notes })
      return audioBeats(get('stems').h, downbeats, chartChroma(segs, beats), 1)
    },
  }

  for (const source of wanted) {
    const audio = sources[source]()
    for (const f of fs.readdirSync(outDir).filter((f) => f.startsWith(`${song}.`) && f.endsWith('.gp'))) {
      const variant = f.slice(song.length + 1, -3)
      if (onlyVariants.length && !onlyVariants.includes(variant)) continue
      const tab = loadTab(new Uint8Array(fs.readFileSync(path.join(outDir, f))))
      const truth = JSON.parse(fs.readFileSync(path.join(outDir, `${song}.${variant}.truth.json`), 'utf8')) as number[][]
      const t0 = performance.now()
      const first = truth.findIndex((ok) => ok.length)
      const anchors = process.env.ANCHOR ? [{ played: first, pos: truthBeats[truth[first][0]] }] : []
      const sync = syncTab(tab, { beats, audio, anchors, params: JSON.parse(process.env.PARAMS ?? '{}') })
      const ms = performance.now() - t0
      const r = score(sync, truth, truthBeats, tab)
      rows.push({ song, source, variant, r })
      const f1 = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '  - ')
      console.log(
        `${song.slice(0, 26).padEnd(27)}${source.padEnd(19)}${variant.padEnd(12)} median ${q(r.errMs, 0.5).toFixed(0).padStart(5)} ms ${f1(q(r.errBeats, 0.5))} b | p95 ${q(r.errMs, 0.95).toFixed(0).padStart(6)} ms ${f1(q(r.errBeats, 0.95)).padStart(6)} b | ≤½ beat ${((100 * r.errBeats.filter((e) => e < 0.5).length) / r.expected).toFixed(1).padStart(5)}% | right music ${((100 * r.rightMusic) / r.expected).toFixed(1).padStart(5)}% | unplaced ${r.unplaced}/${r.expected} | shift ${r.shift} ×${r.factor} | conf ok ${f1(r.meanConfOk)} bad ${f1(r.meanConfBad)} | ${ms.toFixed(0)} ms`,
      )
    }
  }
}

console.log('\nAll songs and variants pooled:')
for (const source of wanted) {
  const rs = rows.filter((r) => r.source === source)
  if (!rs.length) continue
  const ms = rs.flatMap((r) => r.r.errMs)
  const b = rs.flatMap((r) => r.r.errBeats)
  const expected = rs.reduce((a, r) => a + r.r.expected, 0)
  console.log(
    `${source.padEnd(19)} median ${q(ms, 0.5).toFixed(0)} ms / ${q(b, 0.5).toFixed(2)} beats, p95 ${q(ms, 0.95).toFixed(0)} ms / ${q(b, 0.95).toFixed(2)} beats, within ½ beat ${((100 * b.filter((e) => e < 0.5).length) / expected).toFixed(1)}%, right music ${((100 * rs.reduce((a, r) => a + r.r.rightMusic, 0)) / expected).toFixed(1)}%`,
  )
}

// how well the confidence flags misplaced bars: share of bars below each threshold
const ok = rows.flatMap((r) => r.r.confOk)
const bad = rows.flatMap((r) => r.r.confBad)
console.log(`\nConfidence of what the panel shows at each bar (${ok.length} with the right music, ${bad.length} wrong):`)
for (const th of [0.2, 0.3, 0.4, 0.5])
  console.log(`  below ${th}: ${((100 * bad.filter((c) => c < th).length) / Math.max(1, bad.length)).toFixed(0)}% of wrong bars, ${((100 * ok.filter((c) => c < th).length) / ok.length).toFixed(0)}% of right ones`)
