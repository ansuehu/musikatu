import { analyzeChords, type ChordSegment, type ChordTrackOptions } from './chordTimeline.ts'

export interface ChordJob {
  id: number
  mono: Float32Array
  sampleRate: number
  options: ChordTrackOptions
}

export type ChordJobMessage =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'done'; segments: ChordSegment[] }
  | { id: number; type: 'error'; message: string }

// Typed as a Worker so postMessage has the worker-side signature without pulling in the WebWorker lib.
const scope = self as unknown as Worker

scope.onmessage = (e: MessageEvent<ChordJob>) => {
  const { id, mono, sampleRate, options } = e.data
  const post = (m: ChordJobMessage) => scope.postMessage(m)
  try {
    let last = 0
    const segments = analyzeChords(mono, sampleRate, options, (fraction) => {
      if (fraction - last >= 0.05 || fraction === 1) {
        last = fraction
        post({ id, type: 'progress', fraction })
      }
    })
    post({ id, type: 'done', segments })
  } catch (err) {
    post({ id, type: 'error', message: String(err instanceof Error ? err.message : err) })
  }
}
