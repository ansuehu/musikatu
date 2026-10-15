import type { PlayedBar } from './expand.ts'
import { barBeats, type TabScore } from './model.ts'

/**
 * The played tab cut into beat-long units, one per beat the tracker should find (`factor` units per
 * notated beat, for songs the tracker counts at half or double speed). Units are numbered through the
 * whole played tab; bar p owns units offset[p] … offset[p] + units[p] - 1.
 */
export interface TabUnits {
  units: number[]
  offset: number[]
  /** Ticks per unit, per played bar. */
  unitTicks: number[]
  /** Pitch-class weights per unit, sum 1 (all zero when nothing sounds). */
  chroma: Float32Array[]
  /** How much of the unit notes fill (0: silent). */
  weight: Float32Array
  /** Lowest pitch class holding for at least a quarter of the unit, or null. */
  bass: (number | null)[]
}

/** Pitched tracks (drums aside). */
export const pitchedTracks = (score: TabScore): number[] => score.tracks.map((t, i) => (t.percussion ? -1 : i)).filter((i) => i >= 0)

export function tabUnits(score: TabScore, played: PlayedBar[], tracks: number[], factor = 1): TabUnits {
  const units: number[] = []
  const offset: number[] = []
  const unitTicks: number[] = []
  let total = 0
  for (const p of played) {
    const bar = score.bars[p.bar]
    const n = Math.max(1, Math.round(barBeats(bar).count * factor))
    offset.push(total)
    units.push(n)
    unitTicks.push(bar.ticks / n)
    total += n
  }
  const chroma = Array.from({ length: total }, () => new Float32Array(12))
  const weight = new Float32Array(total)
  const lowest = new Int32Array(total).fill(1000)
  played.forEach((p, k) => {
    const len = unitTicks[k]
    for (const ti of tracks) {
      for (const beat of score.tracks[ti].bars[p.bar] ?? []) {
        const a = beat.start
        const b = Math.min(score.bars[p.bar].ticks, beat.start + beat.duration)
        for (let u = Math.max(0, Math.floor(a / len)); u < units[k] && u * len < b; u++) {
          const part = (Math.min(b, (u + 1) * len) - Math.max(a, u * len)) / len
          if (part <= 0) continue
          const g = offset[k] + u
          for (const n of beat.notes) {
            if (n.dead) continue
            chroma[g][n.midi % 12] += part
            weight[g] += part / beat.notes.length
            if (part >= 0.25 && n.midi < lowest[g]) lowest[g] = n.midi
          }
        }
      }
    }
  })
  for (const c of chroma) {
    let s = 0
    for (let i = 0; i < 12; i++) s += c[i]
    if (s > 0) for (let i = 0; i < 12; i++) c[i] /= s
  }
  return { units, offset, unitTicks, chroma, weight, bass: Array.from(lowest, (m) => (m < 1000 ? m % 12 : null)) }
}
