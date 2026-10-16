/**
 * Tab sync on a real Guitar Pro tab of a song recorded to a click:
 *
 *   node scripts/tab-eval/real.ts <eval dir> <song> <tab file>
 *
 * The truth comes from the tab itself: its tempo map turns every bar into seconds, and the tab's drum
 * hits, matched to the onsets of the drum stem (<eval dir>/stems/<song>/drums.wav), give the offset
 * to the recording. The offset is found for the whole song and again for each section; if they disagree
 * by more than a few tens of ms the band didn't follow the tab's tempo and the truth isn't trusted.
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
import { TICKS_PER_QUARTER } from '../../src/tabs/model.ts'
import { regularBeats, syncTab, type TabSync } from '../../src/tabs/sync.ts'

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
/** Seconds of tab time at the start of each played bar, and seconds per tick in it. */
const barSec: number[] = []
const secPerTick: number[] = []
{
  let t = 0
  let tempo = atScore.tempo
  for (const p of played) {
    const mb = atScore.masterBars[p.bar]
    // tempo changes inside a bar apply from their position; here the start of the bar is enough
    const change = mb.tempoAutomations.find((a) => a.ratioPosition === 0)
    if (change) tempo = change.value
    barSec.push(t)
    secPerTick.push(60 / (tempo * TICKS_PER_QUARTER))
    t += score.bars[p.bar].ticks * secPerTick[secPerTick.length - 1]
    if (mb.tempoAutomations.some((a) => a.ratioPosition > 0)) console.warn(`bar ${p.bar + 1}: tempo change inside the bar ignored`)
  }
}
const drumTrack = score.tracks.findIndex((t) => t.percussion)
if (drumTrack < 0) throw new Error('the tab has no drum track to find the offset with')
/** Tab drum hits (tab seconds), with the section run they are in. */
const hits: { t: number; section: string }[] = []
played.forEach((p, k) => {
  for (const b of score.tracks[drumTrack].bars[p.bar]) hits.push({ t: barSec[k] + b.start * secPerTick[k], section: p.section })
})

// ---- onsets of the drum stem: rectified rise of log energy, 10 ms frames, lightly smoothed ----
const drums = decode(path.join(dir, 'stems', song, 'drums.wav'))
const frames = Math.floor(drums.length / HOP)
const logE = new Float32Array(frames)
for (let f = 0; f < frames; f++) {
  let e = 0
  for (let i = f * HOP; i < (f + 1) * HOP; i++) e += drums[i] * drums[i]
  logE[f] = Math.log(1e-9 + e)
}
const onset = new Float32Array(frames)
for (let f = 1; f < frames; f++) onset[f] = Math.max(0, logE[f] - logE[f - 1])
const smooth = onset.map((_, f) => (onset[f - 1] ?? 0) * 0.5 + onset[f] + (onset[f + 1] ?? 0) * 0.5)

