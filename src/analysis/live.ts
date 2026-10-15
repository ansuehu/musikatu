import { useEffect, useRef, useSyncExternalStore } from 'react'
import { SpectrumAnalyzer } from './spectrum'
import { estimateNotes, type NoteEstimate } from './notes'
import type { ChannelMode } from '../dsp/ChannelMixer'
import type { Peaks } from '../waveform/peaks'

/**
 * Live analysis at the playhead, shared by every panel that shows it (keyboard & spectrum, chord guess,
 * guitar) wherever the layout puts them. One analyser runs for the whole app; panels subscribe.
 */
export interface LiveAnalysis {
  mags: Float32Array | null
  est: NoteEstimate | null
  /** Frequency of one analyser bin as heard (includes the pitch shift). */
  binHz: number
  /** Bumped on every new analysis, so canvases know when to redraw. */
  version: number
}

function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (v: T) => {
      value = v
      for (const l of listeners) l()
    },
    subscribe: (l: () => void) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
  }
}

export const liveAnalysis = createStore<LiveAnalysis>({ mags: null, est: null, binHz: 1, version: 0 })
/** The key under the pointer on the on-screen keyboard (for the chord guess panel's hint). */
export const hoverKey = createStore<number | null>(null)

export const useLiveEstimate = () => useSyncExternalStore(liveAnalysis.subscribe, () => liveAnalysis.get().est)
export const useHoverKey = () => useSyncExternalStore(hoverKey.subscribe, hoverKey.get)

const ANALYSIS_INTERVAL_MS = 33

interface Args {
  enabled: boolean
  peaks: Peaks | null
  sampleRate: number
  getPosition: () => number
  pitchRatio: number
  channelMode: ChannelMode
  /** EQ magnitude per analyser bin, or null when flat. */
  eqWeights: Float32Array | null
  /** When stems are playing: the audible sources and their gains, so analysis follows what you hear. */
  layers: { id: string; channels: Float32Array[]; gain: number }[] | null
  a4: number
}

const ids = new WeakMap<object, number>()
let nextId = 1
const idOf = (o: object | null) => {
  if (!o) return 0
  let id = ids.get(o)
  if (!id) ids.set(o, (id = nextId++))
  return id
}

/** Runs the analyser (≤30×/s, and only when its inputs changed) and publishes into `liveAnalysis`. */
export function useLiveAnalysis(args: Args): void {
  const latest = useRef(args)
  latest.current = args

  useEffect(() => {
    const analyzer = new SpectrumAnalyzer(16384)
    let raf = 0
    let last = 0
    let key = ''
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const p = latest.current
      if (!p.enabled) return
      if (!p.peaks) {
        if (liveAnalysis.get().mags) liveAnalysis.set({ mags: null, est: null, binHz: 1, version: liveAnalysis.get().version + 1 })
        key = ''
        return
      }
      if (now - last < ANALYSIS_INTERVAL_MS) return
      const pos = p.getPosition()
      const k = `${p.peaks.id}|${Math.round(pos / 256)}|${p.channelMode}|${p.pitchRatio}|${p.a4}|${idOf(p.eqWeights)}|${p.layers?.map((l) => `${l.id}:${l.gain.toFixed(3)}`).join(',') ?? 'mix'}`
      if (k === key) return
      key = k
      last = now
      const sr = p.sampleRate
      let mags: Float32Array
      if (p.layers) {
        // mix just the analysis window from the audible stems
        const N = analyzer.size
        const start = Math.round(pos) - N / 2
        const L = new Float32Array(N)
        const R = new Float32Array(N)
        for (const { channels, gain } of p.layers) {
          const cl = channels[0]
          const cr = channels[1] ?? cl
          const a = Math.max(0, -start)
          const b = Math.min(N, cl.length - start)
          for (let i = a; i < b; i++) {
            L[i] += gain * cl[start + i]
            R[i] += gain * cr[start + i]
          }
        }
        mags = analyzer.analyze([L, R], N / 2, p.channelMode, sr, p.eqWeights)
      } else {
        mags = analyzer.analyze(p.peaks.channels, pos, p.channelMode, sr, p.eqWeights)
      }
      const binHz = (sr / analyzer.size) * p.pitchRatio
      // the analyser reuses its buffer: hand subscribers a copy
      liveAnalysis.set({ mags: mags.slice(), est: estimateNotes(mags, binHz, p.a4), binHz, version: liveAnalysis.get().version + 1 })
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])
}
