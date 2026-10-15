import type { TabUnits } from './features.ts'

/**
 * Tab-to-recording alignment. The played tab is a chain of beat-long units; the recording is the tracked
 * beats with their harmony. A Viterbi pass walks the recording beat by beat and decides, for each beat,
 * which tab unit sounds there or that the tab has nothing there (a gap: an intro, solo or outro the tab
 * leaves out). Normal playing moves one unit per beat. It can also hold a unit for an extra beat or skip
 * one (tempo drift, beats the tracker missed or doubled), jump at a bar line to another bar (an extra or
 * skipped repeat, preferably to the start of a block), and leave or re-enter the tab at a bar line.
 * Bars therefore start on whichever beat fits, not only on the tracker's downbeats. Gaps before the tab
 * starts and after it ends are free; one in the middle costs.
 */

/** The recording's harmony per tracked beat (beatHarmony in chordTimeline.ts). */
export interface AudioBeats {
  chroma: Float32Array[]
  level: Float32Array
  bass: (number | null)[]
  /** Tracked downbeats, as indices into the beats. */
  downbeats: number[]
}

export interface AlignParams {
  /** Holding a unit for one more beat. */
  stay: number
  /** Skipping a unit. */
  skip: number
  /**
   * Jumping at a bar line to the start of another block (repeat pass or section): a repeat the recording
   * plays more or fewer times, a section it skips or adds. (Separate costs for repeating the last block
   * or jumping back were tried and only overfit the evaluation songs.)
   */
  jump: number
  /** Added when jumping to a bar that doesn't start a block. */
  jumpAny: number
  /** Added when jumping further than the neighbouring section (in playing order): recordings repeat or skip nearby. */
  jumpFar: number
  /** Leaving the tab for a gap in the middle, and coming back from one. Before the tab starts and after it ends, gaps are free. */
  gapIn: number
  gapOut: number
  /** Score of a beat spent in a gap (the tab has nothing there). */
  gapEmit: number
  /** The same before the tab starts and after it ends. */
  edgeEmit: number
  /** Added to the similarity (cosine, 0..1) when the bass note matches. */
  bass: number
  /** Bonus for a bar starting on a tracked downbeat. */
  downbeat: number
}

export const DEFAULT_PARAMS: AlignParams = {
  stay: 1.5,
  skip: 1.5,
  jump: 3,
  jumpAny: 3,
  jumpFar: 4,
  gapIn: 3,
  gapOut: 3,
  gapEmit: -0.3,
  edgeEmit: 0,
  bass: 0.05,
  downbeat: 0.3,
}

/** How the played tab is divided: per played bar, whether it starts a block and which section run it is in. */
export interface Structure {
  blockStart: boolean[]
  /** Index of the run of bars with the same section name, in playing order (repeat passes share one). */
  part: number[]
}

/** A bar the user placed by hand: played bar `played` starts on beat `beat`. */
export interface Anchor {
  played: number
  beat: number
}

export interface AlignResult {
  /** Tab unit per beat, or -1 for a gap. */
  path: Int32Array
  /** Semitones the tab is moved to match the recording (0 when it is at sounding pitch). */
  shift: number
  /** Total path score. */
  score: number
  /** The pair scores used (for confidences). */
  em: Emissions
  norm: Norm
}

const SILENT = 2e-3
const NEG = -1e30

function unit(c: Float32Array): Float32Array {
  let s = 0
  for (let i = 0; i < 12; i++) s += c[i] * c[i]
  const out = new Float32Array(12)
  if (s > 0) for (let i = 0; i < 12; i++) out[i] = c[i] / Math.sqrt(s)
  return out
}

/** Typical mismatch score and spread, to standardise pair scores (shared by all shifts so they compare). */
export interface Norm {
  median: number
  spread: number
}

/**
 * Match score of tab unit u against beat t for transposition `shift`: the cosine of their pitch-class
 * profiles (plus a bonus when the bass agrees), standardised by `norm` so that a typical mismatch scores
 * about 0 and a good match well above.
 */
export class Emissions {
  readonly U: number
  readonly T: number
  /** A sample of raw pair scores, for norms. */
  readonly sample: number[] = []
  private readonly raw: Float32Array
  private readonly sim: Float32Array
  private readonly tabSilent: Uint8Array
  private readonly audioSilent: Uint8Array

