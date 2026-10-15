import { beatHarmony } from '../analysis/chordTimeline.ts'
import { loadTab } from './alphatab.ts'
import { regularBeats, syncTab } from './sync.ts'
import type { TabJob, TabJobMessage } from './tabWorkerProtocol.ts'

// Typed as a Worker so postMessage has the worker-side signature without pulling in the WebWorker lib.
const scope = self as unknown as Worker

scope.onmessage = (e: MessageEvent<TabJob>) => {
  const job = e.data
  const post = (m: TabJobMessage) => scope.postMessage(m)
  try {
    if (job.type === 'parse') return post({ id: job.id, type: 'parsed', score: loadTab(job.bytes) })
    const { beats, downbeats } = regularBeats(job.beats, job.downbeats)
    let last = 0
    const h = beatHarmony(job.mono, job.sampleRate, beats, { a4: job.a4 }, (f) => {
      if (f - last >= 0.05) post({ id: job.id, type: 'progress', fraction: 0.9 * (last = f) })
    })
    const sync = syncTab(job.score, { beats, audio: { chroma: h.chroma, level: h.level, bass: h.bass, downbeats }, anchors: job.anchors })
    post({ id: job.id, type: 'synced', sync })
  } catch (err) {
    post({ id: job.id, type: 'error', message: String(err instanceof Error ? err.message : err) })
  }
}
