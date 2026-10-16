import { align, DEFAULT_PARAMS, viterbi, type AlignParams, type AudioBeats, type Emissions, type Norm, type Structure } from './align.ts'
import { expandBars, type PlayedBar } from './expand.ts'
import { pitchedTracks, tabUnits, type TabUnits } from './features.ts'
import { lockToTempo } from './tempo.ts'
import type { TabScore } from './model.ts'

/** One bar of the tab placed on the recording (bars are in recording order; a bar can appear twice). */
export interface SyncedBar {
  /** Index into the played (written-out) tab. */
  played: number
  /** Samples. */
  start: number
  end: number
  /** Start of each beat-long unit of the bar, samples (units of `unitTicks` ticks). */
  beats: number[]
  unitTicks: number
  /** Index into TabSync.sections. */
  section: number
  /** Placed by hand. */
  pinned: boolean
  /** How well its harmony matches the recording (standardised pair score, see align.ts). */
  match: number
  /** Put there by the tempo lock (from the tab's tempo, not the beat grid). */
  byTempo?: boolean
}

/** A run of synced bars from one block of the tab, with how sure the match is. */
export interface SyncSection {
  label: string
  /** Indices into TabSync.bars. */
  first: number
  last: number
  /** 0..1: how well the harmony matches, lowered where the recording leaves the tab's order. */
  confidence: number
  /** Reached by leaving the tab's order (a jump, or back from a gap): the recording repeats or skips something here. */
  jumped: boolean
}

/** A bar placed by hand: played bar `played` starts at sample `pos`. Saved with the project. */
export interface TabAnchor {
  played: number
  pos: number
}

export interface TabSync {
  bars: SyncedBar[]
  sections: SyncSection[]
  /** Semitones the tab was moved to match the recording (e.g. a missing capo). */
  shift: number
  /** Tracker beats per notated beat (1, or 2 / 0.5 when the tracker counts at double or half speed). */
  factor: number
  /** Tracks used for matching. */
  tracks: number[]
  /** Bars of the played tab the recording doesn't play. */
  missing: number[]
  /** Bars moved onto the tab's tempo line (see tempo.ts). */
  tempoLocked: number
}

export interface SyncInput {
  /** Tracked beats, samples. */
  beats: number[]
  sampleRate: number
  audio: AudioBeats
  /** Tracks to match (default: every pitched track). */
  tracks?: number[]
  anchors?: TabAnchor[]
  params?: Partial<AlignParams>
  /** Restrict the transposition search (default: all 12). */
  shifts?: number[]
  factors?: number[]
  /** Move bars that are off the tab's tempo line onto it (default on; see tempo.ts). */
  tempoLock?: boolean
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))

/** Confidence factor for a section reached by a jump. */
const JUMP_DOUBT = 0.6

/** Score loss (see align.ts) at which a placement counts as clearly the best: 1 − e⁻¹ of full confidence. */
const UNIQUE_SCALE = 2

/** Position in samples of a fractional beat index, extrapolating past the last beat. */
export function beatToSample(beats: number[], x: number): number {
  const n = beats.length
  if (n === 0) return 0
  if (n === 1) return beats[0]
  if (x <= 0) return beats[0] + x * (beats[1] - beats[0])
  if (x >= n - 1) return beats[n - 1] + (x - (n - 1)) * (beats[n - 1] - beats[n - 2])
  const i = Math.floor(x)
  return beats[i] + (x - i) * (beats[i + 1] - beats[i])
}

/** Index of the beat nearest to `pos`. */
export function nearestBeat(beats: number[], pos: number): number {
  let lo = 0
  let hi = beats.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid] < pos) lo = mid + 1
    else hi = mid
  }
  return lo > 0 && pos - beats[lo - 1] < beats[lo] - pos ? lo - 1 : lo
}

/**
 * The tracked beats with gaps filled and stray beats removed, so each beat of the music has one: where
 * the spacing is about k times the local beat length (k ≤ MAX_FILL), k − 1 beats are put in between; a
 * beat much closer to its neighbour than that is dropped. Longer gaps are breaks or a final chord ringing
 * out and are left alone. Stretches the tracker counted at half speed (spacing about twice the song's
 * usual beat, as happens in quiet intros without drums) get a beat in each gap. Downbeats follow their
 * beats.
 */
const MAX_FILL = 4

export function regularBeats(beats: number[], downbeats: number[] = []): { beats: number[]; downbeats: number[] } {
  const n = beats.length
  if (n < 4) return { beats: [...beats], downbeats: [...downbeats] }
  const gaps = beats.slice(1).map((b, i) => b - beats[i])
  const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]
  const song = median(gaps)
  // local beat length: median of the surrounding gaps, halved where the tracker went to half speed
  const local = gaps.map((_, i) => {
    const m = median(gaps.slice(Math.max(0, i - 8), i + 9))
    return m > 1.75 * song && m < 2.3 * song ? m / 2 : m
  })
  const isDown = new Set(downbeats)
  const out: number[] = [beats[0]]
  const down: number[] = isDown.has(0) ? [0] : []
  for (let i = 1; i < n; i++) {
    const len = local[i - 1]
    const prev = out[out.length - 1]
    const gap = beats[i] - prev
    if (gap < 0.4 * len && !isDown.has(i)) continue
    const k = Math.round(gap / len)
    if (k <= MAX_FILL) for (let j = 1; j < k; j++) out.push(Math.round(prev + (j * gap) / k))
    if (isDown.has(i)) down.push(out.length)
    out.push(beats[i])
  }
  return { beats: out, downbeats: down }
}

