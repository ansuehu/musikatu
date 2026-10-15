import type { NoteParams } from './basicPitch.ts'
import { STEM_COLORS, STEM_LABELS, type StemName } from '../stems/types.ts'

export type NoteSource = 'mix' | StemName

/** A transcribed note; positions in samples of the song buffer. */
export interface TNote {
  start: number
  end: number
  midi: number
  /** 1..127 */
  velocity: number
}

/** The notes transcribed from one source (the full mix or a stem). */
export interface NoteTrack {
  source: NoteSource
  notes: TNote[]
  params: NoteParams
  visible: boolean
  /** Play the notes with a synth alongside the recording. */
  play: boolean
  /** Hand-corrected: changing the detection settings would discard the edits. */
  edited: boolean
}

export const SOURCE_LABEL = (s: NoteSource) => (s === 'mix' ? 'Full mix' : STEM_LABELS[s])
export const SOURCE_COLOR = (s: NoteSource) => (s === 'mix' ? '#dde2ec' : STEM_COLORS[s])

/** Sensible detection ranges per instrument (MIDI numbers), applied when a stem is first transcribed. */
export const SOURCE_RANGE: Record<NoteSource, [number, number]> = {
  mix: [21, 108],
  bass: [24, 67], // C1..G4
  guitar: [40, 88], // E2..E6
  piano: [21, 108],
  vocals: [40, 84], // E2..C6
  other: [21, 108],
  drums: [21, 108],
}
