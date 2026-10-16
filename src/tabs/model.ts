/**
 * A guitar tab, independent of the file format it came from (see alphatab.ts). Times inside the tab are
 * in ticks, TICKS_PER_QUARTER to the quarter note.
 */

export const TICKS_PER_QUARTER = 960

export interface TabNote {
  /** 1 = the lowest string. */
  string: number
  fret: number
  /** Sounding MIDI pitch (capo and tuning included). */
  midi: number
  /** Continues a note tied from before: still sounding, but not struck. */
  tie: boolean
  /** Muted ("x"): struck but no pitch. */
  dead: boolean
}

export interface TabBeat {
  /** Ticks from the start of the bar. */
  start: number
  duration: number
  notes: TabNote[]
}

export interface TabTrack {
  name: string
  /** Open-string pitches, lowest string first. */
  tuning: number[]
  capo: number
  percussion: boolean
  /** Beats of each written bar, all voices merged, by start. */
  bars: TabBeat[][]
}

export type TabDirection =
  | 'Fine'
  | 'Segno'
  | 'SegnoSegno'
  | 'Coda'
  | 'DoubleCoda'
  | 'DaCapo'
  | 'DaCapoAlCoda'
  | 'DaCapoAlDoubleCoda'
  | 'DaCapoAlFine'
  | 'DalSegno'
  | 'DalSegnoAlCoda'
  | 'DalSegnoAlDoubleCoda'
  | 'DalSegnoAlFine'
  | 'DalSegnoSegno'
  | 'DalSegnoSegnoAlCoda'
  | 'DalSegnoSegnoAlDoubleCoda'
  | 'DalSegnoSegnoAlFine'
  | 'DaCoda'
  | 'DaDoubleCoda'

/** A written bar, shared by all tracks. */
export interface TabBar {
  /** Time signature. */
  num: number
  den: number
  /** Length in ticks (shorter than the signature for a pickup bar). */
  ticks: number
  repeatStart: boolean
  /** Times the repeat ending here is played in all (0: no repeat sign). */
  repeatEnd: number
  /** Alternate endings this bar belongs to: bit k set = played on pass k+1 (0: not an ending). */
  endings: number
  /** Section name starting at this bar ("Chorus"), or null. */
  section: string | null
  directions: TabDirection[]
  /** Tempo at the start of the bar, quarter notes per minute. */
  tempo: number
  /** Tempo changes inside the bar: position as a share of the bar (0 < at < 1), new tempo. */
  tempoChanges?: { at: number; bpm: number }[]
}

/** Seconds from the start of `bar` to tick `tick` of it, following its tempo changes. */
export function barSeconds(bar: TabBar, tick = bar.ticks): number {
  let s = 0
  let from = 0
  let bpm = bar.tempo
  for (const c of bar.tempoChanges ?? []) {
    const at = c.at * bar.ticks
    if (at >= tick) break
    s += ((at - from) / TICKS_PER_QUARTER) * (60 / bpm)
    from = at
    bpm = c.bpm
  }
  return s + ((tick - from) / TICKS_PER_QUARTER) * (60 / bpm)
}

export interface TabScore {
  title: string
  artist: string
  /** Tempo at the start, quarter notes per minute. */
  tempo: number
  bars: TabBar[]
  tracks: TabTrack[]
}

/**
 * Beats of a bar as the beat tracker counts them: quarter notes, or dotted quarters in compound meters
 * (6/8, 9/8, 12/8). Fractional for odd bars such as 7/8.
 */
export function barBeats(bar: TabBar): { count: number; ticks: number } {
  const compound = bar.den === 8 && bar.num % 3 === 0 && bar.num > 3
  const ticks = compound ? (TICKS_PER_QUARTER * 3) / 2 : TICKS_PER_QUARTER
  return { count: bar.ticks / ticks, ticks }
}

/** The track to show first: the pitched track with the most notes, guitars (six strings or more) first. */
export function mainTrack(score: TabScore): number {
  let best = 0
  let bestKey = -1
  score.tracks.forEach((t, i) => {
    if (t.percussion) return
    const notes = t.bars.reduce((a, bar) => a + bar.reduce((b, beat) => b + beat.notes.length, 0), 0)
    const key = (t.tuning.length >= 6 ? 1e9 : 0) + notes
    if (key > bestKey) [best, bestKey] = [i, key]
  })
  return best
}