/** Blocks and section runs of the played tab, for the alignment's jumps. */
export function structureOf(played: PlayedBar[]): Structure {
  let part = 0
  return {
    blockStart: played.map((p, i) => i === 0 || p.block !== played[i - 1].block),
    part: played.map((p, i) => (i > 0 && p.section !== played[i - 1].section ? ++part : part)),
  }
}

/** Aligns a tab to a recording. */
export function syncTab(score: TabScore, input: SyncInput): TabSync {
  const played = expandBars(score.bars)
  const tracks = input.tracks?.length ? input.tracks : pitchedTracks(score)
  const structure = structureOf(played)
  const params = { ...DEFAULT_PARAMS, ...input.params }
  const anchors = (input.anchors ?? []).map((a) => ({ played: a.played, beat: nearestBeat(input.beats, a.pos) }))
  let best: { factor: number; tab: TabUnits; r: ReturnType<typeof align> } | null = null
  // the first factor's norm is used for all, so their scores compare
  let norm: Norm | undefined
  for (const factor of input.factors ?? [1, 2, 0.5]) {
    const tab = tabUnits(score, played, tracks, factor)
    const r = align(tab, input.audio, structure, { params, anchors, shifts: input.shifts, norm })
    norm = r.norm
    if (!best || r.score > best.r.score) best = { factor, tab, r }
  }
  const { factor, tab, r } = best!
  const out = buildSync(played, tab, r.path, r.em, input.beats)
  out.shift = r.shift
  out.factor = factor
  out.tracks = tracks
  if (input.tempoLock ?? true) {
    // bars the tempo lock adds get their harmony match from the same pair scores
    const matchOf = (p: number, at: number[]) => at.reduce((m, x, j) => m + r.em.at(tab.offset[p] + j, nearestBeat(input.beats, x)), 0) / at.length
    const unitsOf = (p: number) => ({ n: tab.units[p], unitTicks: tab.unitTicks[p] })
    const last = input.beats[input.beats.length - 1] ?? 0
    out.tempoLocked = lockToTempo(out, score, played, input.sampleRate, { matchOf, unitsOf, end: last + input.sampleRate })
    out.sections = groupSections(out.bars, played)
    const seen = new Set(out.bars.map((b) => b.played))
    out.missing = played.map((_, p) => p).filter((p) => !seen.has(p))
  }
  // how much worse the best alignment gets if the section's first bar, or any bar with the same notes
  // (another pass of a repeat, a section written out twice), may not sound within a beat of where it
  // was put: close to nothing means other music fits there as well. Which of several identical bars it
  // is doesn't matter, nor a beat either way (the beat grid settles that).
  const contentKey = played.map((_, p) => {
    const parts: string[] = []
    for (let j = 0; j < tab.units[p]; j++) parts.push(Array.from(tab.chroma[tab.offset[p] + j], (v) => Math.round(v * 20)).join(','))
    return parts.join('|')
  })
  const anchored = new Set(anchors.map((a) => a.played))
  for (const s of out.sections) {
    const b = out.bars[s.first]
    // bars the tempo lock made were never the alignment's choice, so it can't say how unique they are
    if (anchored.has(b.played) || b.byTempo) continue
    const beat = nearestBeat(input.beats, b.start)
    const units = played.flatMap((_, p) => (contentKey[p] === contentKey[b.played] ? Array.from({ length: tab.units[p] }, (_, j) => tab.offset[p] + j) : []))
    const forbid = new Map([beat - 1, beat, beat + 1].filter((t) => t >= 0).map((t) => [t, units]))
    const alt = viterbi(tab, r.em, structure, input.audio.downbeats, params, anchors, false, forbid).score
    s.confidence *= 1 - Math.exp(-Math.max(0, r.score - alt) / UNIQUE_SCALE)
  }
  // hand-placed bars start exactly where they were put
  for (const a of input.anchors ?? []) {
    const b = out.bars.find((b) => b.played === a.played && Math.abs(b.start - a.pos) < (b.end - b.start) * 2)
    if (b) {
      const shiftBy = a.pos - b.start
      b.beats = b.beats.map((x, j) => x + shiftBy * (1 - j / b.beats.length))
      b.start = a.pos
      b.pinned = true
    }
  }
  return out
}

