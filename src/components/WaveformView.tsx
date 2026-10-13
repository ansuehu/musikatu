import { useEffect, useRef } from 'react'
import { colors, drawRuler, drawWave, markerColors } from '../waveform/draw'
import type { Peaks } from '../waveform/peaks'
import type { Selection, View } from '../types'
import { measureNumbers, type Marker } from '../project'
import { segmentAt, type ChordSegment } from '../analysis/chordTimeline'
import { medianBeatSpacing, type BeatGrid } from '../rhythm/grid'

const gridIds = new WeakMap<object, number>()
let nextGridId = 1
const gridId = (g: BeatGrid | null) => {
  if (!g) return 0
  let id = gridIds.get(g)
  if (!id) gridIds.set(g, (id = nextGridId++))
  return id
}

/** Chord chart shown in a lane under the ruler; `labels` are display names per segment. */
export interface ChordLane {
  segments: ChordSegment[]
  labels: string[]
  /** Changes whenever segments or labels do (cache key). */
  version: string
  /** Shown in the lane while there is no chart yet. */
  placeholder?: string
}

interface Props {
  peaks: Peaks
  view: View
  selection: Selection | null
  loopOn: boolean
  playing: boolean
  follow: boolean
  markers: Marker[]
  selectedMarker: string | null
  getPosition: () => number
  onView: (v: View) => void
  onSeek: (sample: number) => void
  onSelect: (sel: Selection, final: boolean) => void
  onSelectBetweenMarkers: (sample: number) => void
  onMarkerClick: (id: string) => void
  onMarkerMove: (id: string, pos: number) => void
  onMarkerEdit: (id: string) => void
  onWidth: (cssWidth: number) => void
  chordLane: ChordLane | null
  grid: BeatGrid | null
  onChordClick: (index: number) => void
  onChordDoubleClick: (index: number) => void
}

const MARKER_LANE_H = 18
const RULER_H = 22
const CHORD_LANE_H = 22
/** Marker lane + ruler. */
const TOP_H = MARKER_LANE_H + RULER_H
const HEADER_H = TOP_H + CHORD_LANE_H
const EDGE_PX = 6
const DRAG_PX = 3
const KIND_PRIORITY = { section: 0, measure: 1, beat: 2 } as const

type Drag =
  | { mode: 'pending'; anchor: number; x0: number }
  | { mode: 'select'; fixed: number }
  | { mode: 'marker'; id: string; x0: number; moved: boolean }

