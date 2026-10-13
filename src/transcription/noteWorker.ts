import { extractNotes, frameTime, type NoteParams } from './basicPitch.ts'
import type { TNote } from './types.ts'

export interface NoteJob {
  id: number
  note: Float32Array
  onset: Float32Array
  frames: number
  params: NoteParams
  /** Converts model seconds to song samples. */
  sampleRate: number
}

export type NoteJobResult = { id: number; type: 'done'; notes: TNote[] } | { id: number; type: 'error'; message: string }

// Typed as a Worker so postMessage has the worker-side signature without pulling in the WebWorker lib.
const scope = self as unknown as Worker

scope.onmessage = (e: MessageEvent<NoteJob>) => {
  const { id, note, onset, frames, params, sampleRate } = e.data
  try {
    const notes: TNote[] = extractNotes(note, onset, frames, params)
      .map((n) => ({
        start: Math.max(0, Math.round(frameTime(n.start) * sampleRate)),
        end: Math.round(frameTime(n.end) * sampleRate),
        midi: n.midi,
        velocity: Math.max(1, Math.min(127, Math.round(127 * n.amplitude))),
      }))
      .sort((a, b) => a.start - b.start || a.midi - b.midi)
    scope.postMessage({ id, type: 'done', notes } satisfies NoteJobResult)
  } catch (err) {
    scope.postMessage({ id, type: 'error', message: String(err instanceof Error ? err.message : err) } satisfies NoteJobResult)
  }
}