  constructor(tab: TabUnits, audio: AudioBeats, shift: number, bassBonus: number) {
    const U = (this.U = tab.chroma.length)
    const T = (this.T = audio.chroma.length)
    const tv = tab.chroma.map((c) => {
      const r = new Float32Array(12)
      for (let i = 0; i < 12; i++) r[(i + shift) % 12] = c[i]
      return unit(r)
    })
    const av = audio.chroma.map(unit)
    this.tabSilent = Uint8Array.from(tab.weight, (w) => (w < 0.05 ? 1 : 0))
    this.audioSilent = Uint8Array.from(audio.level, (l, t) => (l < SILENT || !av[t].some((v) => v > 0) ? 1 : 0))
    const raw = (this.raw = new Float32Array(U * T))
    this.sim = new Float32Array(U * T)
    for (let u = 0; u < U; u++) {
      const a = tv[u]
      const tb = tab.bass[u] === null ? null : (tab.bass[u]! + shift) % 12
      for (let t = 0; t < T; t++) {
        const b = av[t]
        let d = 0
        for (let i = 0; i < 12; i++) d += a[i] * b[i]
        if (tb !== null && audio.bass[t] === tb) d += bassBonus
        raw[u * T + t] = d
        if (!this.tabSilent[u] && !this.audioSilent[t] && (u * 7919 + t * 104729) % 7 === 0) this.sample.push(d)
      }
    }
  }

  /** The norm of a set of samples: their median, and the 90th percentile minus the median. */
  static norm(samples: number[]): Norm {
    const s = [...samples].sort((a, b) => a - b)
    const median = s[s.length >> 1] ?? 0
    const q90 = s[Math.floor(s.length * 0.9)] ?? 1
    return { median, spread: Math.max(0.05, q90 - median) }
  }

  normalise({ median, spread }: Norm): this {
    const { U, T, raw, sim } = this
    for (let u = 0; u < U; u++)
      for (let t = 0; t < T; t++) {
        const k = u * T + t
        if (this.tabSilent[u]) sim[k] = this.audioSilent[t] ? 0.5 : 0
        else if (this.audioSilent[t]) sim[k] = -0.5
        else sim[k] = (raw[k] - median) / spread
      }
    return this
  }

  at(u: number, t: number): number {
    return this.sim[u * this.T + t]
  }
}

/**
 * Best path for one transposition. Jumps go to block starts (cheaply when the block is in the same or a
 * neighbouring section).
 * With `keepPath` false only the score is computed. `forbid` (beat → tab units) rules out placements,
 * for measuring how much worse the best alternative is.
 */
