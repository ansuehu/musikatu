import type { PlayedBar } from './expand.ts'
import { barSeconds, TICKS_PER_QUARTER, type TabScore } from './model.ts'
import type { SyncedBar, TabSync } from './sync.ts'

/**
 * Many recordings are played to a click, and a tab transcribed from them follows the same tempo. Then
 * recording time is a straight line of tab time, broken only where the recording adds or leaves out
 * something, and bars off that line were put on wrong beats: the beat tracker sits on the off-beats in
 * busy, syncopated riffs and loses the pulse in blast beats, odd meters and quiet intros. The harmony
 * sync places most bars right; from those, the tempo lock finds the lines and puts the rest on them:
 *
 *   - single bars off the line through their neighbours are moved onto it (moveOutliers);
 *   - stretches between two runs on the same line are rebuilt on it (bridge);
 *   - the bars before the first such run and after the last are put on its line if the harmony fits
 *     there at least as well (extendEnds);
 *   - whole stretches half a beat off, between two runs that agree, are moved back (realignSlips).
 *
 * Where the recording doesn't keep the tab's tempo, no runs lie tightly on a line and nothing moves.
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
    t += barSeconds(score.bars[p.bar])
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

/** What the tempo lock needs from the sync to make bars: units per bar, a bar's harmony match, the end of the song. */
export interface BarMaker {
  unitsOf: (played: number) => { n: number; unitTicks: number }
  matchOf: (played: number, beats: number[]) => number
  /** Last sample of the recording. */
  end: number
}

/** Puts bars onto the tab's tempo lines (in place). Returns how many bars were moved or made. */
export function lockToTempo(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number, maker: BarMaker): number {
  let n = moveOutliers(sync, score, played, sampleRate)
  n += bridge(sync, score, played, sampleRate, maker)
  n += extendEnds(sync, score, played, sampleRate, maker)
  return n + realignSlips(sync, score, played, sampleRate)
}

/** Runs of bars played in order without gaps: run index per bar. */
function runsOf(bars: SyncedBar[]): Int32Array {
  const runOf = new Int32Array(bars.length)
  for (let i = 1; i < bars.length; i++) {
    const follows = bars[i].played === bars[i - 1].played + 1 && bars[i].start - bars[i - 1].end < 1
    runOf[i] = follows ? runOf[i - 1] : runOf[i - 1] + 1
  }
  return runOf
}

/** A beat of written bar `bar` in seconds of tab time, at its average tempo. */
const beatOf = (score: TabScore, bar: number) => barSeconds(score.bars[bar]) / (score.bars[bar].ticks / TICKS_PER_QUARTER)

