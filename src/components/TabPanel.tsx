import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { expandBars, type PlayedBar } from '../tabs/expand'
import { TICKS_PER_QUARTER, type TabBeat, type TabScore } from '../tabs/model'
import { barAt, tickAt, type SyncedBar, type TabSync } from '../tabs/sync'
import { TAB_EXTENSIONS, type TabProject, type TabStatus } from '../tabs/useTabSync'
import type { Selection } from '../types'
import { Btn } from './Controls'

interface Props {
  project: TabProject | null
  score: TabScore | null
  status: TabStatus
  hasFile: boolean
  hasGrid: boolean
  /** Song length in samples. */
  songLength: number
  getPosition: () => number
  selection: Selection | null
  onOpen: (file: File) => void
  onRemove: () => void
  onTrack: (track: number) => void
  onResync: () => void
  /** Played bar `played` really starts at sample `pos`. */
  onPin: (played: number, pos: number) => void
  onClearPins: () => void
  onSeek: (pos: number) => void
  onLoop: (start: number, end: number) => void
}

/** Sections below this confidence are marked as a poor match, below UNSURE as unsure (see scripts/tab-eval). */
const POOR = 0.4
const UNSURE = 0.5
const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']
const GAP_W = 64
const PAD = 10

/** One block of the strip: a synced bar, or a stretch of the recording the tab doesn't cover. */
type Item = { kind: 'bar'; i: number; x: number; w: number } | { kind: 'gap'; start: number; end: number; x: number; w: number }

/** Narrowest spacing between note onsets, CSS px, so fret numbers don't run into each other. */
const MIN_NOTE_GAP = 15

function layoutStrip(sync: TabSync, score: TabScore, track: TabScore['tracks'][number], played: PlayedBar[], perQuarter: number, length: number): { items: Item[]; width: number } {
  const items: Item[] = []
  let x = 0
  const gap = (start: number, end: number) => {
    items.push({ kind: 'gap', start, end, x, w: GAP_W })
    x += GAP_W
  }
  sync.bars.forEach((b, i) => {
    const prevEnd = i > 0 ? sync.bars[i - 1].end : 0
    const beatLen = (b.end - b.start) / Math.max(1, b.beats.length)
    if (b.start - prevEnd > beatLen * 1.5) gap(prevEnd, b.start)
    const written = played[b.played].bar
    const ticks = score.bars[written].ticks
    const onsets = new Set((track.bars[written] ?? []).map((bt) => bt.start)).size
    const w = Math.max(40, (ticks / TICKS_PER_QUARTER) * perQuarter, onsets * MIN_NOTE_GAP + 2 * PAD)
    items.push({ kind: 'bar', i, x, w })
    x += w
  })
  const last = sync.bars[sync.bars.length - 1]
  if (last && length - last.end > (last.end - last.start) / 2) gap(last.end, length)
  return { items, width: x }
}

/** Notes of the shown track sounding at `tick` of a written bar. */
const soundingAt = (beats: TabBeat[], tick: number) => beats.filter((b) => b.start <= tick && tick < b.start + b.duration)

