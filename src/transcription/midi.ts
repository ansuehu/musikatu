import type { BeatGrid } from '../rhythm/grid.ts'
import type { TNote } from './types.ts'

export const TPQ = 480

export interface MidiTrackInput {
  name: string
  notes: TNote[]
  /** General MIDI program (0-based). */
  program: number
}

/** Maps song samples to MIDI ticks, plus the tempo and time-signature events that make that mapping true. */
export interface TickMap {
  toTick: (sample: number) => number
  tempos: { tick: number; usPerQuarter: number }[]
  signatures: { tick: number; num: number; den: number }[]
}

/**
 * With a beat grid: every beat is one quarter (one eighth in 6, 9, 12) and the tempo follows the
 * performance beat by beat, so bars line up in notation software and audio stays aligned in a DAW.
 * Audio time 0 is tick 0; any lead-in before the first bar becomes a short pickup measure.
 */
export function tickMap(grid: BeatGrid | null, sampleRate: number): TickMap {
  if (!grid || grid.beats.length < 2) {
    const usPerQuarter = 500000 // 120 BPM
    return {
      toTick: (s) => Math.round((s / sampleRate) * (1e6 / usPerQuarter) * TPQ),
      tempos: [{ tick: 0, usPerQuarter }],
      signatures: [{ tick: 0, num: 4, den: 4 }],
    }
  }
  const compound = grid.meter === 6 || grid.meter === 9 || grid.meter === 12
  const tpb = compound ? TPQ / 2 : TPQ // ticks per tracked beat
  const den = compound ? 8 : 4

  // Virtual beats from sample 0 up to the first tracked beat, evenly spaced, so tick 0 = audio 0.
  const first = grid.beats[0]
  const ibi0 = grid.beats[1] - grid.beats[0]
  const nVirtual = first > ibi0 * 0.25 ? Math.max(1, Math.round(first / ibi0)) : 0
  const beats: number[] = []
  for (let i = 0; i < nVirtual; i++) beats.push((first * i) / nVirtual)
  if (nVirtual === 0 && first !== 0) beats.push(0) // tiny lead-in: fold sample 0 into the first beat's span
  const lead = beats.length
  beats.push(...grid.beats.filter((b) => b > (beats[beats.length - 1] ?? -1)))

  const ticks = beats.map((_, i) => i * tpb)
  const toTick = (s: number): number => {
    if (s <= beats[0]) return 0
    let lo = 0
    let hi = beats.length - 1
    if (s >= beats[hi]) {
      const ibi = beats[hi] - beats[hi - 1]
      return Math.round(ticks[hi] + ((s - beats[hi]) / ibi) * tpb)
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (beats[mid] <= s) lo = mid
      else hi = mid
    }
    return Math.round(ticks[lo] + ((s - beats[lo]) / (beats[hi] - beats[lo])) * tpb)
  }

  const tempos: TickMap['tempos'] = []
  for (let i = 0; i < beats.length - 1; i++) {
    const seconds = (beats[i + 1] - beats[i]) / sampleRate
    // tempo is per quarter note; a compound "beat" is an eighth
    const usPerQuarter = Math.round(seconds * 1e6 * (TPQ / tpb))
    if (tempos.length === 0 || Math.abs(tempos[tempos.length - 1].usPerQuarter - usPerQuarter) > 1) tempos.push({ tick: ticks[i], usPerQuarter })
  }

  // Bars follow the grid's downbeats exactly: a pickup before the first one, and a time-signature
  // change wherever a bar has a different number of beats, so every detected bar starts a MIDI bar.
  const signatures: TickMap['signatures'] = []
  const push = (beatIndex: number, num: number) => {
    const last = signatures[signatures.length - 1]
    if (!last || last.num !== num) signatures.push({ tick: beatIndex * tpb, num, den })
  }
  const downs = grid.downbeats.map((d) => d + lead)
  if (downs.length === 0) push(0, grid.meter)
  else {
    if (downs[0] > 0) push(0, downs[0] % grid.meter || grid.meter)
    for (let k = 0; k < downs.length; k++) {
      const len = k + 1 < downs.length ? downs[k + 1] - downs[k] : grid.meter
      push(downs[k], Math.max(1, Math.min(32, len)))
    }
  }
  return { toTick, tempos, signatures }
}

// ---------- Standard MIDI File encoding ----------

function vlq(n: number): number[] {
  const bytes = [n & 0x7f]
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80)
  return bytes
}

function chunk(type: string, data: number[]): number[] {
  const len = data.length
  return [...[...type].map((c) => c.charCodeAt(0)), (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...data]
}

function text(type: number, s: string): number[] {
  const bytes = [...new TextEncoder().encode(s)]
  return [0xff, type, ...vlq(bytes.length), ...bytes]
}

type Event = { tick: number; order: number; bytes: number[] }

function trackData(events: Event[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.order - b.order)
  const out: number[] = []
  let last = 0
  for (const e of events) {
    out.push(...vlq(e.tick - last), ...e.bytes)
    last = e.tick
  }
  out.push(0, 0xff, 0x2f, 0) // end of track
  return out
}

/** Format-1 MIDI: a conductor track (tempo map, meter) and one track per instrument. */
export function writeMidi(tracks: MidiTrackInput[], grid: BeatGrid | null, sampleRate: number, title = 'Earwork transcription'): Uint8Array {
  const map = tickMap(grid, sampleRate)
  const conductor: Event[] = [{ tick: 0, order: 0, bytes: text(0x03, title) }]
  for (const t of map.tempos) conductor.push({ tick: t.tick, order: 1, bytes: [0xff, 0x51, 3, (t.usPerQuarter >> 16) & 255, (t.usPerQuarter >> 8) & 255, t.usPerQuarter & 255] })
  for (const s of map.signatures) conductor.push({ tick: s.tick, order: 2, bytes: [0xff, 0x58, 4, s.num, Math.log2(s.den), 24, 8] })

  const chunks = [chunk('MThd', [0, 1, 0, tracks.length + 1, (TPQ >> 8) & 255, TPQ & 255]), chunk('MTrk', trackData(conductor))]
  tracks.forEach((t, i) => {
    const ch = i >= 9 ? i + 1 : i // skip channel 10 (drums)
    const events: Event[] = [
      { tick: 0, order: 0, bytes: text(0x03, t.name) },
      { tick: 0, order: 1, bytes: [0xc0 | ch, t.program & 127] },
    ]
    for (const n of t.notes) {
      const on = map.toTick(n.start)
      const off = Math.max(on + 1, map.toTick(n.end))
      events.push({ tick: on, order: 3, bytes: [0x90 | ch, n.midi, n.velocity] })
      events.push({ tick: off, order: 2, bytes: [0x80 | ch, n.midi, 0] }) // note-offs first at equal ticks
    }
    chunks.push(chunk('MTrk', trackData(events)))
  })
  return Uint8Array.from(chunks.flat())
}

/** General MIDI program per source. */
export const GM_PROGRAM: Record<string, number> = { bass: 33, guitar: 25, piano: 0, vocals: 52, other: 48, mix: 0, drums: 0 }
