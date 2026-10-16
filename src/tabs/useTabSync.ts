import { useCallback, useEffect, useRef, useState } from 'react'
import { monoOf } from '../analysis/useChordTrack'
import type { LoadedStem } from '../stems/useStems'
import type { BeatGrid } from '../rhythm/grid'
import type { TabScore } from './model'
import type { TabAnchor, TabSync } from './sync'
import { TAB_CMD, type TabJob, type TabJobMessage } from './tabWorkerProtocol'

/** A song's tab, saved with the project. */
export interface TabProject {
  /** File name. */
  name: string
  /** The tab file itself (base64), so the project doesn't depend on where it was. */
  data: string
  /** Track shown in the panel (-1: not chosen yet, the main one is shown). */
  track: number
  /** Bars placed by hand. */
  anchors: TabAnchor[]
  sync: TabSync | null
  /** The beat grid the sync was made on: it is redone when the grid changes. */
  gridKey: string
}

export type TabStatus = { kind: 'idle' } | { kind: 'running'; what: 'reading' | 'syncing'; fraction: number } | { kind: 'error'; message: string }

/** Accepted tab files. */
export const TAB_EXTENSIONS = ['.gp', '.gp3', '.gp4', '.gp5', '.gpx', '.musicxml', '.xml', '.mxl', '.atex', '.tex']

/** Stems the sync listens to: they carry the harmony a guitar tab describes. */
const SYNC_STEMS = new Set(['guitar', 'bass'])

/** A job without its id (one per kind of job). */
type JobInput = { [K in TabJob['type']]: Omit<Extract<TabJob, { type: K }>, 'id' | 'cmd'> }[TabJob['type']]

const gridKeyOf = (g: BeatGrid) => `${g.beats.length}:${g.beats[0]}:${g.beats[g.beats.length - 1]}:${g.downbeats.length}`

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

interface Args {
  project: TabProject | null
  onProject: (p: TabProject | null | ((p: TabProject | null) => TabProject | null)) => void
  buffer: AudioBuffer | null
  stems: LoadedStem[] | null
  grid: BeatGrid | null
  a4: number
}

/** Reads tab files and lines them up with the song in a worker; redoes the sync when its inputs change. */
export function useTabSync({ project, onProject, buffer, stems, grid, a4 }: Args) {
  const [score, setScore] = useState<TabScore | null>(null)
  const [status, setStatus] = useState<TabStatus>({ kind: 'idle' })
  const worker = useRef<Worker | null>(null)
  const jobId = useRef(0)
  const latest = useRef({ buffer, stems, grid, a4, score })
  latest.current = { buffer, stems, grid, a4, score }

  useEffect(() => () => worker.current?.terminate(), [])

  /** Runs one job in a fresh worker (a new job cancels the one before). */
  const start = useCallback((job: JobInput, transfer: Transferable[], onDone: (m: TabJobMessage) => void) => {
    worker.current?.terminate()
    const w = new Worker(new URL('./tabWorker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    const id = ++jobId.current
    w.onmessage = (e: MessageEvent<TabJobMessage>) => {
      const m = e.data
      if (m.id !== jobId.current) return
      if (m.type === 'progress') return setStatus((s) => (s.kind === 'running' ? { ...s, fraction: m.fraction } : s))
      w.terminate()
      if (worker.current === w) worker.current = null
      if (m.type === 'error') setStatus({ kind: 'error', message: m.message })
      else {
        setStatus({ kind: 'idle' })
        onDone(m)
      }
    }
    w.onerror = (e) => setStatus({ kind: 'error', message: e.message || 'The tab worker failed' })
    w.postMessage({ ...job, id, cmd: TAB_CMD } as TabJob, transfer)
  }, [])

  const sync = useCallback(
    (anchors: TabAnchor[]) => {
      const { buffer, stems, grid, a4, score } = latest.current
      if (!buffer || !grid || !score) return
      const parts = stems?.filter((s) => SYNC_STEMS.has(s.name))
      const mono = monoOf(parts?.length ? parts.map((s) => s.buffer) : [buffer])
      setStatus({ kind: 'running', what: 'syncing', fraction: 0 })
      const key = gridKeyOf(grid)
      start({ type: 'sync', score, mono, sampleRate: buffer.sampleRate, a4, beats: grid.beats, downbeats: grid.downbeats, anchors }, [mono.buffer], (m) => {
        if (m.type === 'synced') onProject((p) => (p ? { ...p, anchors, sync: m.sync, gridKey: key } : p))
      })
    },
    [start, onProject],
  )

  // the tab file changed (opened, or a project loaded): read it
  const dataKey = project ? `${project.name}:${project.data.length}:${project.data.slice(0, 64)}` : ''
  const dataRef = useRef(project?.data)
  dataRef.current = project?.data
  useEffect(() => {
    // whatever ran was for the previous tab or song
    worker.current?.terminate()
    worker.current = null
    jobId.current++
    setStatus({ kind: 'idle' })
    setScore(null)
    if (!dataRef.current) return
    const bytes = fromBase64(dataRef.current)
    setStatus({ kind: 'running', what: 'reading', fraction: 0 })
    start({ type: 'parse', bytes }, [bytes.buffer], (m) => m.type === 'parsed' && setScore(m.score))
  }, [dataKey, buffer, start])

  // sync when there is a tab and a beat grid but no sync for this grid yet
  const needsSync = !!score && !!grid && !!buffer && !!project && (!project.sync || project.gridKey !== gridKeyOf(grid))
  const anchorsRef = useRef(project?.anchors ?? [])
  anchorsRef.current = project?.anchors ?? []
  useEffect(() => {
    // (status is left out on purpose: a failed sync isn't retried until something changes)
    if (needsSync && status.kind !== 'running') sync(anchorsRef.current)
  }, [needsSync, sync])

  const open = useCallback(
    async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      onProject({ name: file.name, data: toBase64(bytes), track: -1, anchors: [], sync: null, gridKey: '' })
    },
    [onProject],
  )

  /** Played bar `played` starts at sample `pos`: keep it there and sync the rest around it. */
  const pin = useCallback(
    (played: number, pos: number) => {
      const anchors = [...anchorsRef.current.filter((a) => a.played !== played), { played, pos: Math.round(pos) }]
      onProject((p) => (p ? { ...p, anchors } : p))
      sync(anchors)
    },
    [onProject, sync],
  )

  const clearPins = useCallback(() => {
    onProject((p) => (p ? { ...p, anchors: [] } : p))
    sync([])
  }, [onProject, sync])

  return { score, status, open, resync: () => sync(anchorsRef.current), pin, clearPins }
}
