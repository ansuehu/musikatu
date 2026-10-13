import { segmentAt, type Chord, type ChordSegment } from '../analysis/chordTimeline.ts'
import { barRange, lastBar, type BeatGrid } from './grid.ts'

/** Moves each chord change to the nearest beat if one is within `maxDist` samples, dropping segments that collapse. */
export function snapSegmentsToBeats(segments: ChordSegment[], beats: number[], maxDist: number): ChordSegment[] {
  if (beats.length === 0 || segments.length === 0) return segments
  const nearest = (pos: number) => {
    let lo = 0
    let hi = beats.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (beats[mid] < pos) lo = mid + 1
      else hi = mid
    }
    const cands = [beats[lo], beats[lo - 1]].filter((b) => b !== undefined)
    const best = cands.reduce((a, b) => (Math.abs(b - pos) < Math.abs(a - pos) ? b : a))
    return Math.abs(best - pos) <= maxDist ? best : pos
  }
  const out: ChordSegment[] = []
  for (let i = 0; i < segments.length; i++) {
    const start = i === 0 ? segments[0].start : nearest(segments[i].start)
    const prev = out[out.length - 1]
    if (prev) {
      if (start <= prev.start) continue // collapsed onto the previous change
      prev.end = start
    }
    out.push({ ...segments[i], start })
  }
  out[out.length - 1].end = segments[segments.length - 1].end
  return out
}

/** Chords sounding on each beat of a bar, with immediate repeats removed. */
function chordsInBar(segments: ChordSegment[], grid: BeatGrid, bar: number, songLength: number, label: (c: Chord) => string): string[] {
  const range = barRange(grid, bar, songLength)
  if (!range) return []
  const names: string[] = []
  for (const b of grid.beats) {
    if (b < range.start) continue
    if (b >= range.end) break
    const i = segmentAt(segments, b + 1)
    const c = i >= 0 ? segments[i].chord : null
    const name = c ? label(c) : 'N.C.'
    if (names[names.length - 1] !== name) names.push(name)
  }
  return names
}

/** Lead-sheet style text, four bars per line: "17 | C | Am | F G | G7 |". Repeated bars are written as "%". */
export function chordSheetByBars(segments: ChordSegment[], grid: BeatGrid, songLength: number, label: (c: Chord) => string, barsPerLine = 4): string {
  const lines: string[] = []
  let line: string[] = []
  let lineStart = grid.firstBar
  let previous = ''
  for (let bar = grid.firstBar; bar <= lastBar(grid); bar++) {
    const cell = chordsInBar(segments, grid, bar, songLength, label).join(' ') || 'N.C.'
    line.push(cell === previous ? '%' : cell)
    previous = cell
    if (line.length === barsPerLine) {
      lines.push(`${String(lineStart).padStart(3)} | ${line.join(' | ')} |`)
      line = []
      lineStart = bar + 1
    }
  }
  if (line.length) lines.push(`${String(lineStart).padStart(3)} | ${line.join(' | ')} |`)
  return lines.join('\n')
}
