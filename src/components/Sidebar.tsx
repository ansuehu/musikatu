import { useEffect, useMemo, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { EQ_FREQS, EQ_MAX_DB, EQ_PRESETS, PASS_MAX_HZ, PASS_MIN_HZ, formatHz, type EqState } from '../audio/eq'
import { CHANNEL_MODES, type ChannelMode } from '../dsp/ChannelMixer'
import { SECTION_NAMES, measureNumbers, type Marker, type MarkerKind, type SavedLoop } from '../project'
import { formatTime } from '../waveform/draw'
import { markerColors } from '../waveform/draw'
import type { Selection } from '../types'
import { Btn, Slider } from './Controls'

export type SidebarTab = 'markers' | 'loops' | 'eq' | 'mix'

interface Props {
  tab: SidebarTab
  onTab: (t: SidebarTab) => void
  sampleRate: number
  disabled: boolean
  // markers
  markers: Marker[]
  selectedMarker: string | null
  editMarkerRequest: { id: string; n: number } | null
  onMarkerSeek: (id: string) => void
  onMarkerRename: (id: string, name: string) => void
  onMarkerDelete: (id: string) => void
  onMarkerAdd: (kind: MarkerKind) => void
  onMarkersClear: (kind: MarkerKind) => void
  tempo: { tapped: number; original: number } | null
  onTap: () => void
  // loops
  loops: SavedLoop[]
  selection: Selection | null
  activeLoop: string | null
  onLoopSave: () => void
  onLoopRecall: (id: string) => void
  onLoopRename: (id: string, name: string) => void
  onLoopDelete: (id: string) => void
  onLoopUpdate: (id: string) => void
  // eq / mix
  engine: AudioEngine | null
  eq: EqState
  onEq: (eq: EqState) => void
  channelMode: ChannelMode
  onChannelMode: (m: ChannelMode) => void
  channels: number
}

const TABS: { id: SidebarTab; label: string }[] = [
  { id: 'markers', label: 'Markers' },
  { id: 'loops', label: 'Loops' },
  { id: 'eq', label: 'EQ' },
  { id: 'mix', label: 'Mix' },
]

export function Sidebar(p: Props) {
  return (
    <aside className="sidebar">
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <Btn
            key={t.id}
            role="tab"
            aria-selected={p.tab === t.id}
            className={`tab ${p.tab === t.id ? 'on' : ''} ${t.id === 'eq' && isEqActive(p.eq) ? 'dot' : ''} ${t.id === 'mix' && p.channelMode !== 'stereo' ? 'dot' : ''}`}
            onClick={() => p.onTab(t.id)}
          >
            {t.label}
          </Btn>
        ))}
      </nav>
      <div className="tab-body">
        {p.tab === 'markers' && <MarkersTab {...p} />}
        {p.tab === 'loops' && <LoopsTab {...p} />}
        {p.tab === 'eq' && <EqTab {...p} />}
        {p.tab === 'mix' && <MixTab {...p} />}
      </div>
    </aside>
  )
}

function isEqActive(eq: EqState): boolean {
  return eq.enabled && (eq.gains.some((g) => g !== 0) || eq.highpass.on || eq.lowpass.on)
}

/** Text input that commits on blur / Enter and stays out of the global shortcut handler. */
function NameInput({ value, onCommit, inputRef, list }: { value: string; onCommit: (v: string) => void; inputRef?: (el: HTMLInputElement | null) => void; list?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      ref={inputRef}
      className="name-input"
      value={draft}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim()
        if (v && v !== value) onCommit(v)
        else setDraft(value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => e.currentTarget?.blur())
        }
      }}
    />
  )
}

