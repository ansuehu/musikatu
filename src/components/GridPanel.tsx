import { useState } from 'react'
import { doubleTempo, halfTempo, lastBar, setBarOneAt, shiftDownbeats, tempoBpm, withMeter, type BeatGrid } from '../rhythm/grid'
import type { GridStatus } from '../rhythm/useBeatGrid'
import { Btn, Slider } from './Controls'

interface Props {
  grid: BeatGrid | null
  status: GridStatus
  hasFile: boolean
  sampleRate: number
  speed: number
  getPosition: () => number
  onRerun: () => void
  onGrid: (g: BeatGrid) => void
  metronome: { on: boolean; volume: number }
  onMetronome: (m: { on: boolean; volume: number }) => void
  snap: boolean
  onSnap: (on: boolean) => void
  onLoopBars: (from: number, to: number) => void
}

/** Beat-grid controls: tempo and meter, corrections, metronome, snapping and bar loops. */
export function GridPanel(p: Props) {
  const [from, setFrom] = useState('1')
  const [to, setTo] = useState('4')
  const g = p.grid
  const bpm = g ? tempoBpm(g, p.sampleRate) : null

  if (p.status.kind === 'unavailable') return <p className="empty-hint">Beat detection runs in the desktop app.</p>

  return (
    <div className="grid-panel">
      <div className="section-title">
        <span className="label">Beat grid</span>
        <Btn className="small" disabled={!p.hasFile || p.status.kind === 'running'} onClick={p.onRerun} title="Detect beats and bars again (discards corrections)">
          Re-detect
        </Btn>
      </div>

      {p.status.kind === 'running' && (
        <div className="progress-block">
          <div className="progress">
            <div style={{ width: `${p.status.fraction * 100}%` }} />
          </div>
          <span className="muted small-text">Finding beats and bars…</span>
        </div>
      )}
      {p.status.kind === 'error' && <p className="warning">{p.status.message}</p>}
      {!p.hasFile && <p className="empty-hint">Open a song and its beats and bars are found automatically.</p>}

      {g && p.status.kind !== 'running' && (
        <>
          <div className="tempo-summary">
            <span>
              <b>{bpm ? bpm.toFixed(1) : '—'}</b> BPM
            </span>
            {bpm && Math.abs(p.speed - 1) > 0.005 && <span className="muted small-text">({(bpm * p.speed).toFixed(1)} at {Math.round(p.speed * 100)}%)</span>}
            <span className="muted">·</span>
            <label className="meter-field" title="Beats per bar">
              <select className="select" value={g.meter} onChange={(e) => (p.onGrid(withMeter(g, +e.target.value)), e.currentTarget.blur())}>
                {[2, 3, 4, 5, 6, 7, 9, 12].map((n) => (
                  <option key={n} value={n}>
                    {n}/{n === 6 || n === 9 || n === 12 ? 8 : 4}
                  </option>
                ))}
              </select>
            </label>
            <span className="muted small-text">{lastBar(g) - g.firstBar + 1} bars</span>
          </div>

          <div className="fix-row">
            <span className="muted small-text">Fix:</span>
            <Btn className="small" onClick={() => p.onGrid(shiftDownbeats(g, -1))} title="The bar actually starts one beat earlier">
              ◀ 1
            </Btn>
            <Btn className="small" onClick={() => p.onGrid(shiftDownbeats(g, 1))} title="The bar actually starts one beat later">
              1 ▶
            </Btn>
            <Btn className="small" onClick={() => p.onGrid(halfTempo(g))} title="Tracked twice too fast">
              ½×
            </Btn>
            <Btn className="small" onClick={() => p.onGrid(doubleTempo(g))} title="Tracked twice too slow">
              2×
            </Btn>
            <Btn className="small" onClick={() => p.onGrid(setBarOneAt(g, p.getPosition()))} title="Number bars so the bar under the playhead is bar 1">
              Bar 1 here
            </Btn>
          </div>

          <div className="metro-row">
            <Btn
              className={`small ${p.metronome.on ? 'on' : ''}`}
              onClick={() => p.onMetronome({ ...p.metronome, on: !p.metronome.on })}
              title="Click on every beat, accent on the 1 — stays in time at any speed (K)"
            >
              {p.metronome.on ? 'Metronome on' : 'Metronome'}
            </Btn>
            <Slider
              min={0}
              max={1}
              step={0.01}
              value={p.metronome.volume}
              onChange={(e) => p.onMetronome({ ...p.metronome, volume: +e.target.value })}
              aria-label="Metronome volume"
            />
          </div>

          <label className="check small-text">
            <input type="checkbox" checked={p.snap} onChange={(e) => p.onSnap(e.target.checked)} />
            Snap selections to beats
          </label>

          <form
            className="bar-loop"
            onSubmit={(e) => {
              e.preventDefault()
              const a = parseInt(from, 10)
              const b = parseInt(to, 10)
              if (Number.isFinite(a) && Number.isFinite(b)) p.onLoopBars(Math.min(a, b), Math.max(a, b))
            }}
          >
            <span className="muted small-text">Loop bars</span>
            <input className="num-input" value={from} inputMode="numeric" onChange={(e) => setFrom(e.target.value)} aria-label="From bar" />
            <span className="muted">–</span>
            <input className="num-input" value={to} inputMode="numeric" onChange={(e) => setTo(e.target.value)} aria-label="To bar" />
            <Btn className="small" type="submit">
              Loop
            </Btn>
          </form>
          {g.edited && <p className="muted small-text">Corrected by you — re-detect discards the corrections.</p>}
        </>
      )}
    </div>
  )
}