/** Turns a Viterbi path into bars with times, sections and confidences. */
export function buildSync(played: PlayedBar[], tab: TabUnits, path: Int32Array, em: Emissions, beats: number[]): TabSync {
  const P = played.length
  const barOf = new Int32Array(tab.chroma.length)
  for (let p = 0; p < P; p++) for (let j = 0; j < tab.units[p]; j++) barOf[tab.offset[p] + j] = p
  const T = path.length

  // occurrences of bars along the path
  interface Occ {
    p: number
    t0: number
    t1: number
    unitAt: number[]
  }
  const occs: Occ[] = []
  for (let t = 0; t < T; t++) {
    const g = path[t]
    if (g < 0) continue
    const p = barOf[g]
    const prev = t > 0 ? path[t - 1] : -1
    const cur = occs[occs.length - 1]
    if (!cur || prev < 0 || barOf[prev] !== p || g < prev || cur.t1 !== t) occs.push({ p, t0: t, t1: t + 1, unitAt: new Array(tab.units[p]).fill(NaN) })
    else occs[occs.length - 1].t1 = t + 1
    const o = occs[occs.length - 1]
    const j = g - tab.offset[p]
    if (Number.isNaN(o.unitAt[j])) o.unitAt[j] = t
  }

  const matchOn = (t0: number, t1: number) => {
    let m = 0
    for (let t = t0; t < t1; t++) m += em.at(path[t], t)
    return m / Math.max(1, t1 - t0)
  }
  const bars: SyncedBar[] = []
  for (const o of occs) {
    const n = tab.units[o.p]
    // fill units that were skipped by interpolation between the known ones and the bar end
    const known: [number, number][] = []
    o.unitAt.forEach((t, j) => Number.isFinite(t) && known.push([j, t]))
    known.push([n, o.t1])
    const pos = o.unitAt.map((t, j) => {
      if (Number.isFinite(t)) return t
      const after = known.findIndex(([k]) => k > j)
      const [ja, ta] = after > 0 ? known[after - 1] : [j, known[0][1]]
      const [jb, tb] = known[after]
      return ja === j ? ta : ta + ((j - ja) * (tb - ta)) / (jb - ja)
    })
    bars.push({
      played: o.p,
      start: Math.round(beatToSample(beats, pos[0])),
      end: Math.round(beatToSample(beats, o.t1)),
      beats: pos.map((x) => Math.round(beatToSample(beats, x))),
      unitTicks: tab.unitTicks[o.p],
      section: 0,
      pinned: false,
      // how well the bar matches: mean standardised score on its beats
      match: matchOn(o.t0, o.t1),
    })
  }

  const sections = groupSections(bars, played)
  const seen = new Set(bars.map((b) => b.played))
  return { bars, sections, shift: 0, factor: 1, tracks: [], missing: played.map((_, p) => p).filter((p) => !seen.has(p)), tempoLocked: 0 }
}

/**
 * Sections: consecutive bars of one block, in recording order, with a confidence from how well their
 * harmony matches (sets each bar's section).
 */
export function groupSections(bars: SyncedBar[], played: PlayedBar[]): SyncSection[] {
  const sections: SyncSection[] = []
  bars.forEach((b, i) => {
    const prev = bars[i - 1]
    const follows = prev && b.played === prev.played + 1 && b.start - prev.end < 1
    if (!follows || played[b.played].block !== played[prev.played].block)
      sections.push({ label: played[b.played].section, first: i, last: i, confidence: 0, jumped: i === 0 ? b.played !== 0 : !follows })
    else sections[sections.length - 1].last = i
    b.section = sections.length - 1
  })
  for (const s of sections) {
    let m = 0
    for (let i = s.first; i <= s.last; i++) m += bars[i].match
    const k = s.last - s.first + 1
    // the structure is least certain where the recording leaves the tab's order: which of several
    // identical passes it is can't be told from the harmony
    s.confidence = sigmoid(2 * (m / k - 0.6)) * (s.jumped ? JUMP_DOUBT : 1)
  }
  return sections
}

/** Synced bar sounding at `pos`, or -1 (before the tab, in a gap, after it). */
export function barAt(sync: TabSync, pos: number): number {
  const bars = sync.bars
  let lo = 0
  let hi = bars.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (pos < bars[mid].start) hi = mid - 1
    else if (pos >= bars[mid].end) lo = mid + 1
    else return mid
  }
  return -1
}

/** Position inside the written bar (ticks) of synced bar `i` at sample `pos`, by its beats. */
export function tickAt(bar: SyncedBar, pos: number): number {
  const n = bar.beats.length
  let j = 0
  while (j + 1 < n && bar.beats[j + 1] <= pos) j++
  const a = bar.beats[j]
  const b = j + 1 < n ? bar.beats[j + 1] : bar.end
  const f = b > a ? Math.max(0, Math.min(1, (pos - a) / (b - a))) : 0
  return (j + f) * bar.unitTicks
}

/** Sample where tick `tick` of synced bar `bar` sounds. */
export function sampleAt(bar: SyncedBar, tick: number): number {
  const n = bar.beats.length
  const x = Math.max(0, Math.min(n, tick / bar.unitTicks))
  const j = Math.min(n - 1, Math.floor(x))
  const a = bar.beats[j]
  const b = j + 1 < n ? bar.beats[j + 1] : bar.end
  return Math.round(a + (x - j) * (b - a))
}