function MarkersTab(p: Props) {
  const sorted = useMemo(() => [...p.markers].sort((a, b) => a.pos - b.pos), [p.markers])
  const bars = useMemo(() => measureNumbers(p.markers), [p.markers])
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const beats = sorted.filter((m) => m.kind === 'beat').length
  const listed = sorted.filter((m) => m.kind !== 'beat')

  useEffect(() => {
    const el = p.editMarkerRequest && inputs.current.get(p.editMarkerRequest.id)
    if (el) {
      el.focus()
      el.select()
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [p.editMarkerRequest])

  return (
    <div className="markers-tab">
      <div className="button-row">
        <Btn className="small" disabled={p.disabled} onClick={() => p.onMarkerAdd('section')} title="Add section marker at the playhead (N)">
          + Section
        </Btn>
        <Btn className="small" disabled={p.disabled} onClick={() => p.onMarkerAdd('measure')} title="Add measure marker (M)">
          + Measure
        </Btn>
        <Btn className="small" disabled={p.disabled} onClick={() => p.onMarkerAdd('beat')} title="Add beat marker (B) — tap it in time while playing">
          + Beat
        </Btn>
      </div>
      <div className="tempo-row">
        <Btn className="small" disabled={p.disabled} onClick={p.onTap} title="Tap along with the beat (T)">
          Tap tempo
        </Btn>
        <span className="tempo">
          {p.tempo ? (
            <>
              <b>{p.tempo.original.toFixed(1)}</b> BPM
              {Math.abs(p.tempo.original - p.tempo.tapped) > 0.05 && <span className="muted"> (tapped {p.tempo.tapped.toFixed(1)} at this speed)</span>}
            </>
          ) : (
            <span className="muted">Tap T four or more times</span>
          )}
        </span>
      </div>
      <datalist id="section-names">
        {SECTION_NAMES.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {listed.length === 0 && beats === 0 ? (
        <p className="empty-hint">
          Drop markers at the playhead with <kbd>N</kbd> section, <kbd>M</kbd> measure, <kbd>B</kbd> beat — they work while playing, so you can tap
          them in time. Drag flags to adjust; double-click between markers to select that span.
        </p>
      ) : (
        <ul className="list">
          {listed.map((m) => (
            <li key={m.id} className={m.id === p.selectedMarker ? 'selected' : ''}>
              <span className="swatch" style={{ background: markerColors[m.kind] }} />
              <button type="button" className="time link" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onMarkerSeek(m.id)}>
                {formatTime(m.pos / p.sampleRate, 0.01)}
              </button>
              {m.kind === 'section' ? (
                <NameInput
                  value={m.name}
                  list="section-names"
                  onCommit={(v) => p.onMarkerRename(m.id, v)}
                  inputRef={(el) => (el ? inputs.current.set(m.id, el) : inputs.current.delete(m.id))}
                />
              ) : (
                <span className="bar-label">Bar {bars.get(m.id)}</span>
              )}
              <Btn className="small icon" onClick={() => p.onMarkerDelete(m.id)} title="Delete marker">
                ×
              </Btn>
            </li>
          ))}
        </ul>
      )}
      {(beats > 0 || listed.some((m) => m.kind === 'measure')) && (
        <div className="button-row footer-row">
          {beats > 0 && <span className="muted">{beats} beat markers</span>}
          {beats > 0 && (
            <Btn className="small" onClick={() => p.onMarkersClear('beat')}>
              Clear beats
            </Btn>
          )}
          {listed.some((m) => m.kind === 'measure') && (
            <Btn className="small" onClick={() => p.onMarkersClear('measure')}>
              Clear measures
            </Btn>
          )}
        </div>
      )}
    </div>
  )
}

function LoopsTab(p: Props) {
  const sr = p.sampleRate
  return (
    <div className="loops-tab">
      <Btn className="small" disabled={p.disabled || !p.selection} onClick={p.onLoopSave} title="Save the current selection (Shift+L)">
        Save selection as loop
      </Btn>
      {p.loops.length === 0 ? (
        <p className="empty-hint">
          Drag a region on the waveform, then save it here. Saved loops are recalled with <kbd>1</kbd>–<kbd>9</kbd> and remembered with the file.
        </p>
      ) : (
        <ul className="list">
          {p.loops.map((l, i) => (
            <li key={l.id} className={l.id === p.activeLoop ? 'selected' : ''}>
              <Btn className="small recall" onClick={() => p.onLoopRecall(l.id)} title={i < 9 ? `Recall (${i + 1})` : 'Recall'}>
                {i < 9 ? i + 1 : '▶'}
              </Btn>
              <div className="loop-main">
                <NameInput value={l.name} onCommit={(v) => p.onLoopRename(l.id, v)} />
                <span className="muted small-text">
                  {formatTime(l.start / sr, 0.01)} – {formatTime(l.end / sr, 0.01)} · {((l.end - l.start) / sr).toFixed(2)} s
                </span>
              </div>
              <Btn className="small icon" disabled={!p.selection} onClick={() => p.onLoopUpdate(l.id)} title="Replace with current selection">
                ⟳
              </Btn>
              <Btn className="small icon" onClick={() => p.onLoopDelete(l.id)} title="Delete loop">
                ×
              </Btn>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// log mapping for pass-filter sliders: 0..1000 ↔ 20 Hz..20 kHz
const toSlider = (f: number) => Math.round((Math.log(f / PASS_MIN_HZ) / Math.log(PASS_MAX_HZ / PASS_MIN_HZ)) * 1000)
const fromSlider = (v: number) => Math.round(PASS_MIN_HZ * (PASS_MAX_HZ / PASS_MIN_HZ) ** (v / 1000))

function EqTab(p: Props) {
  const { eq, onEq } = p
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !p.engine) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(canvas.clientWidth * dpr)
    canvas.height = Math.round(canvas.clientHeight * dpr)
    const W = canvas.width
    const H = canvas.height
    const freqs = new Float32Array(W)
    for (let x = 0; x < W; x++) freqs[x] = PASS_MIN_HZ * (PASS_MAX_HZ / PASS_MIN_HZ) ** (x / (W - 1))
    const resp = p.engine.eqResponse(eq, freqs)
    const g = canvas.getContext('2d')!
    g.fillStyle = '#0b0d11'
    g.fillRect(0, 0, W, H)
    const dbToY = (db: number) => H / 2 - (db / (EQ_MAX_DB + 6)) * (H / 2 - 4 * dpr)
    g.fillStyle = '#1b2030'
    for (const db of [-12, 0, 12]) g.fillRect(0, Math.round(dbToY(db)), W, 1)
    for (const f of [100, 1000, 10000]) g.fillRect(Math.round((Math.log(f / PASS_MIN_HZ) / Math.log(PASS_MAX_HZ / PASS_MIN_HZ)) * (W - 1)), 0, 1, H)
    g.strokeStyle = eq.enabled ? '#49d6b8' : '#5a6378'
    g.lineWidth = 2 * dpr
    g.beginPath()
    for (let x = 0; x < W; x++) {
      const y = dbToY(Math.max(-EQ_MAX_DB - 6, 20 * Math.log10(resp[x] + 1e-9)))
      if (x === 0) g.moveTo(x, y)
      else g.lineTo(x, y)
    }
    g.stroke()
  }, [eq, p.engine])

  const set = (patch: Partial<EqState>) => onEq({ ...eq, ...patch })

  return (
    <div className="eq-tab">
      <div className="button-row">
        <Btn className={`small ${eq.enabled ? 'on' : ''}`} onClick={() => set({ enabled: !eq.enabled })} title="Bypass / enable the whole EQ">
          {eq.enabled ? 'EQ on' : 'EQ bypassed'}
        </Btn>
        <select
          className="select"
          value=""
          onChange={(e) => {
            const preset = EQ_PRESETS.find((x) => x.name === e.target.value)
            if (preset) onEq(structuredClone(preset.eq))
            e.currentTarget.blur()
          }}
        >
          <option value="" disabled>
            Presets…
          </option>
          {EQ_PRESETS.map((x) => (
            <option key={x.name}>{x.name}</option>
          ))}
        </select>
      </div>
      <canvas ref={canvasRef} className="eq-curve" />
      <div className="eq-bands">
        {EQ_FREQS.map((f, i) => (
          <label key={f} className="eq-band" title={`${formatHz(f)} Hz: ${eq.gains[i] > 0 ? '+' : ''}${eq.gains[i]} dB (double-click resets)`}>
            <span className="db">{eq.gains[i] > 0 ? '+' : ''}{eq.gains[i]}</span>
            <Slider
              className="vertical"
              min={-EQ_MAX_DB}
              max={EQ_MAX_DB}
              step={1}
              value={eq.gains[i]}
              onChange={(e) => set({ gains: eq.gains.map((g, j) => (j === i ? +e.target.value : g)) })}
              onDoubleClick={() => set({ gains: eq.gains.map((g, j) => (j === i ? 0 : g)) })}
            />
            <span className="hz">{formatHz(f)}</span>
          </label>
        ))}
      </div>
      {(['highpass', 'lowpass'] as const).map((k) => (
        <div className="pass-row" key={k}>
          <label className="check">
            <input type="checkbox" checked={eq[k].on} onChange={(e) => set({ [k]: { ...eq[k], on: e.target.checked } })} />
            {k === 'highpass' ? 'High-pass' : 'Low-pass'}
          </label>
          <Slider
            min={0}
            max={1000}
            value={toSlider(eq[k].freq)}
            disabled={!eq[k].on}
            onChange={(e) => set({ [k]: { ...eq[k], freq: fromSlider(+e.target.value) } })}
          />
          <span className="value">{formatHz(eq[k].freq)}</span>
        </div>
      ))}
      <p className="empty-hint">Tip: “Bass line” plus 50% speed makes most bass parts easy to follow. The spectrum below reflects the EQ.</p>
    </div>
  )
}

function MixTab(p: Props) {
  return (
    <div className="mix-tab">
      {p.channels < 2 && <p className="warning">This file is mono — channel modes need a stereo recording.</p>}
      {CHANNEL_MODES.map((m) => (
        <label key={m.id} className={`radio ${p.channelMode === m.id ? 'on' : ''}`}>
          <input type="radio" name="channel-mode" checked={p.channelMode === m.id} onChange={() => p.onChannelMode(m.id)} />
          <span>
            <b>{m.label}</b>
            <span className="muted">{m.hint}</span>
          </span>
        </label>
      ))}
      <p className="empty-hint">
        Vocal cut works by phase cancellation, so it only removes what was mixed exactly to the centre; reverb and stereo effects on the voice remain.
      </p>
    </div>
  )
}