/** Tab strip that follows the recording: click a bar to go there, Shift-click to loop a range, drag a bar line to fix the sync. */
export function TabPanel(p: Props) {
  const fileInput = useRef<HTMLInputElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [perQuarter, setPerQuarter] = useState(44)
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('4')
  const [now, setNow] = useState<{ bar: number; frets: string } | null>(null)
  const sync = p.project?.sync ?? null
  const score = p.score
  const played = useMemo(() => (score ? expandBars(score.bars) : []), [score])
  const track = score?.tracks[p.project?.track ?? 0] ?? score?.tracks[0] ?? null
  const strip = useMemo(
    () => (sync && score && track && played.length ? layoutStrip(sync, score, track, played, perQuarter, p.songLength) : null),
    [sync, score, track, played, perQuarter, p.songLength],
  )

  // drawing state shared with the animation loop
  const view = useRef({ scroll: 0, manualUntil: 0, drag: null as null | { i: number; x0: number; dx: number }, anchor: -1 })
  const latest = useRef({ p, strip, sync, score, played, track, perQuarter })
  latest.current = { p, strip, sync, score, played, track, perQuarter }

  /** x on the strip of a sample position, or null outside the tab. */
  const xOf = (pos: number): number | null => {
    const { strip, sync } = latest.current
    if (!strip || !sync) return null
    const i = barAt(sync, pos)
    if (i >= 0) {
      const it = strip.items.find((t) => t.kind === 'bar' && t.i === i)!
      const b = sync.bars[i]
      const ticks = b.unitTicks * b.beats.length
      return it.x + PAD + (tickAt(b, pos) / ticks) * (it.w - 2 * PAD)
    }
    const g = strip.items.find((t) => t.kind === 'gap' && pos >= t.start && pos < t.end) as Extract<Item, { kind: 'gap' }> | undefined
    return g ? g.x + ((pos - g.start) / Math.max(1, g.end - g.start)) * g.w : null
  }

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const g = canvas.getContext('2d')!
    let raf = 0
    let drawn = ''
    let shown = ''
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
    })
    ro.observe(canvas)
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const { p, strip, sync, score, played, track } = latest.current
      const W = canvas.width
      const H = canvas.height
      if (!W || !H || !strip || !sync || !score || !track) return
      const dpr = W / canvas.clientWidth
      const cw = canvas.clientWidth
      const ch = canvas.clientHeight
      const pos = p.getPosition()
      const v = view.current
      const head = xOf(pos)
      // follow the playhead, page by page, unless the strip was just scrolled by hand
      if (head !== null && performance.now() > v.manualUntil && (head < v.scroll + 0.05 * cw || head > v.scroll + 0.8 * cw)) v.scroll = Math.max(0, head - 0.15 * cw)
      v.scroll = Math.max(0, Math.min(v.scroll, Math.max(0, strip.width - cw + 20)))
      const sel = p.selection
      const key = `${W}|${H}|${Math.round(pos)}|${v.scroll}|${v.drag?.dx ?? ''}|${sel?.start}|${sel?.end}|${strip.width}|${track.name}`
      if (key === drawn) return
      drawn = key

      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.fillStyle = '#10131a'
      g.fillRect(0, 0, cw, ch)
      const strings = track.tuning.length
      const top = 30
      const spacing = Math.max(9, Math.min(18, (ch - top - 12) / Math.max(1, strings - 1)))
      const yOf = (s: number) => top + (strings - s) * spacing
      const bottom = yOf(1)
      const fontPx = Math.max(9, Math.min(13, spacing * 0.8))
      const i0 = barAt(sync, pos)
      let frets = ''

      for (const it of strip.items) {
        const x = it.x - v.scroll
        if (x > cw || x + it.w < 0) continue
        if (it.kind === 'gap') {
          g.fillStyle = '#161a22'
          g.fillRect(x + 4, top - 4, it.w - 8, bottom - top + 8)
          g.fillStyle = '#5d667a'
          g.font = `10px system-ui, sans-serif`
          g.textAlign = 'center'
          g.fillText('not in', x + it.w / 2, (top + bottom) / 2 - 2)
          g.fillText('tab', x + it.w / 2, (top + bottom) / 2 + 10)
          continue
        }
        const b = sync.bars[it.i]
        const pb = played[b.played]
        const section = sync.sections[b.section]
        // section tint by confidence, loop highlight
        if (section.confidence < UNSURE) {
          g.fillStyle = section.confidence < POOR ? 'rgba(255, 90, 79, 0.16)' : 'rgba(255, 181, 71, 0.10)'
          g.fillRect(x, top - 6, it.w, bottom - top + 12)
        }
        if (sel && b.start >= sel.start - 10 && b.end <= sel.end + 10) {
          g.fillStyle = 'rgba(255, 181, 71, 0.13)'
          g.fillRect(x, 0, it.w, ch)
        }
        // bar number (pass of a repeat after it), section name at the start of each section
        g.fillStyle = b.pinned ? '#49d6b8' : '#8590a6'
        g.font = `10px system-ui, sans-serif`
        g.textAlign = 'left'
        g.fillText(`${pb.bar + 1}${pb.pass ? ` ×${pb.pass + 1}` : ''}${b.pinned ? ' ⚲' : ''}`, x + 3, top - 9)
        if (section.first === it.i && pb.section) {
          g.fillStyle = '#dde2ec'
          g.font = `600 11px system-ui, sans-serif`
          g.fillText(pb.section, x + 3, 11)
        }
        // strings and bar lines
        g.fillStyle = '#394155'
        for (let s = 1; s <= strings; s++) g.fillRect(x, Math.round(yOf(s)), it.w, 1)
        g.fillStyle = '#6b7488'
        g.fillRect(Math.round(x), top, 1, bottom - top + 1)
        // notes; the ones sounding now in accent
        const ticks = b.unitTicks * b.beats.length
        const here = it.i === i0 ? tickAt(b, pos) : -1
        g.font = `${fontPx}px ui-monospace, monospace`
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        for (const beat of track.bars[pb.bar] ?? []) {
          const nx = x + PAD + (beat.start / ticks) * (it.w - 2 * PAD)
          const on = here >= beat.start && here < beat.start + beat.duration
          for (const n of beat.notes) {
            const label = n.dead ? 'x' : n.tie ? `(${n.fret})` : String(n.fret)
            const tw = g.measureText(label).width
            g.fillStyle = '#10131a'
            g.fillRect(nx - tw / 2 - 1, yOf(n.string) - fontPx / 2, tw + 2, fontPx)
            g.fillStyle = on ? '#49d6b8' : n.tie ? '#8590a6' : '#dde2ec'
            g.fillText(label, nx, yOf(n.string) + 0.5)
          }
        }
        g.textBaseline = 'alphabetic'
        if (it.i === i0) {
          const names = soundingAt(track.bars[pb.bar] ?? [], here)
            .flatMap((bt) => bt.notes)
            .filter((n) => !n.dead)
            .sort((a, b) => b.string - a.string)
            .map((n) => `${NAMES[(track.tuning[n.string - 1] ?? 0) % 12]} string, fret ${n.fret}`)
          frets = names.join(' · ')
        }
        // a bar line being dragged
        if (v.drag?.i === it.i) {
          g.fillStyle = '#49d6b8'
          g.fillRect(Math.round(x + v.drag.dx), 0, 2, ch)
        }
      }
      // playhead
      if (head !== null) {
        g.fillStyle = '#ffb547'
        g.fillRect(Math.round(head - v.scroll), 16, 2, ch - 16)
      }
      const s = `${i0}|${frets}`
      if (s !== shown) {
        shown = s
        setNow(i0 >= 0 ? { bar: i0, frets } : null)
      }
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
    // the loop reads everything through refs; it only restarts when the canvas appears or goes
  }, [!!strip])

  /** Item under a canvas x (CSS px), and whether it is on that bar's start line. */
  const hit = (clientX: number) => {
    const canvas = canvasRef.current!
    const x = clientX - canvas.getBoundingClientRect().left + view.current.scroll
    const it = strip?.items.find((t) => x >= t.x && x < t.x + t.w)
    return { it, onLine: !!it && it.kind === 'bar' && x - it.x < 6, x }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!sync || e.button !== 0) return
    const { it, onLine } = hit(e.clientX)
    if (!it) return
    if (it.kind === 'gap') return p.onSeek(it.start)
    const b = sync.bars[it.i]
    if (onLine) {
      view.current.drag = { i: it.i, x0: e.clientX, dx: 0 }
      try {
        e.currentTarget.setPointerCapture(e.pointerId)
      } catch {
        /* synthetic events can't be captured */
      }
      return
    }
    const v = view.current
    if (e.shiftKey && v.anchor >= 0) {
      const a = Math.min(v.anchor, it.i)
      const z = Math.max(v.anchor, it.i)
      p.onLoop(sync.bars[a].start, sync.bars[z].end)
      return
    }
    v.anchor = it.i
    p.onSeek(b.start)
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const d = view.current.drag
    if (d) d.dx = e.clientX - d.x0
    else e.currentTarget.style.cursor = hit(e.clientX).onLine ? 'col-resize' : 'pointer'
  }
  const onPointerUp = () => {
    const d = view.current.drag
    view.current.drag = null
    if (!d || !sync) return
    const it = strip?.items.find((t) => t.kind === 'bar' && t.i === d.i)
    const b = sync.bars[d.i]
    if (!it || Math.abs(d.dx) < 3) return p.onSeek(b.start)
    // pixels to time at this bar's own pace
    const perPx = (b.end - b.start) / (it.w - 2 * PAD)
    p.onPin(b.played, b.start + d.dx * perPx)
  }

  /** Nearest bar line to the playhead starts exactly at the playhead. */
  const barLineHere = () => {
    if (!sync?.bars.length) return
    const pos = p.getPosition()
    let best = 0
    for (let i = 1; i < sync.bars.length; i++) if (Math.abs(sync.bars[i].start - pos) < Math.abs(sync.bars[best].start - pos)) best = i
    p.onPin(sync.bars[best].played, pos)
  }

  /** Loop written bars N–M: N's occurrence nearest the playhead, then the first M from there. */
  const loopWritten = (n: number, m: number) => {
    if (!sync) return
    const pos = p.getPosition()
    const isBar = (b: SyncedBar, k: number) => played[b.played].bar + 1 === k
    const starts = sync.bars.map((b, i) => (isBar(b, n) ? i : -1)).filter((i) => i >= 0)
    if (!starts.length) return
    const a = starts.reduce((best, i) => (Math.abs(sync.bars[i].start - pos) < Math.abs(sync.bars[best].start - pos) ? i : best))
    let z = a
    while (z < sync.bars.length && !isBar(sync.bars[z], m)) z++
    if (z >= sync.bars.length) return
    p.onLoop(sync.bars[a].start, sync.bars[z].end)
  }

  const status = p.status
  const shift = sync ? ((((sync.shift + 6) % 12) + 12) % 12) - 6 : 0
  const poor = sync ? sync.sections.filter((s) => s.confidence < POOR).length : 0
  const nowBar = now && sync ? sync.bars[now.bar] : null
  const nowSection = nowBar && sync ? sync.sections[nowBar.section] : null

  return (
    <div className="gtab-panel">
      <div className="section-title">
        <span className="label" title={p.project?.name}>
          {score ? [score.artist, score.title].filter(Boolean).join(' – ') || p.project?.name : 'Tab'}
        </span>
        <span className="gtab-actions">
          <Btn className="small" disabled={!p.hasFile} onClick={() => fileInput.current?.click()} title="Open a Guitar Pro, MusicXML or alphaTex file for this song">
            {p.project ? 'Replace…' : 'Open tab…'}
          </Btn>
          {p.project && (
            <Btn className="small" onClick={p.onRemove} title="Remove the tab from this song">
              ✕
            </Btn>
          )}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={TAB_EXTENSIONS.join(',')}
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) p.onOpen(f)
          e.target.value = ''
        }}
      />

      {!p.hasFile && <p className="empty-hint">Open a song, then a Guitar Pro tab for it: it scrolls with the recording.</p>}
      {p.hasFile && !p.project && <p className="empty-hint">Open a Guitar Pro (.gp, .gp5, .gpx…), MusicXML or alphaTex tab. It is lined up with the recording automatically.</p>}
      {p.project && !p.hasGrid && status.kind !== 'running' && <p className="muted small-text">Waiting for the beats and bars of the song…</p>}
      {status.kind === 'running' && (
        <div className="progress-block">
          <div className={`progress ${status.what === 'reading' ? 'indeterminate' : ''}`}>
            <div style={{ width: `${status.fraction * 100}%` }} />
          </div>
          <span className="muted small-text">{status.what === 'reading' ? 'Reading the tab…' : 'Lining the tab up with the recording…'}</span>
        </div>
      )}
      {status.kind === 'error' && <p className="warning">{status.message}</p>}

      {score && sync && (
        <>
          <div className="gtab-toolbar">
            {score.tracks.length > 1 && (
              <select className="select" value={p.project?.track ?? 0} onChange={(e) => (p.onTrack(+e.target.value), e.currentTarget.blur())} aria-label="Track">
                {score.tracks.map((t, i) => (
                  <option key={i} value={i} disabled={t.percussion}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
            <Btn className="small" onClick={() => setPerQuarter((z) => Math.max(20, z / 1.25))} title="Narrower bars">
              −
            </Btn>
            <Btn className="small" onClick={() => setPerQuarter((z) => Math.min(160, z * 1.25))} title="Wider bars">
              +
            </Btn>
            <Btn className="small" onClick={barLineHere} title="The nearest bar line starts exactly at the playhead; the rest of the tab follows">
              Bar line here
            </Btn>
            <Btn className="small" disabled={status.kind === 'running'} onClick={p.onResync} title="Line the tab up with the recording again (keeps bars placed by hand)">
              Re-sync
            </Btn>
          </div>
          <canvas
            ref={canvasRef}
            className="gtab-strip"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => (view.current.drag = null)}
            onWheel={(e) => {
              view.current.scroll += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
              view.current.manualUntil = performance.now() + 4000
            }}
          />
          <div className="gtab-now small-text">
            {nowBar && nowSection ? (
              <>
                <b>
                  Bar {played[nowBar.played].bar + 1}
                  {played[nowBar.played].pass ? ` (×${played[nowBar.played].pass + 1})` : ''}
                </b>
                {played[nowBar.played].section && <span> · {played[nowBar.played].section}</span>}
                <span className={nowSection.confidence < POOR ? 'bad' : nowSection.confidence < UNSURE ? 'unsure' : 'muted'}> · match {Math.round(nowSection.confidence * 100)}%</span>
                {now?.frets && <div className="gtab-frets">{now.frets}</div>}
              </>
            ) : (
              <span className="muted">Not in the tab here</span>
            )}
          </div>
          <form
            className="bar-loop"
            onSubmit={(e) => {
              e.preventDefault()
              const a = parseInt(from, 10)
              const b = parseInt(to, 10)
              if (Number.isFinite(a) && Number.isFinite(b)) loopWritten(Math.min(a, b), Math.max(a, b))
            }}
          >
            <span className="muted small-text">Loop tab bars</span>
            <input className="num-input" value={from} inputMode="numeric" onChange={(e) => setFrom(e.target.value)} aria-label="From tab bar" />
            <span className="muted">–</span>
            <input className="num-input" value={to} inputMode="numeric" onChange={(e) => setTo(e.target.value)} aria-label="To tab bar" />
            <Btn className="small" type="submit">
              Loop
            </Btn>
          </form>
          <p className="muted small-text gtab-summary">
            {sync.bars.length} bars placed
            {sync.missing.length > 0 && ` · ${sync.missing.length} not played in the recording`}
            {shift !== 0 && ` · tab moved ${shift > 0 ? '+' : ''}${shift} semitone${Math.abs(shift) > 1 ? 's' : ''} to match (capo or tuning)`}
            {poor > 0 && (
              <>
                {' · '}
                <span className="bad">{poor} poorly matched section{poor > 1 ? 's' : ''}</span>
              </>
            )}
            {(p.project?.anchors.length ?? 0) > 0 && (
              <>
                {` · ${p.project!.anchors.length} placed by hand `}
                <button type="button" className="link" onClick={p.onClearPins}>
                  clear
                </button>
              </>
            )}
          </p>
          <p className="muted small-text">Click a bar to go there, Shift-click another to loop the bars between; drag a bar line to fix where it starts.</p>
        </>
      )}
    </div>
  )
}

