/**
 * Tab sync on a real Guitar Pro tab of a song recorded to a click:
 *
 *   node scripts/tab-eval/real.ts <eval dir> <song> <tab file>
 *
 * The truth comes from the tab itself: its tempo map turns every bar into seconds, and the tab's drum
 * hits, matched to the onsets of the drum stem (<eval dir>/stems/<song>/drums.wav), give the offset
 * to the recording (for a tab without drums: all its notes against the guitar and bass stems). The
 * offset is found section by section, then bar by bar within ±100 ms of its section's; sections that
 * don't match clearly, and bars with too few hits near them, get no truth and aren't scored. SUMMARY=
 * <file> appends one JSON line per audio source.
 * Then the tab is synced as the app does it (beats from <song>.beats.json, harmony from the mix or the
 * guitar and bass stems) and every bar start is compared with the truth.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import * as alphaTab from '@coderline/alphatab'
import { beatHarmony } from '../../src/analysis/chordTimeline.ts'
import { fromAlphaTab } from '../../src/tabs/alphatab.ts'
import { expandBars } from '../../src/tabs/expand.ts'
import { barSeconds } from '../../src/tabs/model.ts'
import { FFT } from '../../src/dsp/fft.ts'
import { regularBeats, syncTab, type TabSync } from '../../src/tabs/sync.ts'
import { tabSeconds } from '../../src/tabs/tempo.ts'

const SR = 44100
const HOP = 441 // 10 ms onset frames
const [dir, song, tabFile] = process.argv.slice(2)

const decode = (file: string) => {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(f * a.length))]

// ---- the tab, in seconds of its own tempo map ----
const atScore = alphaTab.importer.ScoreLoader.loadScoreFromBytes(new Uint8Array(fs.readFileSync(tabFile)), new alphaTab.Settings())
const score = fromAlphaTab(atScore)
const played = expandBars(score.bars)
const barSec = tabSeconds(score, played)
const tabEnd = barSec[barSec.length - 1] + barSeconds(score.bars[played[played.length - 1].bar])

// What the truth is made of: the tab's drum hits against the drum stem, or, for a tab without drums,
// all its struck notes against the guitar and bass stems. Neither is used by the sync.
const drumTrack = score.tracks.findIndex((t) => t.percussion)
const truthTracks = drumTrack >= 0 ? [drumTrack] : score.tracks.flatMap((t, i) => (t.percussion ? [] : [i]))
const truthStems = drumTrack >= 0 ? ['drums'] : ['guitar', 'bass']
/** Struck notes (tab seconds), with the played bar they are in. */
const hits: { t: number; bar: number }[] = []
played.forEach((p, k) => {
  const at = new Set<number>()
  for (const ti of truthTracks) for (const b of score.tracks[ti].bars[p.bar]) if (drumTrack >= 0 || b.notes.some((n) => !n.tie)) at.add(b.start)
  for (const tick of at) hits.push({ t: barSec[k] + barSeconds(score.bars[p.bar], tick), bar: k })
})

// ---- onsets of those stems: positive spectral flux, minus its local mean, lightly smoothed ----
function onsetsOf(mono: Float32Array): Float32Array {
  const N = 1024
  const fft = new FFT(N)
  const frames = Math.floor(mono.length / HOP)
  const re = new Float64Array(N)
  const im = new Float64Array(N)
  const win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
  let prev = new Float64Array(N / 2)
  let cur = new Float64Array(N / 2)
  const flux = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < N; i++) {
      re[i] = (mono[f * HOP - N / 2 + i] ?? 0) * win[i]
      im[i] = 0
    }
    fft.transform(re, im, false)
    let sum = 0
    for (let k = 1; k < N / 2; k++) {
      cur[k] = Math.log(1 + 100 * Math.hypot(re[k], im[k]))
      if (f) sum += Math.max(0, cur[k] - prev[k])
    }
    flux[f] = sum
    ;[prev, cur] = [cur, prev]
  }
  const env = new Float32Array(frames)
  for (let f = 0; f < frames; f++) {
    let m = 0
    let n = 0
    for (let d = -25; d <= 25; d++) if (f + d >= 0 && f + d < frames) (m += flux[f + d]), n++
    env[f] = Math.max(0, flux[f] - m / n)
  }
  // light smoothing only: the truth needs the onsets where they are
  return env.map((v, f) => 0.5 * (env[f - 1] ?? 0) + v + 0.5 * (env[f + 1] ?? 0))
}
const stemMono = (() => {
  const parts = truthStems.map((n) => decode(path.join(dir, 'stems', song, `${n}.wav`)))
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)))
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]
  return out
})()
const audioEnd = stemMono.length / SR
const env = onsetsOf(stemMono)

