import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_NOTE_PARAMS, type NoteParams } from './basicPitch'
import type { NoteJob, NoteJobResult } from './noteWorker'
import { SOURCE_RANGE, type NoteSource, type NoteTrack, type TNote } from './types'
import type { LoadedStem } from '../stems/useStems'

export type SourceStatus = { kind: 'running'; fraction: number } | { kind: 'error'; message: string }

const MODEL_RATE = 22050

interface Posteriors {
  note: Float32Array
  onset: Float32Array
  frames: number
}

async function toModelInput(buffer: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * MODEL_RATE), MODEL_RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer })
  src.connect(ctx.destination) // stereo → mono as the mean, like librosa.load(mono=True)
  src.start()
  return (await ctx.startRendering()).getChannelData(0)
}

const cleanError = (err: unknown) => String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

interface Args {
  buffer: AudioBuffer | null
  stems: LoadedStem[] | null
  tracks: NoteTrack[]
  onTracks: (fn: (tracks: NoteTrack[]) => NoteTrack[]) => void
}

/** Transcribes sources to notes on demand; keeps model activations so detection settings re-apply instantly. */
export function useTranscription({ buffer, stems, tracks, onTracks }: Args) {
  const api = typeof window !== 'undefined' ? window.api?.notes : undefined
  const [status, setStatus] = useState<Partial<Record<NoteSource, SourceStatus>>>({})
  const cache = useRef(new Map<NoteSource, Posteriors>())
  const worker = useRef<Worker | null>(null)
  const jobs = useRef(new Map<number, (r: NoteJobResult) => void>())
  const jobId = useRef(0)
  const running = useRef<NoteSource | null>(null)

  useEffect(() => {
    const w = new Worker(new URL('./noteWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (e: MessageEvent<NoteJobResult>) => {
      jobs.current.get(e.data.id)?.(e.data)
      jobs.current.delete(e.data.id)
    }
    worker.current = w
    return () => w.terminate()
  }, [])

  // A new song invalidates everything cached.
  useEffect(() => {
    cache.current.clear()
    setStatus({})
  }, [buffer])

  useEffect(
    () =>
      api?.onProgress((fraction) => {
        const s = running.current
        if (s) setStatus((st) => ({ ...st, [s]: { kind: 'running', fraction } }))
      }),
    [api],
  )

  const extract = useCallback(
    (p: Posteriors, params: NoteParams): Promise<TNote[]> =>
      new Promise((resolve, reject) => {
        if (!worker.current || !buffer) return reject(new Error('Not ready'))
        const id = ++jobId.current
        jobs.current.set(id, (r) => (r.type === 'done' ? resolve(r.notes) : reject(new Error(r.message))))
        const job: NoteJob = { id, note: p.note, onset: p.onset, frames: p.frames, params, sampleRate: buffer.sampleRate }
        worker.current.postMessage(job)
      }),
    [buffer],
  )

  const sourceBuffer = useCallback(
    (source: NoteSource): AudioBuffer | null => (source === 'mix' ? buffer : (stems?.find((s) => s.name === source)?.buffer ?? null)),
    [buffer, stems],
  )

  const transcribe = useCallback(
    async (source: NoteSource, override?: NoteParams) => {
      const audio = sourceBuffer(source)
      if (!api || !audio || running.current) return
      running.current = source
      setStatus((st) => ({ ...st, [source]: { kind: 'running', fraction: 0 } }))
      const forBuffer = buffer
      try {
        const mono = await toModelInput(audio)
        const p = await api.transcribe(mono)
        if (forBuffer !== buffer) return
        cache.current.set(source, p)
        const existing = tracks.find((t) => t.source === source)
        const [minMidi, maxMidi] = SOURCE_RANGE[source]
        const params = override ?? existing?.params ?? { ...DEFAULT_NOTE_PARAMS, minMidi, maxMidi }
        const notes = await extract(p, params)
        onTracks((ts) => [...ts.filter((t) => t.source !== source), { source, notes, params, visible: true, play: existing?.play ?? false, edited: false }])
        setStatus(({ [source]: _, ...rest }) => rest)
      } catch (err) {
        setStatus((st) => ({ ...st, [source]: { kind: 'error', message: cleanError(err) } }))
      } finally {
        running.current = null
      }
    },
    [api, buffer, tracks, sourceBuffer, extract, onTracks],
  )

  /** New detection settings: re-extract from cached activations, or re-run the model if they're gone (after a restart). */
  const setParams = useCallback(
    async (source: NoteSource, params: NoteParams) => {
      onTracks((ts) => ts.map((t) => (t.source === source ? { ...t, params } : t)))
      const p = cache.current.get(source)
      if (!p) return void transcribe(source, params)
      try {
        const notes = await extract(p, params)
        onTracks((ts) => ts.map((t) => (t.source === source ? { ...t, notes, params, edited: false } : t)))
      } catch (err) {
        setStatus((st) => ({ ...st, [source]: { kind: 'error', message: cleanError(err) } }))
      }
    },
    [extract, onTracks, transcribe],
  )

  return { available: !!api, status, transcribe, setParams, hasActivations: (s: NoteSource) => cache.current.has(s) }
}

export type TranscriptionController = ReturnType<typeof useTranscription>
