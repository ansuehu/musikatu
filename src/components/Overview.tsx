import { useEffect, useRef } from 'react'
import { colors, drawWave, markerColors } from '../waveform/draw'
import type { Marker } from '../project'
import type { Peaks } from '../waveform/peaks'
import type { Selection, View } from '../types'

interface Props {
  peaks: Peaks
  view: View
  /** Samples visible in the detail view. */
  viewSpan: number
  selection: Selection | null
  loopOn: boolean
  markers: Marker[]
  getPosition: () => number
  onSeek: (sample: number) => void
  onView: (v: View) => void
}

const versions = new WeakMap<object, number>()
let nextVersion = 0
const markersVersion = (m: Marker[]) => {
  let v = versions.get(m)
  if (v === undefined) versions.set(m, (v = nextVersion++))
  return v
}

/** Whole-file overview: click to seek, drag the highlighted window to scroll the detail view. */
export function Overview(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const dragOffset = useRef<number | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!
    const g = canvas.getContext('2d')!
    const cache = document.createElement('canvas')
    let cacheKey = ''
    let frameKey = ''
    let raf = 0
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
      const spp = p.peaks.length / W
      const key = `${p.peaks.id}|${W}|${H}`
      if (key !== cacheKey) {
        cache.width = W
        cache.height = H
        drawWave(cache.getContext('2d')!, p.peaks, 0, 0, W, H, 0, spp, dpr)
        cacheKey = key
      }
      const pos = p.getPosition()
      const sel = p.selection
      const fk = `${key}|${Math.round(pos / spp)}|${p.view.start}|${p.viewSpan}|${sel?.start}|${sel?.end}|${p.loopOn}|${markersVersion(p.markers)}`
      if (fk === frameKey) return
      frameKey = fk

      g.drawImage(cache, 0, 0)
      if (sel) {
        g.fillStyle = p.loopOn ? colors.loop : colors.selection
        g.fillRect(sel.start / spp, 0, Math.max(1, (sel.end - sel.start) / spp), H)
      }
      for (const m of p.markers) {
        if (m.kind === 'beat') continue
        g.fillStyle = markerColors[m.kind]
        g.globalAlpha = m.kind === 'section' ? 0.9 : 0.35
        g.fillRect(Math.round(m.pos / spp), 0, Math.max(1, Math.round(dpr)), m.kind === 'section' ? H : H * 0.25)
      }
      g.globalAlpha = 1
      const vx = p.view.start / spp
      const vw = Math.max(2, p.viewSpan / spp)
      g.fillStyle = colors.viewport
      g.fillRect(vx, 0, vw, H)
      g.strokeStyle = colors.viewportEdge
      g.lineWidth = dpr
      g.strokeRect(vx + dpr / 2, dpr / 2, vw - dpr, H - dpr)
      g.fillStyle = colors.playhead
      g.fillRect(Math.round(pos / spp), 0, Math.max(1, Math.round(1.5 * dpr)), H)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  const sampleAt = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const { peaks } = latest.current
    return Math.min(Math.max(0, ((e.clientX - rect.left) / rect.width) * peaks.length), peaks.length)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const s = sampleAt(e)
    const { view, viewSpan, onSeek, onView } = latest.current
    if (s >= view.start && s <= view.start + viewSpan) {
      dragOffset.current = s - view.start
    } else {
      onSeek(s)
      onView({ start: s - viewSpan / 2, spp: view.spp })
      dragOffset.current = viewSpan / 2
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (dragOffset.current === null) return
    const { view, onView } = latest.current
    onView({ start: sampleAt(e) - dragOffset.current, spp: view.spp })
  }

  return (
    <canvas
      className="overview"
      ref={canvasRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (dragOffset.current = null)}
      onPointerCancel={() => (dragOffset.current = null)}
    />
  )
}