/** How well hits line up with the onsets at offset `lag` (s): mean onset strength at the hits. */
const fit = (hs: typeof hits, lag: number) => {
  let s = 0
  for (const h of hs) s += env[Math.round(((h.t + lag) * SR) / HOP)] ?? 0
  return s / Math.max(1, hs.length)
}
const best = (hs: typeof hits, from: number, to: number, step: number) => {
  let lag = from
  let v = -1
  for (let l = from; l <= to; l += step) {
    const f = fit(hs, l)
    if (f > v) [lag, v] = [l, f]
  }
  return lag
}

// Offsets section by section. Drum grooves repeat every bar, so a section on its own fits nearly as
// well a bar early or late; the whole tab at once doesn't. So: the song's offset first, then for each
// section the offset of the section before if it still fits, else the strong peak (within 80% of its
// best) nearest to it: the sections stay together unless the recording really adds or leaves out
// something there. A section counts when its peak is sharp (three times the fit 50 ms either side).
const runs: { label: string; bars: number[] }[] = []
played.forEach((p, k) => (k > 0 && p.section === played[k - 1].section ? runs[runs.length - 1].bars.push(k) : runs.push({ label: p.section, bars: [k] })))
const extra = Math.max(0, audioEnd - tabEnd)
const songLag = best(hits, -10, extra + 10, 0.01)
console.log(`song offset ${songLag.toFixed(2)} s (fit ${fit(hits, songLag).toFixed(2)}, ${fit(hits, songLag + 0.05).toFixed(2)} 50 ms off); the recording is ${extra.toFixed(1)} s longer than the tab`)
let prevLag = songLag
const sectionLag: (number | null)[] = []
for (const r of runs) {
  const hs = hits.filter((h) => r.bars.includes(h.bar))
  if (hs.length < 8) {
    sectionLag.push(null)
    continue
  }
  const from = Math.min(prevLag, songLag) - 2
  const to = Math.max(prevLag, songLag) + extra + 2
  const curve: number[] = []
  for (let l = from; l <= to; l += 0.01) curve.push(fit(hs, l))
  const top = Math.max(...curve)
  // keep the offset of the section before when it still fits (a sharp peak with half the best fit);
  // otherwise the strong peak nearest to it
  const sharpAt = (l: number) => fit(hs, l) / Math.max(1e-6, (fit(hs, l - 0.05) + fit(hs, l + 0.05)) / 2)
  const stay = best(hs, prevLag - 0.15, prevLag + 0.15, 0.001)
  let lag: number
  if (fit(hs, stay) >= 0.5 * top && sharpAt(stay) > 2) lag = stay
  else {
    let pick = -1
    curve.forEach((v, i) => {
      const peak = v >= 0.8 * top && v >= (curve[i - 1] ?? 0) && v >= (curve[i + 1] ?? 0)
      if (peak && (pick < 0 || Math.abs(from + i * 0.01 - prevLag) < Math.abs(from + pick * 0.01 - prevLag))) pick = i
    })
    const coarse = from + pick * 0.01
    lag = best(hs, coarse - 0.015, coarse + 0.015, 0.001)
  }
  const here = fit(hs, lag)
  const sharp = here / Math.max(1e-6, (fit(hs, lag - 0.05) + fit(hs, lag + 0.05)) / 2)
  // drum patterns that repeat every eighth (blast beats) give weak peaks: those sections aren't trusted
  const ok = sharp > 3
  const jump = lag - prevLag
  console.log(
    `  ${(r.label || '(start)').padEnd(14)} bars ${played[r.bars[0]].bar + 1}–${played[r.bars[r.bars.length - 1]].bar + 1}: ${String(hs.length).padStart(4)} hits, offset ${lag.toFixed(3)} s${Math.abs(jump) > 0.3 ? ` (moves ${jump.toFixed(2)} s: the recording ${jump > 0 ? 'adds' : 'leaves out'} something before it)` : ''}, peak ${sharp.toFixed(1)}× its ±50 ms${ok ? '' : ' — not trusted'}`,
  )
  sectionLag.push(ok ? lag : null)
  if (ok) prevLag = lag
}
// per bar: the offset of the hits within four bars of it in its section, near the section's offset
const barLag: (number | null)[] = played.map(() => null)
runs.forEach((r, ri) => {
  const lag = sectionLag[ri]
  if (lag === null) return
  for (const k of r.bars) {
    const hs = hits.filter((h) => Math.abs(h.bar - k) <= 4 && r.bars.includes(h.bar))
    barLag[k] = hs.length >= 12 ? best(hs, lag - 0.1, lag + 0.1, 0.001) : null
  }
})
const truth = barSec.map((t, k) => t + (barLag[k] ?? 0))
const drumless = new Set(barLag.flatMap((l, k) => (l === null ? [k] : [])))
console.log(`truth from ${truthStems.join(' + ')} onsets: ${played.length - drumless.size} of ${played.length} bars (the rest have too few ${drumTrack >= 0 ? 'drum hits' : 'notes'} near them or are in sections that didn't match clearly)`)
// TRUTH_OUT=<file>: the truth for other checks (seconds per played bar; null where there is none)
if (process.env.TRUTH_OUT) fs.writeFileSync(process.env.TRUTH_OUT, JSON.stringify(truth.map((t, k) => (drumless.has(k) ? null : t))))

