import { useCallback, useEffect, useRef, useState } from 'react'
import { buildGrid, type BeatGrid } from './grid'

export type GridStatus = { kind: 'idle' } | { kind: 'running'; fraction: number } | { kind: 'error'; message: string } | { kind: 'unavailable' }

const MODEL_RATE = 22050

/** Mono 22.05 kHz, downmixed as the arithmetic mean (what the model was trained on). */
async function toModelInput(buffer: AudioBuffer): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buffer.duration * MODEL_RATE), MODEL_RATE)
  const src = new AudioBufferSourceNode(ctx, { buffer })
  src.connect(ctx.destination) // Web Audio's stereo→mono down-mix is 0.5·(L+R)
  src.start()
  return (await ctx.startRendering()).getChannelData(0)
}

interface Args {
  buffer: AudioBuffer | null
  grid: BeatGrid | null
  onGrid: (g: BeatGrid) => void
}

/** Tracks beats and downbeats for each new song (a few seconds, in the background process). */
export function useBeatGrid({ buffer, grid, onGrid }: Args) {
  const api = typeof window !== 'undefined' ? window.api?.beats : undefined
  const [status, setStatus] = useState<GridStatus>(api ? { kind: 'idle' } : { kind: 'unavailable' })
  const job = useRef(0)

  useEffect(() => api?.onProgress((fraction) => setStatus((s) => (s.kind === 'running' ? { kind: 'running', fraction } : s))), [api])

  const run = useCallback(async () => {
    if (!api || !buffer) return
    const my = ++job.current
    setStatus({ kind: 'running', fraction: 0 })
    try {
      const mono = await toModelInput(buffer)
      const r = await api.track(mono)
      if (my !== job.current) return
      onGrid(buildGrid(r.beats, r.downbeats, buffer.sampleRate))
      setStatus({ kind: 'idle' })
    } catch (err) {
      if (my !== job.current) return
      setStatus({ kind: 'error', message: String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    }
  }, [api, buffer, onGrid])

  const latest = useRef({ grid, run })
  latest.current = { grid, run }
  // New song: track it unless the project already has a grid.
  useEffect(() => {
    job.current++
    if (api) setStatus({ kind: 'idle' })
    if (buffer && !latest.current.grid) void latest.current.run()
  }, [buffer, api])

  return { status, run }
}
