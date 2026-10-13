import { useEffect, useRef } from 'react'
import type { View } from '../types'
import { medianBeatSpacing, type BeatGrid } from '../rhythm/grid'
import { noteName, type Spelling } from '../analysis/notes'
import { SOURCE_COLOR, type NoteSource, type NoteTrack } from '../transcription/types'
import { colors } from '../waveform/draw'

export type NoteKey = `${NoteSource}:${number}`
export const noteKey = (source: NoteSource, index: number): NoteKey => `${source}:${index}`

interface Props {
  tracks: NoteTrack[]
  view: View
  grid: BeatGrid | null
  getPosition: () => number
  selected: Set<NoteKey>
  transpose: number
  spelling: Spelling
  onView: (v: View) => void
  onSeek: (sample: number) => void
  onSelect: (keys: Set<NoteKey>) => void
  onPlayNote: (midi: number) => void
}

const BLACK = new Set([1, 3, 6, 8, 10])
const LABEL_W = 30

/** Notes over time, aligned with the waveform above (same view), coloured per source. */
export function PianoRoll(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props

  // Pitch range: fit the visible notes with a little air, at least two octaves.
  const rangeOf = (tracks: NoteTrack[]): [number, number] => {
    let lo = 128
    let hi = -1
    for (const t of tracks) for (const n of t.notes) if (t.visible) {
      if (n.midi < lo) lo = n.midi
      if (n.midi > hi) hi = n.midi
    }
    if (hi < 0) return [48, 72]
    lo -= 2
    hi += 2
    if (hi - lo < 24) {
      const c = (lo + hi) / 2
      lo = Math.round(c - 12)
      hi = lo + 24
    }
    return [Math.max(0, lo), Math.min(127, hi)]
  }

  useEffect(() => {
    const canvas = canvasRef.current!
    const g = canvas.getContext('2d')!
    const cache = document.createElement('canvas')
    let cacheKey = ''
    let frameKey = ''
    let raf = 0
    let trackVersion = 0
    let lastTracks: NoteTrack[] | null = null
    let lastGrid: BeatGrid | null = null
    let gridVersion = 0
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
    })
    ro.observe(canvas)

    const frame = () => {
      raf = requestAnimationFrame(frame)
      const p = latest.current
      const W = canvas.width
      const H = canvas.height
      if (!W || !H) return
      const dpr = W / canvas.clientWidth
      const { start, spp } = p.view
      const sppDev = spp / dpr
      if (!Number.isFinite(sppDev)) return
      if (p.tracks !== lastTracks) {
        lastTracks = p.tracks
        trackVersion++
      }
      if (p.grid !== lastGrid) {
        lastGrid = p.grid
        gridVersion++
      }
      const [lo, hi] = rangeOf(p.tracks)
      const rows = hi - lo + 1
      const rowH = H / rows
      const yOf = (midi: number) => H - (midi - lo + 1) * rowH
      const xOf = (s: number) => (s - start) / sppDev
      const end = start + W * sppDev

      const key = `${start}|${spp}|${W}|${H}|${trackVersion}|${gridVersion}|${[...p.selected].join(',')}|${p.transpose}|${p.spelling}`
      if (key !== cacheKey) {
        cache.width = W
        cache.height = H
        const c = cache.getContext('2d')!
        c.fillStyle = '#0e1117'
        c.fillRect(0, 0, W, H)
        // key rows
        for (let m = lo; m <= hi; m++) {
          if (BLACK.has(m % 12)) {
            c.fillStyle = '#0a0c11'
            c.fillRect(0, yOf(m), W, rowH)
          }
          if (m % 12 === 0) {
            c.fillStyle = '#1d2230'
            c.fillRect(0, Math.round(yOf(m) + rowH) - 1, W, Math.max(1, Math.round(dpr)))
          }
        }
        // bar / beat lines
        if (p.grid) {
          const beatPx = medianBeatSpacing(p.grid) / sppDev
          if (beatPx > 6 * dpr) {
            c.fillStyle = colors.gridBeat
            for (const b of p.grid.beats) if (b >= start && b <= end) c.fillRect(Math.round(xOf(b)), 0, 1, H)
          }
          c.fillStyle = colors.gridBar
          for (const d of p.grid.downbeats) {
            const b = p.grid.beats[d]
            if (b >= start && b <= end) c.fillRect(Math.round(xOf(b)), 0, Math.max(1, Math.round(dpr)), H)
          }
        }
        // notes
        const r = Math.min(3 * dpr, rowH / 3)
        for (const t of p.tracks) {
          if (!t.visible) continue
          const color = SOURCE_COLOR(t.source)
          t.notes.forEach((n, i) => {
            if (n.end < start || n.start > end) return
            const x0 = xOf(n.start)
            const w = Math.max(2 * dpr, xOf(n.end) - x0)
            const y = yOf(n.midi) + 1
            const h = Math.max(2, rowH - 2)
            c.globalAlpha = 0.45 + 0.55 * (n.velocity / 127)
            c.fillStyle = color
            c.beginPath()
            c.roundRect(x0, y, w, h, r)
            c.fill()
            c.globalAlpha = 1
            if (p.selected.has(noteKey(t.source, i))) {
              c.strokeStyle = '#ffffff'
              c.lineWidth = Math.max(1.5, 1.5 * dpr)
              c.stroke()
            }
          })
        }
        // note names on the left
        c.fillStyle = 'rgba(14, 17, 23, 0.82)'
        c.fillRect(0, 0, LABEL_W * dpr, H)
        const step = rowH >= 9 * dpr ? 1 : 12 // every white key when there's room, else only the Cs
        c.font = `${step === 1 ? Math.min(10 * dpr, rowH * 0.9) : 9 * dpr}px Inter, system-ui, sans-serif`
        c.textBaseline = 'middle'
        for (let m = lo; m <= hi; m++) {
          if (step === 12 && m % 12 !== 0) continue
          if (step === 1 && BLACK.has(m % 12)) continue
          c.fillStyle = m % 12 === 0 ? '#9aa6c0' : '#5a6378'
          c.fillText(noteName(m, p.transpose, p.spelling), 3 * dpr, yOf(m) + rowH / 2)
        }
        cacheKey = key
      }

      const pos = p.getPosition()
      const fk = `${key}|${pos}`
      if (fk === frameKey) return
      frameKey = fk
      g.drawImage(cache, 0, 0)
      // sounding notes glow
      g.shadowColor = '#ffffff'
      g.shadowBlur = 8 * dpr
      for (const t of p.tracks) {
        if (!t.visible) continue
        g.fillStyle = SOURCE_COLOR(t.source)
        for (const n of t.notes) {
          if (n.start > pos) break // notes are sorted by start
          if (n.end <= pos) continue
          const x0 = xOf(n.start)
          g.fillRect(x0, yOf(n.midi) + 1, Math.max(2 * dpr, xOf(n.end) - x0), Math.max(2, rowH - 2))
        }
      }
      g.shadowBlur = 0
      const px = xOf(pos)
      if (px >= 0 && px <= W) {
        g.fillStyle = colors.playhead
        const lw = Math.max(1, Math.round(1.5 * dpr))
        g.fillRect(Math.round(px - lw / 2), 0, lw, H)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // Wheel behaves like the waveform: zoom around the cursor, shift/horizontal to scroll.
  useEffect(() => {
    const canvas = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = latest.current
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      const x = e.clientX - canvas.getBoundingClientRect().left
      if ((e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) && !e.ctrlKey) {
        const d = (e.shiftKey ? e.deltaY || e.deltaX : e.deltaX) * unit
        p.onView({ start: p.view.start + d * p.view.spp, spp: p.view.spp })
      } else {
        const anchor = p.view.start + x * p.view.spp
        const spp = p.view.spp * Math.exp(e.deltaY * unit * 0.002)
        p.onView({ start: anchor - x * spp, spp })
      }
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [])

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const p = latest.current
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const sample = p.view.start + x * p.view.spp
    const [lo, hi] = rangeOf(p.tracks)
    const midi = lo + Math.floor(((rect.height - y) / rect.height) * (hi - lo + 1))
    // topmost visible track wins (later tracks are drawn on top)
    for (const t of [...p.tracks].reverse()) {
      if (!t.visible) continue
      const i = t.notes.findIndex((n) => n.midi === midi && n.start <= sample && n.end >= sample)
      if (i >= 0) {
        const k = noteKey(t.source, i)
        const next = new Set(e.shiftKey ? p.selected : [])
        if (e.shiftKey && next.has(k)) next.delete(k)
        else next.add(k)
        p.onSelect(next)
        p.onPlayNote(midi)
        return
      }
    }
    if (!e.shiftKey) p.onSelect(new Set())
    p.onSeek(Math.max(0, sample))
  }

  return <canvas ref={canvasRef} className="piano-roll" onPointerDown={onPointerDown} />
}
