import type { PlayedBar } from './expand.ts'
import { TICKS_PER_QUARTER, type TabScore } from './model.ts'
import type { TabSync } from './sync.ts'

/**
 * Many recordings are played to a click, and a tab transcribed from them follows the same tempo. Then,
 * within a stretch of bars played in order, recording time is a straight line of tab time, and a bar
 * that lands off that line was put on a wrong beat (the beat tracker sits on the off-beats for a few
 * beats in busy, syncopated riffs). Each bar is checked against a line fitted through its neighbours
 * (itself left out): where the neighbours fit tightly and the bar is more than OUTLIER beats off, it is
 * moved onto the line. Where the recording doesn't keep the tab's tempo, the neighbours don't fit
 * tightly and nothing moves.
 */

/** Bars on each side used for the line. */
const WINDOW = 8
/** Neighbours must sit within this many beats of their line (median distance). */
const TIGHT = 0.08
/** A bar further than this many beats from the line is moved onto it. */
const OUTLIER = 0.25

/** Seconds of tab time at the start of each played bar, from the tab's tempo map. */
export function tabSeconds(score: TabScore, played: PlayedBar[]): number[] {
  const out: number[] = []
  let t = 0
  for (const p of played) {
    out.push(t)
    const bar = score.bars[p.bar]
    t += (bar.ticks / TICKS_PER_QUARTER) * (60 / bar.tempo)
  }
  return out
}

const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}

/** Theil–Sen line y = a + b·x: robust to a few points off it. */
function robustLine(x: number[], y: number[]): { a: number; b: number } {
  const slopes: number[] = []
  for (let i = 0; i < x.length; i++) for (let j = i + 1; j < x.length; j++) if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]))
  const b = slopes.length ? median(slopes) : 1
  return { a: median(y.map((v, i) => v - b * x[i])), b }
}

/** Moves bars that are off the tempo line onto it (in place). Returns how many moved. */
export function lockToTempo(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number): number {
  const bars = sync.bars
  const tab = tabSeconds(score, played)
  // runs of bars played in order without gaps
  const runOf = new Int32Array(bars.length)
  for (let i = 1; i < bars.length; i++) {
    const follows = bars[i].played === bars[i - 1].played + 1 && bars[i].start - bars[i - 1].end < 1
    runOf[i] = follows ? runOf[i - 1] : runOf[i - 1] + 1
  }
  const x = bars.map((b) => tab[b.played])
  const y = bars.map((b) => b.start / sampleRate)
  const target = new Map<number, number>()
  bars.forEach((b, i) => {
    if (b.pinned) return
    const near: number[] = []
    for (let k = Math.max(0, i - WINDOW); k <= Math.min(bars.length - 1, i + WINDOW); k++) if (k !== i && runOf[k] === runOf[i]) near.push(k)
    if (near.length < 6) return
    const { a, b: slope } = robustLine(
      near.map((k) => x[k]),
      near.map((k) => y[k]),
    )
    // the recording's tempo may differ a little from the tab's, not by much
    if (slope < 0.8 || slope > 1.25) return
    const beat = (60 / score.bars[played[b.played].bar].tempo) * slope
    const spread = median(near.map((k) => Math.abs(y[k] - (a + slope * x[k]))))
    const off = y[i] - (a + slope * x[i])
    if (spread < TIGHT * beat && Math.abs(off) > OUTLIER * beat) target.set(i, Math.round((a + slope * x[i]) * sampleRate))
  })
  // new starts first, then ends and beats: a bar ends where the next one in its run starts
  for (const [i, start] of target) bars[i].start = start
  const touched = new Set<number>()
  for (const i of target.keys()) {
    touched.add(i)
    if (i > 0 && runOf[i - 1] === runOf[i]) touched.add(i - 1)
  }
  for (const i of touched) {
    const b = bars[i]
    if (bars[i + 1] && runOf[i + 1] === runOf[i]) b.end = bars[i + 1].start
    b.end = Math.max(b.start + 1, b.end)
    // with the tempo steady, the bar's beats are even
    const n = b.beats.length
    b.beats = b.beats.map((_, j) => Math.round(b.start + (j / n) * (b.end - b.start)))
  }
  return target.size
}