/** Detailed, zoomable waveform with marker lane, time ruler, selection (loop region) and playhead. */
export function WaveformView(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const drag = useRef<Drag | null>(null)

  useEffect(() => {
    const wrap = wrapRef.current!
    const canvas = canvasRef.current!
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(wrap.clientWidth * dpr)
      canvas.height = Math.round(wrap.clientHeight * dpr)
      latest.current.onWidth(wrap.clientWidth)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [])

  // Render loop: waveform is cached per view; overlays redraw only when something moved.
  useEffect(() => {
    const canvas = canvasRef.current!
    const g = canvas.getContext('2d')!
    const cache = document.createElement('canvas')
    let cacheKey = ''
    let frameKey = ''
    let lastMarkers: Marker[] | null = null
    let measures = new Map<string, number>()
    let markerVersion = 0
    let raf = 0
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const p = latest.current
      const W = canvas.width
      const H = canvas.height
      const cssW = canvas.clientWidth
      if (!W || !H || !cssW) return
      const dpr = W / cssW
      const { start, spp } = p.view
      const pos = p.getPosition()

      const span = cssW * spp
      // The view is unclamped until the parent learns our width; nothing sensible to draw yet.
      if (!Number.isFinite(span) || span > p.peaks.length * 2) return
      if (p.follow && p.playing && (pos < start || pos > start + span)) {
        p.onView({ start: pos - span * 0.02, spp })
      }

      if (p.markers !== lastMarkers) {
        lastMarkers = p.markers
        measures = measureNumbers(p.markers)
        markerVersion++
      }

      const laneH = Math.round(MARKER_LANE_H * dpr)
      const topH = Math.round(TOP_H * dpr)
      const headerH = Math.round(HEADER_H * dpr)
      const lane = p.chordLane
      const key = `${p.peaks.id}|${start}|${spp}|${W}|${H}|${lane?.version ?? ''}|${lane?.placeholder ?? ''}|${gridId(p.grid)}`
      if (key !== cacheKey) {
        cache.width = W
        cache.height = H
        const cg = cache.getContext('2d')!
        cg.fillStyle = colors.bg
        cg.fillRect(0, 0, W, H)
        cg.fillStyle = colors.ruler
        cg.fillRect(0, 0, W, laneH)
        cg.save()
        cg.translate(0, laneH)
        drawRuler(cg, W, topH - laneH, start, spp / dpr, p.peaks.sampleRate, dpr)
        cg.restore()
        drawChordLane(cg, lane, topH, headerH - topH, W, start, spp / dpr, dpr)
        drawWave(cg, p.peaks, 0, headerH, W, H - headerH, start, spp / dpr, dpr)
        if (p.grid) drawGrid(cg, p.grid, laneH, headerH, W, H, start, spp / dpr, dpr)
        cacheKey = key
      }
      const sel = p.selection
      const chordIdx = lane ? segmentAt(lane.segments, pos) : -1
      const fk = `${key}|${chordIdx}|${pos}|${sel?.start}|${sel?.end}|${p.loopOn}|${markerVersion}|${p.selectedMarker}`
      if (fk === frameKey) return
      frameKey = fk

      g.drawImage(cache, 0, 0)
      const toX = (s: number) => ((s - start) / spp) * dpr
      const px1 = Math.max(1, Math.round(dpr))

      // markers: faint full-height guides, flags in the marker lane
      g.font = `600 ${10.5 * dpr}px Inter, system-ui, sans-serif`
      g.textBaseline = 'middle'
      const sorted = [...p.markers].sort((a, b) => KIND_PRIORITY[b.kind] - KIND_PRIORITY[a.kind])
      for (const m of sorted) {
        const x = Math.round(toX(m.pos))
        if (x < -200 * dpr || x > W) continue
        const c = markerColors[m.kind]
        const selected = m.id === p.selectedMarker
        g.globalAlpha = m.kind === 'section' ? 0.85 : m.kind === 'measure' ? 0.45 : 0.22
        g.fillStyle = selected ? colors.markerSelected : c
        g.fillRect(x, laneH, px1, H - laneH)
        g.globalAlpha = 1
        if (m.kind === 'beat') {
          g.fillRect(x, laneH * 0.45, px1, laneH * 0.55)
        } else {
          const label = m.kind === 'measure' ? String(measures.get(m.id) ?? '') : m.name
          const w = g.measureText(label).width + 8 * dpr
          g.fillStyle = selected ? colors.markerSelected : c
          g.fillRect(x, 1, m.kind === 'section' ? w : Math.max(w * 0.8, 2), laneH - 2)
          g.fillStyle = m.kind === 'section' ? '#140d22' : '#0d0f13'
          g.fillText(label, x + 4 * dpr, laneH / 2 + 0.5)
        }
      }

      // current chord: outline it in the lane
      if (lane && chordIdx >= 0 && lane.segments[chordIdx].chord) {
        const seg = lane.segments[chordIdx]
        const x0 = Math.max(0, Math.round(toX(seg.start)))
        const x1 = Math.min(W, Math.round(toX(seg.end)))
        g.strokeStyle = colors.loopEdge
        g.lineWidth = Math.max(1, Math.round(1.5 * dpr))
        g.strokeRect(x0 + dpr, topH + dpr, x1 - x0 - 2 * dpr, headerH - topH - 2 * dpr)
      }

      if (sel) {
        const x0 = Math.round(toX(sel.start))
        const x1 = Math.round(toX(sel.end))
        g.fillStyle = p.loopOn ? colors.loop : colors.selection
        g.fillRect(x0, laneH, x1 - x0, H - laneH)
        g.fillStyle = p.loopOn ? colors.loopEdge : colors.selectionEdge
        g.fillRect(x0, laneH, px1, H - laneH)
        g.fillRect(x1 - px1, laneH, px1, H - laneH)
      }
      const px = toX(pos)
      if (px >= -10 && px <= W + 10) {
        g.fillStyle = colors.playhead
        const lw = Math.max(1, Math.round(1.5 * dpr))
        g.fillRect(Math.round(px - lw / 2), laneH, lw, H - laneH)
        const t = 6 * dpr
        g.beginPath()
        g.moveTo(px - t, laneH)
        g.lineTo(px + t, laneH)
        g.lineTo(px, laneH + t * 1.4)
        g.closePath()
        g.fill()
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // Wheel: zoom around the cursor; shift+wheel or horizontal scroll pans.
  useEffect(() => {
    const canvas = canvasRef.current!
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = latest.current
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1
      const x = e.clientX - canvas.getBoundingClientRect().left
      const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
      if (horizontal && !e.ctrlKey) {
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

  const local = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const x = e.clientX - rect.left
    const { view, peaks } = latest.current
    return { x, y: e.clientY - rect.top, sample: Math.min(Math.max(0, view.start + x * view.spp), peaks.length) }
  }

  const edgeAt = (x: number): number | null => {
    const { selection: sel, view } = latest.current
    if (!sel) return null
    const xs = (sel.start - view.start) / view.spp
    const xe = (sel.end - view.start) / view.spp
    if (Math.abs(x - xs) <= EDGE_PX) return sel.end
    if (Math.abs(x - xe) <= EDGE_PX) return sel.start
    return null
  }

  /** Marker under a point in the marker lane / ruler, preferring sections, then nearest. */
  const markerAt = (x: number, y: number): Marker | null => {
    if (y > TOP_H) return null
    const { markers, view } = latest.current
    let best: Marker | null = null
    let bestScore = Infinity
    for (const m of markers) {
      const mx = (m.pos - view.start) / view.spp
      // section flags extend to the right of their line
      const inFlag = m.kind === 'section' && y <= MARKER_LANE_H && x >= mx && x <= mx + 70
      const d = Math.abs(x - mx)
      if (d > 6 && !inFlag) continue
      const score = KIND_PRIORITY[m.kind] * 10 + (inFlag ? 0 : d)
      if (score < bestScore) {
        best = m
        bestScore = score
      }
    }
    return best
  }

  /** Chord segment under a point in the chord lane. */
  const chordAt = (x: number, y: number): number | null => {
    const { chordLane, view } = latest.current
    if (!chordLane || y <= TOP_H || y > HEADER_H) return null
    const i = segmentAt(chordLane.segments, view.start + x * view.spp)
    return i >= 0 && chordLane.segments[i].chord ? i : null
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const { x, y, sample } = local(e)
    const marker = markerAt(x, y)
    if (marker) {
      drag.current = { mode: 'marker', id: marker.id, x0: x, moved: false }
      return
    }
    const chord = chordAt(x, y)
    if (chord !== null) {
      latest.current.onChordClick(chord)
      return
    }
    const fixed = y > HEADER_H ? edgeAt(x) : null
    drag.current = fixed !== null ? { mode: 'select', fixed } : { mode: 'pending', anchor: sample, x0: x }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, sample } = local(e)
    const d = drag.current
    if (!d) {
      e.currentTarget.style.cursor = markerAt(x, y) ? 'grab' : chordAt(x, y) !== null ? 'pointer' : y > HEADER_H && edgeAt(x) !== null ? 'ew-resize' : y <= HEADER_H ? 'pointer' : 'text'
      return
    }
    if (d.mode === 'marker') {
      if (!d.moved && Math.abs(x - d.x0) < DRAG_PX) return
      d.moved = true
      e.currentTarget.style.cursor = 'grabbing'
      latest.current.onMarkerMove(d.id, sample)
      return
    }
    if (d.mode === 'pending') {
      if (Math.abs(x - d.x0) < DRAG_PX) return
      drag.current = { mode: 'select', fixed: d.anchor }
    }
    const fixed = (drag.current as { fixed: number }).fixed
    latest.current.onSelect({ start: Math.min(fixed, sample), end: Math.max(fixed, sample) }, false)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const { sample } = local(e)
    if (d.mode === 'marker') {
      if (!d.moved) latest.current.onMarkerClick(d.id)
    } else if (d.mode === 'pending') latest.current.onSeek(sample)
    else latest.current.onSelect({ start: Math.min(d.fixed, sample), end: Math.max(d.fixed, sample) }, true)
  }

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y, sample } = local(e)
    const marker = markerAt(x, y)
    const chord = chordAt(x, y)
    if (marker) latest.current.onMarkerEdit(marker.id)
    else if (chord !== null) latest.current.onChordDoubleClick(chord)
    else if (y > HEADER_H) latest.current.onSelectBetweenMarkers(sample)
  }

  return (
    <div className="waveform" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => (drag.current = null)}
        onDoubleClick={onDoubleClick}
      />
    </div>
  )
}

function drawChordLane(g: CanvasRenderingContext2D, lane: ChordLane | null, y: number, h: number, W: number, start: number, spp: number, dpr: number): void {
  g.fillStyle = colors.chordLane
  g.fillRect(0, y, W, h)
  g.fillStyle = colors.axis
  g.fillRect(0, y + h - 1, W, 1)
  g.font = `600 ${11 * dpr}px Inter, system-ui, sans-serif`
  g.textBaseline = 'middle'
  if (!lane || lane.segments.length === 0) {
    if (lane?.placeholder) {
      g.fillStyle = colors.rulerText
      g.fillText(lane.placeholder, 8 * dpr, y + h / 2)
    }
    return
  }
  const end = start + W * spp
  const first = Math.max(0, segmentAt(lane.segments, start))
  for (let i = first; i < lane.segments.length; i++) {
    const seg = lane.segments[i]
    if (seg.start > end) break
    if (seg.end < start || !seg.chord) continue
    const x0 = Math.round((seg.start - start) / spp)
    const x1 = Math.round((seg.end - start) / spp)
    g.fillStyle = i % 2 ? colors.chordBlockAlt : colors.chordBlock
    g.fillRect(x0 + dpr, y + 2 * dpr, x1 - x0 - 2 * dpr, h - 4 * dpr)
    const label = lane.labels[i]
    const tw = g.measureText(label).width
    // a cut-off name ("Cr") misleads; leave short blocks unlabelled until you zoom in
    if (Math.min(x1, W) - Math.max(x0, 0) < tw + 10 * dpr) continue
    g.save()
    g.beginPath()
    g.rect(x0 + 2 * dpr, y, x1 - x0 - 4 * dpr, h)
    g.clip()
    g.fillStyle = colors.chordText
    // keep the label visible when the block starts left of the view
    const tx = Math.max(x0 + 5 * dpr, Math.min(5 * dpr, x1 - tw - 5 * dpr))
    g.fillText(label, tx, y + h / 2 + 0.5)
    g.restore()
  }
}

/** Beat lines (faint), bar lines and bar numbers. Bar numbers thin out when zoomed out. */
function drawGrid(g: CanvasRenderingContext2D, grid: BeatGrid, laneH: number, headerH: number, W: number, H: number, start: number, spp: number, dpr: number): void {
  const end = start + W * spp
  const toX = (s: number) => Math.round((s - start) / spp)
  const px = Math.max(1, Math.round(dpr))
  const beatPx = medianBeatSpacing(grid) / spp
  // Beat lines only when they are far enough apart to read.
  if (beatPx > 6 * dpr) {
    g.fillStyle = colors.gridBeat
    for (const b of grid.beats) if (b >= start && b <= end) g.fillRect(toX(b), headerH, px, H - headerH)
  }
  const barPx = beatPx * grid.meter
  const every = [1, 2, 4, 8, 16, 32, 64].find((n) => barPx * n >= 30 * dpr) ?? 128
  g.font = `${10 * dpr}px Inter, system-ui, sans-serif`
  g.textBaseline = 'middle'
  let lastLabelEnd = -Infinity
  grid.downbeats.forEach((bi, k) => {
    const pos = grid.beats[bi]
    if (pos < start || pos > end) return
    const x = toX(pos)
    const bar = grid.firstBar + k
    g.fillStyle = colors.gridBar
    g.fillRect(x, headerH, px, H - headerH)
    // never let a label run into the previous one (bars can be short where the tracker was unsure)
    if (((bar - 1) % every === 0 || every === 1) && x > lastLabelEnd) {
      const label = String(bar)
      g.fillStyle = colors.gridBarTick
      g.fillRect(x, 0, px, laneH)
      g.fillStyle = colors.gridText
      g.fillText(label, x + 3 * dpr, laneH / 2 + 0.5)
      lastLabelEnd = x + g.measureText(label).width + 8 * dpr
    }
  })
}