/** Bars further than OUTLIER beats from the line through their neighbours are moved onto it. */
function moveOutliers(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number): number {
  const bars = sync.bars
  const tab = tabSeconds(score, played)
  const runOf = runsOf(bars)
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
    // this bar's beat, in the recording's time
    const beat = beatOf(score, played[b.played].bar) * slope
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

/** Shortest run of bars that a line can be taken from. */
const FOOTING = 4
/**
 * The far run must start within this many beats of where the near run's line puts it (the line is
 * extrapolated, often over minutes; a part added or left out moves it by a bar or more).
 */
const MEET = 0.3
/** Longest stretch of tab bars a bridge rebuilds. */
const SPAN = 64

interface TightRun {
  /** Indices into the synced bars. */
  first: number
  last: number
  a: number
  b: number
  /** Tab and recording time of its first and last bar (s). */
  x0: number
  x1: number
  y0: number
  y1: number
  /** Bars. */
  n: number
}

/** Runs of bars (FOOTING or more, played in order) that lie tightly on a tempo line. */
function tightRuns(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number): TightRun[] {
  const bars = sync.bars
  const tab = tabSeconds(score, played)
  const runOf = runsOf(bars)
  const out: TightRun[] = []
  for (let i = 0; i < bars.length; ) {
    let j = i
    while (j + 1 < bars.length && runOf[j + 1] === runOf[i]) j++
    if (j - i + 1 >= FOOTING) {
      const idx = Array.from({ length: j - i + 1 }, (_, k) => i + k)
      const x = idx.map((k) => tab[bars[k].played])
      const y = idx.map((k) => bars[k].start / sampleRate)
      const { a, b } = robustLine(x, y)
      const beat = beatOf(score, played[bars[i].played].bar) * b
      if (b >= 0.8 && b <= 1.25 && median(y.map((v, n) => Math.abs(v - (a + b * x[n])))) < TIGHT * beat)
        out.push({ first: i, last: j, a, b, x0: x[0], x1: x[x.length - 1], y0: y[0], y1: y[y.length - 1], n: idx.length })
    }
    i = j + 1
  }
  return out
}

/** Cost, in bars, of each second by which two runs disagree about the time between them. */
const DISAGREE = 1

/**
 * The runs (in recording order) that tell one story: most bars, less DISAGREE for every second by which
 * neighbouring runs disagree (the recording adding or leaving out that much between them). A run
 * placed somewhere wrong, but on a steady tempo, is left out this way. The first run also pays for
 * the recording time before it that its line doesn't explain.
 */
function consistentRuns(runs: TightRun[]): TightRun[] {
  if (!runs.length) return []
  const r = [...runs].sort((p, q) => p.y0 - q.y0)
  const value = r.map((x) => x.n - DISAGREE * Math.abs(x.a))
  const from = r.map(() => -1)
  for (let k = 0; k < r.length; k++)
    for (let j = 0; j < k; j++) {
      if (r[k].x0 <= r[j].x1 || r[k].y0 < r[j].y1 - 0.5) continue
      const d = r[k].y0 - r[j].y1 - r[j].b * (r[k].x0 - r[j].x1)
      const v = value[j] + r[k].n - DISAGREE * Math.abs(d)
      if (v > value[k]) {
        value[k] = v
        from[k] = j
      }
    }
  let k = 0
  for (let i = 1; i < r.length; i++) if (value[i] > value[k]) k = i
  const out: TightRun[] = []
  for (; k >= 0; k = from[k]) out.unshift(r[k])
  return out
}

/** Bars for played bars [from, to) on the line a + b·(tab time), in samples. */
function barsOnLine(score: TabScore, played: PlayedBar[], tab: number[], from: number, to: number, line: { a: number; b: number }, sampleRate: number, maker: BarMaker): SyncedBar[] {
  const at = (t: number) => Math.round((line.a + line.b * t) * sampleRate)
  const out: SyncedBar[] = []
  for (let p = from; p < to; p++) {
    const { n, unitTicks } = maker.unitsOf(p)
    const bar = score.bars[played[p].bar]
    const beats = Array.from({ length: n }, (_, j) => at(tab[p] + barSeconds(bar, j * unitTicks)))
    out.push({ played: p, start: beats[0], end: at(tab[p] + barSeconds(bar)), beats, unitTicks, section: 0, pinned: false, match: maker.matchOf(p, beats), byTempo: true })
  }
  return out
}

const lineThrough = (bars: SyncedBar[], tab: number[], sampleRate: number, ...runs: TightRun[]) => {
  const idx = runs.flatMap((r) => Array.from({ length: r.last - r.first + 1 }, (_, k) => r.first + k))
  const pick = idx.filter((_, k) => k % Math.ceil(idx.length / 60) === 0)
  return robustLine(
    pick.map((k) => tab[bars[k].played]),
    pick.map((k) => bars[k].start / sampleRate),
  )
}

/**
 * Where the beat tracker loses the pulse the sync can scatter a stretch of bars, with jumps. If two
 * neighbouring runs of the story (consistentRuns) lie on one tempo line (the line through the first
 * puts the second where it is), the recording kept the tab's tempo across: the bars between are rebuilt
 * from the tab on that line, whatever the sync put there. Where the recording adds or leaves out
 * something between them, the line doesn't meet the second run and nothing changes. Bars placed by
 * hand are never bridged over.
 */
function bridge(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number, maker: BarMaker): number {
  const tab = tabSeconds(score, played)
  let made = 0
  for (let guard = 0; guard < 100; guard++) {
    const bars = sync.bars
    const runs = consistentRuns(tightRuns(sync, score, played, sampleRate))
    let done = false
    for (let r = 0; r + 1 < runs.length && !done; r++) {
      const [near, far] = [runs[r], runs[r + 1]]
      const p1 = bars[near.last].played
      const p2 = bars[far.first].played
      if (far.first === near.last + 1 && p2 === p1 + 1) continue
      if (p2 <= p1 || p2 - p1 - 1 > SPAN) continue
      const beat = beatOf(score, played[p2].bar) * near.b
      if (Math.abs(near.a + near.b * tab[p2] - far.y0) > MEET * beat) continue
      if (bars.slice(near.last + 1, far.first).some((b) => b.pinned)) continue
      const fresh = barsOnLine(score, played, tab, p1 + 1, p2, lineThrough(bars, tab, sampleRate, near, far), sampleRate, maker)
      bars[near.last].end = fresh.length ? fresh[0].start : bars[far.first].start
      bars.splice(near.last + 1, far.first - near.last - 1, ...fresh)
      made += fresh.length
      done = true
    }
    if (!done) break
  }
  return made
}

/** The tempo's bars may fit the harmony this much worse (standardised pair score) than the sync's. */
const EXTEND_SLACK = 0.1
/** …and must fit at least this share as well as the runs of the story do. */
const EXTEND_FIT = 0.7
/** A run this long has a well-known slope of its own. */
const LONG_RUN = 16

/**
 * Before the first run of the story and after the last, the tab's bars are put on that run's line,
 * where they fall inside the recording, if their harmony fits about as well as the story's runs do, and
 * either as well as what the sync put there or the sync used more bars there than the tab has (it
 * repeated things to chase the beats). An intro or outro the tab doesn't have fails the first test
 * and stays as the sync left it.
 */
function extendEnds(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number, maker: BarMaker): number {
  const tab = tabSeconds(score, played)
  const runs = consistentRuns(tightRuns(sync, score, played, sampleRate))
  if (!runs.length) return 0
  let made = 0
  const meanMatch = (bs: SyncedBar[]) => (bs.length ? bs.reduce((m, b) => m + b.match, 0) / bs.length : -Infinity)
  const story = meanMatch(runs.flatMap((r) => sync.bars.slice(r.first, r.last + 1)))
  // a long run's own line, else (its slope is poorly known) a line through its end bar with the
  // story's slope, weighted by bars
  const slope = runs.reduce((s, r) => s + r.b * r.n, 0) / runs.reduce((n, r) => n + r.n, 0)
  const lineFrom = (r: TightRun, x: number, y: number) => (r.n >= LONG_RUN ? lineThrough(sync.bars, tab, sampleRate, r) : { a: y - slope * x, b: slope })
  const better = (fresh: SyncedBar[], current: SyncedBar[]) =>
    !current.some((b) => b.pinned) && meanMatch(fresh) >= EXTEND_FIT * story && (meanMatch(fresh) >= meanMatch(current) - EXTEND_SLACK || current.length > fresh.length)
  // after the last run
  {
    const bars = sync.bars
    const last = runs[runs.length - 1]
    const p = bars[last.last].played
    const line = lineFrom(last, last.x1, last.y1)
    const fresh = barsOnLine(score, played, tab, p + 1, played.length, line, sampleRate, maker).filter((b) => b.end <= maker.end)
    const span = fresh.length ? [fresh[0].start, fresh[fresh.length - 1].end] : null
    const current = span ? bars.slice(last.last + 1).filter((b) => b.start < span[1]) : []
    if (span && better(fresh, current)) {
      const keep = bars.slice(last.last + 1).filter((b) => b.start >= span[1])
      bars.splice(last.last + 1, bars.length - last.last - 1, ...fresh, ...keep)
      bars[last.last].end = fresh[0].start
      made += fresh.length
    }
  }
  // before the first run (indices before it don't move with the change above)
  {
    const bars = sync.bars
    const first = runs[0]
    const p = bars[first.first].played
    const line = lineFrom(first, first.x0, first.y0)
    const fresh = barsOnLine(score, played, tab, 0, p, line, sampleRate, maker).filter((b) => b.start >= 0)
    const span = fresh.length ? [fresh[0].start, bars[first.first].start] : null
    const current = span ? bars.slice(0, first.first).filter((b) => b.end > span[0]) : []
    if (span && better(fresh, current)) {
      const keep = bars.slice(0, first.first).filter((b) => b.end <= span[0])
      if (fresh.length) fresh[fresh.length - 1].end = bars[first.first].start
      bars.splice(0, first.first, ...keep, ...fresh)
      made += fresh.length
    }
  }
  return made
}

/** A stretch this many beats or more off the line of the bars around it is a slip of the beat tracker. */
const SLIP = 0.4

/**
 * The beat tracker can sit on the off-beats for a whole section, so a long stretch of bars lands half a
 * beat late, every bar alike, and the neighbour check in moveOutliers doesn't see it. The bars are cut
 * into stretches at a steady offset from the tempo line. Between two long ones (FOOTING bars or more)
 * that agree with each other and are played straight through, the bars in between are moved onto their
 * line if, taken together, they are at least SLIP beats off it. A real difference between tab and
 * recording (a note too many in the tab) doesn't come back after the stretch, and smaller ones (a
 * sixteenth) are under SLIP, so neither is touched.
 */
function realignSlips(sync: TabSync, score: TabScore, played: PlayedBar[], sampleRate: number): number {
  const bars = sync.bars
  if (bars.length < 3) return 0
  const tab = tabSeconds(score, played)
  const x = bars.map((b) => tab[b.played])
  const y = bars.map((b) => b.start / sampleRate)
  const { b: slope } = robustLine(
    x.filter((_, k) => k % Math.ceil(bars.length / 80) === 0),
    y.filter((_, k) => k % Math.ceil(bars.length / 80) === 0),
  )
  if (slope < 0.8 || slope > 1.25) return 0
  const beatAt = (i: number) => beatOf(score, played[bars[i].played].bar) * slope
  const d = bars.map((_, i) => y[i] - slope * x[i])
  // stretches of bars played in order at a steady offset
  const parts: { first: number; last: number }[] = []
  bars.forEach((b, i) => {
    const prev = parts[parts.length - 1]
    const follows = i > 0 && b.played === bars[i - 1].played + 1 && b.start - bars[i - 1].end < 1
    if (prev && follows && Math.abs(d[i] - d[i - 1]) < TIGHT * beatAt(i)) prev.last = i
    else parts.push({ first: i, last: i })
  })
  const offsetOf = (p: { first: number; last: number }) => median(d.slice(p.first, p.last + 1))
  const footing = parts.map((p) => p.last - p.first + 1 >= FOOTING)
  // played straight through from bar i to bar j
  const straight = (i: number, j: number) => {
    for (let k = i + 1; k <= j; k++) if (bars[k].played !== bars[k - 1].played + 1) return false
    return true
  }
  let moved = 0
  for (let k = 0; k < parts.length; k++) {
    if (!footing[k]) continue
    let n = k + 1
    while (n < parts.length && !footing[n]) n++
    if (n >= parts.length) continue
    const l = parts[k]
    const r = parts[n]
    // the stretch between two footings: one part or several short ones
    const first = l.last + 1
    const last = r.first - 1
    if (n === k + 1) {
      // two footings side by side: nothing between them to move
      continue
    }
    if (last - first + 1 > SPAN || !straight(l.last, r.first)) continue
    const beat = beatAt(first)
    const [dl, dr] = [offsetOf(l), offsetOf(r)]
    const dm = median(d.slice(first, last + 1))
    if (Math.abs(dl - dr) > MEET * beat || Math.abs(dm - (dl + dr) / 2) < SLIP * beat) continue
    if (bars.slice(first, last + 1).some((b) => b.pinned)) continue
    const idx = [...Array.from({ length: l.last - l.first + 1 }, (_, q) => l.first + q), ...Array.from({ length: r.last - r.first + 1 }, (_, q) => r.first + q)]
    const line = robustLine(
      idx.map((i) => x[i]),
      idx.map((i) => y[i]),
    )
    for (let i = first; i <= last; i++) {
      const shift = Math.round((line.a + line.b * x[i]) * sampleRate) - bars[i].start
      bars[i].start += shift
      bars[i].end += shift
      bars[i].beats = bars[i].beats.map((t) => t + shift)
      moved++
    }
    bars[l.last].end = bars[first].start
    bars[last].end = bars[r.first].start
  }
  return moved
}