export function viterbi(
  tab: TabUnits,
  em: Emissions,
  structure: Structure,
  downbeats: number[],
  params: AlignParams,
  anchors: Anchor[],
  keepPath: boolean,
  forbid?: Map<number, number[]>,
): { score: number; path: Int32Array | null } {
  const U = em.U
  const T = em.T
  // tab units, then three gap states: in the middle, before the tab starts, after it ends
  const GAP = U
  const HEAD = U + 1
  const TAIL = U + 2
  const S = U + 3
  const P = tab.units.length
  const barOf = new Int32Array(U)
  for (let p = 0; p < P; p++) for (let j = 0; j < tab.units[p]; j++) barOf[tab.offset[p] + j] = p
  const endOf = (p: number) => tab.offset[p] + tab.units[p] - 1
  const down = new Uint8Array(T)
  for (const d of downbeats) if (d >= 0 && d < T) down[d] = 1
  const forced = new Map<number, number>()
  for (const a of anchors) if (a.played >= 0 && a.played < P && a.beat >= 0 && a.beat < T) forced.set(a.beat, tab.offset[a.played])
  const { blockStart, part } = structure
  const parts = part.length ? part[part.length - 1] + 1 : 0
  // best bar end in each section run
  const partBest = new Float64Array(parts)
  const partAt = new Int32Array(parts)
  const extra = (p: number) => (blockStart[p] ? 0 : params.jumpAny)
  const entry = (p: number) => (p === 0 ? 0 : params.jump + extra(p))

  let dp = new Float64Array(S)
  let next = new Float64Array(S)
  const back = keepPath ? new Int32Array(T * S) : null

  for (let t = 0; t < T; t++) {
    const db = down[t] ? params.downbeat : 0
    if (t === 0) {
      dp.fill(NEG)
      for (let p = 0; p < P; p++) dp[tab.offset[p]] = em.at(tab.offset[p], 0) - entry(p) + db
      dp[HEAD] = params.edgeEmit
    } else {
      // best bar end, for jumps and for leaving into a gap
      let bestEnd = NEG
      let bestEndState = -1
      partBest.fill(NEG)
      for (let p = 0; p < P; p++) {
        const e = endOf(p)
        if (dp[e] > bestEnd) {
          bestEnd = dp[e]
          bestEndState = e
        }
        if (dp[e] > partBest[part[p]]) {
          partBest[part[p]] = dp[e]
          partAt[part[p]] = e
        }
      }
      for (let g = 0; g < U; g++) {
        let best = dp[g] - params.stay
        let from = g
        if (g >= 1 && dp[g - 1] > best) {
          best = dp[g - 1]
          from = g - 1
        }
        if (g >= 2 && dp[g - 2] - params.skip > best) {
          best = dp[g - 2] - params.skip
          from = g - 2
        }
        const p = barOf[g]
        if (tab.offset[p] === g) {
          const cands: [number, number][] = [
            [dp[HEAD] - entry(p), HEAD],
            [dp[GAP] - params.gapOut - extra(p), GAP],
            [bestEnd - params.jump - params.jumpFar - extra(p), bestEndState],
          ]
          for (let k = Math.max(0, part[p] - 1); k <= Math.min(parts - 1, part[p] + 1); k++) cands.push([partBest[k] - params.jump - extra(p), partAt[k]])
          for (const [v, s] of cands)
            if (v > best) {
              best = v
              from = s
            }
          best += db
        }
        next[g] = best + em.at(g, t)
        if (back) back[t * S + g] = from
      }
      const enterGap = bestEnd - params.gapIn
      next[GAP] = Math.max(dp[GAP], enterGap) + params.gapEmit
      next[HEAD] = dp[HEAD] + params.edgeEmit
      const fromEnd = dp[endOf(P - 1)]
      next[TAIL] = Math.max(dp[TAIL], fromEnd) + params.edgeEmit
      if (back) {
        back[t * S + GAP] = dp[GAP] >= enterGap ? GAP : bestEndState
        back[t * S + HEAD] = HEAD
        back[t * S + TAIL] = dp[TAIL] >= fromEnd ? TAIL : endOf(P - 1)
      }
      ;[dp, next] = [next, dp]
    }
    const f = forced.get(t)
    if (f !== undefined) for (let g = 0; g < S; g++) if (g !== f) dp[g] = NEG
    for (const x of forbid?.get(t) ?? []) dp[x] = NEG
  }
  let s = 0
  for (let g = 1; g < S; g++) if (dp[g] > dp[s]) s = g
  const score = dp[s]
  if (!back) return { score, path: null }
  const path = new Int32Array(T)
  for (let t = T - 1; t >= 0; t--) {
    path[t] = s >= U ? -1 : s
    if (t > 0) s = back[t * S + s]
  }
  return { score, path }
}

/**
 * Aligns for every transposition (or only `shifts`) and keeps the best. A tab written with a different
 * capo or tuning than the recording is found this way. Pair scores are standardised with `norm`, or with
 * one norm pooled over all the shifts tried.
 */
export function align(
  tab: TabUnits,
  audio: AudioBeats,
  structure: Structure,
  options: { params?: Partial<AlignParams>; anchors?: Anchor[]; shifts?: number[]; norm?: Norm } = {},
): AlignResult {
  const params = { ...DEFAULT_PARAMS, ...options.params }
  const anchors = options.anchors ?? []
  const shifts = options.shifts ?? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const ems = shifts.map((shift) => new Emissions(tab, audio, shift, params.bass))
  const norm = options.norm ?? Emissions.norm(ems.flatMap((e) => e.sample))
  let best: { shift: number; score: number; em: Emissions } | null = null
  shifts.forEach((shift, i) => {
    const em = ems[i].normalise(norm)
    const { score } = viterbi(tab, em, structure, audio.downbeats, params, anchors, false)
    if (!best || score > best.score) best = { shift, score, em }
  })
  const { shift, score, em } = best!
  const path = viterbi(tab, em, structure, audio.downbeats, params, anchors, true).path!
  return { path, shift, score, em, norm }
}