// ---- the sync, as the app runs it ----
const { beats: bs, downbeats: ds } = JSON.parse(fs.readFileSync(path.join(dir, `${song}.beats.json`), 'utf8')) as { beats: number[]; downbeats: number[] }
const grid = regularBeats(
  bs.map((t) => Math.round(t * SR)),
  ds.map((t) => bs.reduce((b, x, i) => (Math.abs(x - t) < Math.abs(bs[b] - t) ? i : b), 0)),
)
// without a truth (the tab's tempo map doesn't follow the recording), only the sync is shown
const noTruth = drumless.size === played.length
if (noTruth) console.log('no truth: the tab\'s timing doesn\'t match the recording closely enough to measure against')
// how far the true bar starts are from the nearest tracked beat: the sync can only start bars on beats
if (!noTruth) {
  const near = played.flatMap((_, p) => {
    if (drumless.has(p)) return []
    const t = truth[p] * SR
    return [Math.min(...grid.beats.map((b) => Math.abs(b - t))) / SR * 1000]
  })
  const far = near.filter((d) => d > 60).length
  console.log(`tracked beats vs true bar starts: median ${q(near, 0.5).toFixed(0)} ms, p95 ${q(near, 0.95).toFixed(0)} ms; ${far} of ${near.length} bar starts have no tracked beat within 60 ms`)
}
const spacing = q(grid.beats.slice(1).map((b, i) => b - grid.beats[i]), 0.5) / SR
const src = fs.readFileSync(path.join(dir, `${song}.src`), 'utf8').trim()
const sum = (files: string[]) => {
  const parts = files.map(decode)
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)))
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] += p[i]
  return out
}
const sources: Record<string, () => Float32Array> = {
  mix: () => decode(src),
  stems: () => sum(['guitar', 'bass'].map((s) => path.join(dir, 'stems', song, `${s}.wav`))),
}
// bars on tracked beats only, and with the tempo lock (bars off the tab's tempo line moved onto it);
// neither uses the drums, so the drum-based truth stays independent
const trackSets: Record<string, string> = { 'beats only': 'none', 'tempo lock': 'lock' }
for (const [name, mono] of Object.entries(sources)) {
  const audio = mono()
  const h = beatHarmony(audio, SR, grid.beats)
  for (const [tracksName, mode] of Object.entries(trackSets)) {
    const t0 = performance.now()
    const tempoLock = mode !== 'none'
    const sync: TabSync = syncTab(score, { beats: grid.beats, sampleRate: SR, audio: { chroma: h.chroma, level: h.level, bass: h.bass, downbeats: grid.downbeats }, tempoLock })
    const ms = performance.now() - t0
    const err: number[] = []
    let unplaced = 0
    played.forEach((_, p) => {
      if (drumless.has(p)) return
      const at = sync.bars.filter((b) => b.played === p)
      if (!at.length) return void unplaced++
      err.push(Math.min(...at.map((b) => Math.abs(b.start / SR - truth[p]))) * 1000)
    })
    const drumlessPlaced = [...drumless].filter((p) => sync.bars.some((b) => b.played === p)).length
    const scored = played.length - drumless.size
    const within = err.filter((e) => e < (spacing * 1000) / 2).length
    if (noTruth) {
      console.log(`${name.padEnd(6)} ${tracksName}: ${sync.bars.length} bars placed, ${sync.missing.length} of ${played.length} not played; shift ${sync.shift} ×${sync.factor}; ${sync.tempoLocked} bars moved by the tempo lock`)
      sync.sections.forEach((s) => {
        const bars = sync.bars.slice(s.first, s.last + 1)
        console.log(`   ${s.label.padEnd(8)} bars ${played[bars[0].played].bar + 1}–${played[bars[bars.length - 1].played].bar + 1} at ${(bars[0].start / SR).toFixed(1)} s, conf ${s.confidence.toFixed(2)}${s.jumped ? ' jumped' : ''}`)
      })
      continue
    }
    const f = (v: number) => `${v.toFixed(0)} ms / ${(v / 1000 / spacing).toFixed(2)} beats`
    if (process.env.SUMMARY)
      fs.appendFileSync(
        process.env.SUMMARY,
        JSON.stringify({ song, source: name, mode, scored, median: q(err, 0.5), p95: q(err, 0.95), max: Math.max(...err), within: within / scored, unplaced, beat: spacing, moved: sync.tempoLocked, seconds: ms / 1000 }) + '\n',
      )
    console.log(
      `${name.padEnd(6)} ${tracksName}: bar start error median ${f(q(err, 0.5))}, p95 ${f(q(err, 0.95))}, max ${f(Math.max(...err))}; within ½ beat ${((100 * within) / scored).toFixed(1)}%; unplaced ${unplaced}/${scored} (bars with drums; of the ${drumless.size} without, ${drumlessPlaced} placed); shift ${sync.shift} ×${sync.factor}; ${sync.tempoLocked} bars moved by the tempo lock; ${ms.toFixed(0)} ms`,
    )
    if (process.env.BARS)
      played.forEach((pb, p) => {
        const at = sync.bars.filter((b) => b.played === p)
        if (!at.length || drumless.has(p)) return
        const e = Math.min(...at.map((b) => b.start / SR - truth[p]), Infinity)
        const bar = score.bars[pb.bar]
        if (Math.abs(e) > spacing / 2) console.log(`   bar ${pb.bar + 1} (${bar.num}/${bar.den}, ${pb.section}): ${(e * 1000).toFixed(0)} ms`)
      })
    if (process.env.VERBOSE)
      sync.sections.forEach((s) => {
        const bars = sync.bars.slice(s.first, s.last + 1)
        const e = bars.filter((b) => !drumless.has(b.played)).map((b) => (b.start / SR - truth[b.played]) * 1000)
        console.log(`   ${s.label.padEnd(8)} bars ${bars[0].played + 1}–${bars[bars.length - 1].played + 1} at ${(bars[0].start / SR).toFixed(1)} s, conf ${s.confidence.toFixed(2)}${s.jumped ? ' jumped' : ''}, ${e.length ? `error ${q(e, 0.5).toFixed(0)} ms median` : 'no truth'}`)
      })
  }
}
