/** Beat grid: beats (sample positions) with bar numbers, derived from beat/downbeat tracking and user corrections. */

export interface BeatGrid {
  /** Beat positions in samples of the song buffer, ascending. */
  beats: number[]
  /** Indices into `beats` that start a bar. */
  downbeats: number[]
  /** Bar number of the first downbeat (lets the user say "this is bar 1"; earlier beats are a pickup). */
  firstBar: number
  /** Beats per bar, for display; the actual bars follow `downbeats`. */
  meter: number
  /** True once the user has corrected the grid; never overwritten automatically. */
  edited: boolean
}

export interface BeatInfo {
  /** Index into grid.beats of the beat at or before the position (-1 before the first beat). */
  index: number
  /** Bar number (pickup beats before the first downbeat count as bar firstBar-1). */
  bar: number
  /** 1-based beat within the bar. */
  beat: number
}

/** Most common number of beats between consecutive downbeats. */
export function estimateMeter(downbeats: number[]): number {
  const counts = new Map<number, number>()
  for (let i = 1; i < downbeats.length; i++) {
    const n = downbeats[i] - downbeats[i - 1]
    if (n >= 2 && n <= 12) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  let best = 4
  let bestCount = 0
  for (const [n, c] of counts) if (c > bestCount || (c === bestCount && n === 4)) [best, bestCount] = [n, c]
  return best
}

/** Builds a grid from tracker output (seconds). Downbeats are matched to their beat indices. */
export function buildGrid(beatSeconds: number[], downbeatSeconds: number[], sampleRate: number): BeatGrid {
  const beats = beatSeconds.map((t) => Math.round(t * sampleRate))
  const downbeats: number[] = []
  let j = 0
  for (const t of downbeatSeconds) {
    const p = Math.round(t * sampleRate)
    while (j < beats.length - 1 && Math.abs(beats[j + 1] - p) <= Math.abs(beats[j] - p)) j++
    if (beats.length && downbeats[downbeats.length - 1] !== j) downbeats.push(j)
  }
  return { beats, downbeats, firstBar: 1, meter: estimateMeter(downbeats), edited: false }
}

/** Median inter-beat interval as BPM (of the recording, at 100% speed). */
export function tempoBpm(grid: BeatGrid, sampleRate: number): number | null {
  const d: number[] = []
  for (let i = 1; i < grid.beats.length; i++) d.push(grid.beats[i] - grid.beats[i - 1])
  if (d.length < 2) return null
  d.sort((a, b) => a - b)
  return (60 * sampleRate) / d[d.length >> 1]
}

/** Index of the last beat at or before `pos` (-1 if before the first beat). */
export function beatIndexAt(grid: BeatGrid, pos: number): number {
  let lo = 0
  let hi = grid.beats.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (grid.beats[mid] <= pos) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** Bar and beat at a beat index. */
export function beatInfo(grid: BeatGrid, index: number): BeatInfo {
  if (index < 0 || grid.downbeats.length === 0) return { index, bar: grid.firstBar - 1, beat: index + 1 }
  // number of downbeats at or before index
  let lo = 0
  let hi = grid.downbeats.length - 1
  let k = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (grid.downbeats[mid] <= index) {
      k = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  if (k < 0) {
    // pickup: count back from the first downbeat
    return { index, bar: grid.firstBar - 1, beat: grid.meter - (grid.downbeats[0] - index) + 1 }
  }
  return { index, bar: grid.firstBar + k, beat: index - grid.downbeats[k] + 1 }
}

export function positionInfo(grid: BeatGrid, pos: number): BeatInfo {
  return beatInfo(grid, beatIndexAt(grid, pos))
}

/** Sample range [start, end) of bar `bar`, or null if the grid doesn't cover it. */
export function barRange(grid: BeatGrid, bar: number, songLength: number): { start: number; end: number } | null {
  const k = bar - grid.firstBar
  if (k < 0 || k >= grid.downbeats.length) return null
  const start = grid.beats[grid.downbeats[k]]
  const next = grid.downbeats[k + 1]
  const end = next !== undefined ? grid.beats[next] : lastBarEnd(grid, k, songLength)
  return { start, end }
}

function lastBarEnd(grid: BeatGrid, k: number, songLength: number): number {
  const i = grid.downbeats[k] + grid.meter
  if (i < grid.beats.length) return grid.beats[i]
  const n = grid.beats.length
  const ibi = n > 1 ? grid.beats[n - 1] - grid.beats[n - 2] : songLength
  return Math.min(songLength, grid.beats[n - 1] + ibi)
}

export function lastBar(grid: BeatGrid): number {
  return grid.firstBar + grid.downbeats.length - 1
}

/** Nearest beat to `pos` (or pos unchanged if there is no grid). */
export function snapToBeat(grid: BeatGrid, pos: number): number {
  const i = beatIndexAt(grid, pos)
  const a = grid.beats[i]
  const b = grid.beats[i + 1]
  if (a === undefined) return b ?? pos
  if (b === undefined) return a
  return pos - a <= b - pos ? a : b
}

// ---------- corrections ----------

/** Rebuilds downbeats every `meter` beats, keeping the first downbeat where it is. */
export function withMeter(grid: BeatGrid, meter: number): BeatGrid {
  const anchor = grid.downbeats[0] ?? 0
  const downbeats: number[] = []
  for (let i = anchor % meter; i < grid.beats.length; i += meter) if (i >= anchor || i === anchor % meter) downbeats.push(i)
  return { ...grid, downbeats, meter, edited: true }
}

/** Moves every downbeat by `delta` beats (fixes "the 1 is on the 2"). */
export function shiftDownbeats(grid: BeatGrid, delta: number): BeatGrid {
  const n = grid.beats.length
  const downbeats = grid.downbeats.map((i) => i + delta).filter((i) => i >= 0 && i < n)
  return { ...grid, downbeats, edited: true }
}

/** Half tempo: keep every other beat (choosing the half that holds the downbeats). */
export function halfTempo(grid: BeatGrid): BeatGrid {
  const parity = (grid.downbeats[0] ?? 0) % 2
  const keep: number[] = []
  const map = new Map<number, number>()
  grid.beats.forEach((b, i) => {
    if (i % 2 === parity) {
      map.set(i, keep.length)
      keep.push(b)
    }
  })
  const downbeats = [...new Set(grid.downbeats.map((i) => map.get(i - ((i - parity) % 2 + 2) % 2)).filter((x): x is number => x !== undefined))]
  return { ...grid, beats: keep, downbeats, meter: Math.max(1, Math.round(grid.meter / 2)), edited: true }
}

/** Double tempo: insert a beat halfway between each pair. */
export function doubleTempo(grid: BeatGrid): BeatGrid {
  const beats: number[] = []
  grid.beats.forEach((b, i) => {
    beats.push(b)
    const next = grid.beats[i + 1]
    if (next !== undefined) beats.push(Math.round((b + next) / 2))
  })
  return { ...grid, beats, downbeats: grid.downbeats.map((i) => i * 2), meter: grid.meter * 2, edited: true }
}

/** Renumbers bars so the bar containing `pos` becomes bar 1. */
export function setBarOneAt(grid: BeatGrid, pos: number): BeatGrid {
  const info = positionInfo(grid, pos)
  return { ...grid, firstBar: grid.firstBar - (info.bar - 1), edited: true }
}
