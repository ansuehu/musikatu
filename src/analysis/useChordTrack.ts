import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChordSegment, Vocabulary } from './chordTimeline'
import type { ChordJob, ChordJobMessage } from './chordWorker'
import type { LoadedStem } from '../stems/useStems'
import type { BeatGrid } from '../rhythm/grid'
import type { NoteSet } from './noteHarmony'

export type ChordSource = 'mix' | 'instruments'

/** A song's chord chart, saved with the project. */
export interface ChordTrack {
  segments: ChordSegment[]
  vocabulary: Vocabulary
  source: ChordSource
  /** True once the user has corrected a chord; then we never overwrite it automatically. */
  edited: boolean
  /** Changes were moved to the nearest beat after decoding (charts made before beat-synchronous decoding). */
  snapped?: boolean
  /** Decoded one chord per beat on the song's beat grid, so every change lands on a beat. */
  beatSynced?: boolean
  /** Key of the transcribed notes the chart was read from, if any. */
  notesKey?: string
}

export type ChordStatus = { kind: 'idle' } | { kind: 'running'; fraction: number } | { kind: 'error'; message: string }

/** Stems that carry harmony; vocals and drums only confuse a chord chart. */
const HARMONIC_STEMS = new Set(['bass', 'guitar', 'piano', 'other'])

/** Average of the buffers, all channels. */
export function monoOf(buffers: AudioBuffer[]): Float32Array {
  const out = new Float32Array(buffers[0].length)
  for (const b of buffers) {
    const n = b.numberOfChannels
    for (let c = 0; c < n; c++) {
      const data = b.getChannelData(c)
      for (let i = 0; i < out.length; i++) out[i] += data[i] / n
    }
  }
  return out
}

interface Args {
  buffer: AudioBuffer | null
  stems: LoadedStem[] | null
  track: ChordTrack | null
  onTrack: (t: ChordTrack) => void
  a4: number
  /** Beat grid, once known: the chart is then decoded on the beats (and redone when the grid changes). */
  grid: BeatGrid | null
  /** Transcribed notes to read the harmony from as well (redone when they change). */
  notes: NoteSet | null
}

/** Runs whole-song chord analysis in a worker; auto-runs for new songs and upgrades to stems when they arrive. */
export function useChordTrack({ buffer, stems, track, onTrack, a4, grid, notes }: Args) {
  const [status, setStatus] = useState<ChordStatus>({ kind: 'idle' })
  const worker = useRef<Worker | null>(null)
  const jobId = useRef(0)
  const gridRef = useRef(grid)
  gridRef.current = grid
  const notesRef = useRef(notes)
  notesRef.current = notes
  /** The grid the current chart was decoded on (null: none yet for this song). */
  const usedGrid = useRef<BeatGrid | null>(null)

  useEffect(() => () => worker.current?.terminate(), [])

  const run = useCallback(
    (source: ChordSource, vocabulary: Vocabulary) => {
      if (!buffer) return
      const useStems = source === 'instruments' && !!stems
      const mono = useStems ? monoOf(stems.filter((s) => HARMONIC_STEMS.has(s.name)).map((s) => s.buffer)) : monoOf([buffer])
      worker.current?.terminate()
      const w = new Worker(new URL('./chordWorker.ts', import.meta.url), { type: 'module' })
      worker.current = w
      const id = ++jobId.current
      const g = gridRef.current
      const ns = notesRef.current
      setStatus({ kind: 'running', fraction: 0 })
      w.onmessage = (e: MessageEvent<ChordJobMessage>) => {
        const m = e.data
        if (m.id !== jobId.current) return
        if (m.type === 'progress') setStatus({ kind: 'running', fraction: m.fraction })
        else if (m.type === 'error') setStatus({ kind: 'error', message: m.message })
        else {
          setStatus({ kind: 'idle' })
          usedGrid.current = g
          onTrack({ segments: m.segments, vocabulary, source: useStems ? 'instruments' : 'mix', edited: false, beatSynced: !!g, notesKey: ns?.key })
          w.terminate()
          if (worker.current === w) worker.current = null
          // the beats arrived while this ran without them: chart again on the beats
          if (gridRef.current !== g || notesRef.current?.key !== ns?.key) runRef.current(useStems ? 'instruments' : 'mix', vocabulary)
        }
      }
      w.onerror = (e) => setStatus({ kind: 'error', message: e.message || 'Chord analysis failed' })
      const beatOptions = g ? { beats: g.beats, downbeats: g.downbeats } : {}
      const job: ChordJob = { id, mono, sampleRate: buffer.sampleRate, options: { vocabulary, a4, ...beatOptions, ...(ns ? { notes: ns.notes } : {}) } }
      w.postMessage(job, [mono.buffer])
    },
    [buffer, stems, onTrack, a4],
  )

  // New song: drop any analysis still running for the previous one, and chart this one
  // straight away unless the project already has a chart (it takes about a second).
  // Keyed on the buffer alone on purpose: `run` changes identity whenever stems or a4 do.
  const runRef = useRef(run)
  runRef.current = run
  const latest = useRef({ track, stems, status })
  latest.current = { track, stems, status }
  useEffect(() => {
    worker.current?.terminate()
    worker.current = null
    jobId.current++
    usedGrid.current = null
    setStatus({ kind: 'idle' })
    if (buffer && !latest.current.track) runRef.current(latest.current.stems ? 'instruments' : 'mix', 'standard')
  }, [buffer])

  // Stems just became available: redo an untouched mix-based chart from the cleaner instruments-only signal.
  useEffect(() => {
    const { track, status } = latest.current
    if (stems && track && !track.edited && track.source === 'mix' && status.kind === 'idle') runRef.current('instruments', track.vocabulary)
  }, [stems])

  // The beat grid arrived or changed: redo an untouched chart on the beats. A beat-synced chart loaded with
  // its project already follows that project's grid.
  useEffect(() => {
    const { track, status } = latest.current
    if (!grid || !track || track.edited || status.kind === 'running') return
    if (track.beatSynced && (usedGrid.current === null || usedGrid.current === grid)) {
      usedGrid.current = grid
      return
    }
    runRef.current(track.source, track.vocabulary)
  }, [grid])

  // Notes were transcribed, re-detected or edited: redo an untouched chart with them (after a pause, so
  // editing notes one by one doesn't restart the analysis each time).
  const notesKey = notes?.key
  useEffect(() => {
    const { track } = latest.current
    if (!track || track.edited || (track.notesKey ?? undefined) === notesKey) return
    const t = setTimeout(() => {
      const { track, status } = latest.current
      if (track && !track.edited && status.kind !== 'running') runRef.current(track.source, track.vocabulary)
    }, 800)
    return () => clearTimeout(t)
  }, [notesKey])

  return { status, run }
}