/** How well the hits line up with the onsets at offset `lag` (s): mean onset strength at the hits. */
const fit = (hs: typeof hits, lag: number) => {
  let s = 0
  for (const h of hs) s += smooth[Math.round(((h.t + lag) * SR) / HOP)] ?? 0
  return s / Math.max(1, hs.length)
}
const best = (hs: typeof hits, from: number, to: number, step: number) => {
  let lag = from
  for (let l = from; l <= to; l += step) if (fit(hs, l) > fit(hs, lag)) lag = l
  return lag
}
const coarse = best(hits, -20, 20, 0.01)
const offset = best(hits, coarse - 0.02, coarse + 0.02, 0.001)
console.log(`offset: tab time + ${offset.toFixed(3)} s = recording time (${hits.length} drum hits; fit ${fit(hits, offset).toFixed(2)} vs ${fit(hits, offset + 0.05).toFixed(2)} 50 ms off)`)
const sections = [...new Set(played.map((p) => p.section))]
const local: number[] = []
for (const s of sections) {
  const hs = hits.filter((h) => h.section === s)
  if (hs.length < 8) continue
  const l = best(hs, offset - 0.15, offset + 0.15, 0.001)
  local.push(l - offset)
  console.log(`  ${(s || '(start)').padEnd(10)} ${String(hs.length).padStart(4)} hits, offset ${((l - offset) * 1000).toFixed(0).padStart(4)} ms from the song's`)
}
const spread = (Math.max(...local) - Math.min(...local)) * 1000
console.log(`section offsets spread over ${spread.toFixed(0)} ms${spread > 40 ? ' (the tab is a note longer or shorter than the recording somewhere: bars use their local offset below)' : ''}`)
// per bar: the offset of the drum hits within four bars of it (the tab may be a note longer or shorter
// than the recording somewhere); bars without drums near them take the nearest bar's
const hitBar: number[] = []
played.forEach((p, k) => {
  for (const _ of score.tracks[drumTrack].bars[p.bar]) hitBar.push(k)
})
const barLag: (number | null)[] = played.map((_, k) => {
  const hs = hits.filter((_, i) => Math.abs(hitBar[i] - k) <= 4)
  return hs.length >= 12 ? best(hs, offset - 0.1, offset + 0.1, 0.001) : null
})
const filled = barLag.map((l, k) => {
  if (l !== null) return l
  for (let d = 1; d < played.length; d++) {
    const a = barLag[k - d] ?? null
    const b = barLag[k + d] ?? null
    if (a !== null || b !== null) return (b ?? a)!
  }
  return offset
})
const changes = filled.flatMap((l, k) => (k > 0 && Math.abs(l - filled[k - 1]) > 0.03 ? [`bar ${played[k].bar + 1}: ${((l - filled[k - 1]) * 1000).toFixed(0)} ms`] : []))
console.log(`tab vs recording slips: ${changes.join(', ') || 'none'}; ${barLag.filter((l) => l === null).length} bars without drums nearby`)
const truth = barSec.map((t, k) => t + filled[k])
const drumless = new Set(barLag.flatMap((l, k) => (l === null ? [k] : [])))
// TRUTH_OUT=<file>: the truth for other checks (seconds per played bar; null where there are no drums near)
if (process.env.TRUTH_OUT) fs.writeFileSync(process.env.TRUTH_OUT, JSON.stringify(truth.map((t, k) => (drumless.has(k) ? null : t))))

// ---- the sync, as the app runs it ----
const { beats: bs, downbeats: ds } = JSON.parse(fs.readFileSync(path.join(dir, `${song}.beats.json`), 'utf8')) as { beats: number[]; downbeats: number[] }
const grid = regularBeats(
  bs.map((t) => Math.round(t * SR)),
  ds.map((t) => bs.reduce((b, x, i) => (Math.abs(x - t) < Math.abs(bs[b] - t) ? i : b), 0)),
)
// how far the true bar starts are from the nearest tracked beat: the sync can only start bars on beats
{
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
const trackSets: Record<string, boolean> = { 'beats only': false, 'tempo lock': true }
for (const [name, mono] of Object.entries(sources)) {
  const audio = mono()
  const h = beatHarmony(audio, SR, grid.beats)
  for (const [tracksName, tempoLock] of Object.entries(trackSets)) {
    const t0 = performance.now()
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
    const f = (v: number) => `${v.toFixed(0)} ms / ${(v / 1000 / spacing).toFixed(2)} beats`
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
        const e = bars.map((b) => (b.start / SR - truth[b.played]) * 1000)
        console.log(`   ${s.label.padEnd(8)} bars ${bars[0].played + 1}–${bars[bars.length - 1].played + 1} at ${(bars[0].start / SR).toFixed(1)} s, conf ${s.confidence.toFixed(2)}${s.jumped ? ' jumped' : ''}, error ${q(e, 0.5).toFixed(0)} ms median`)
      })
  }
}
