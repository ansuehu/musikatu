import { useEffect, useState } from 'react'
import { DEFAULT_METRONOME, type ClickSound, type ClickWave, type MetronomeSettings } from '../dsp/Metronome'
import { freqToMidi, noteName } from '../analysis/notes'
import { Btn, Slider } from './Controls'

export type MetronomePrefs = MetronomeSettings & { on: boolean }

interface Props {
  value: MetronomePrefs
  onChange: (m: MetronomePrefs) => void
  onPreview: (accent: boolean) => void
  /** False until the song has a beat grid (the editor still works, the toggle doesn't). */
  hasGrid: boolean
}

const MIN_HZ = 200
const MAX_HZ = 5000
// log mapping for the pitch sliders: 0..1000 ↔ 200 Hz..5 kHz
const toSlider = (hz: number) => Math.round((Math.log(hz / MIN_HZ) / Math.log(MAX_HZ / MIN_HZ)) * 1000)
const fromSlider = (v: number) => Math.round(MIN_HZ * (MAX_HZ / MIN_HZ) ** (v / 1000))

const PRESETS: { name: string; settings: MetronomeSettings }[] = [
  { name: 'Classic', settings: DEFAULT_METRONOME },
  { name: 'Woodblock', settings: { master: 1.2, wave: 'triangle', accent: { volume: 1, freq: 1250, length: 25 }, beat: { volume: 0.8, freq: 950, length: 22 } } },
  { name: 'Cutting', settings: { master: 1.3, wave: 'square', accent: { volume: 1, freq: 2200, length: 35 }, beat: { volume: 0.75, freq: 1600, length: 30 } } },
  { name: 'Low & soft', settings: { master: 0.9, wave: 'sine', accent: { volume: 1, freq: 660, length: 80 }, beat: { volume: 0.6, freq: 440, length: 70 } } },
  { name: 'Accent only', settings: { ...DEFAULT_METRONOME, beat: { ...DEFAULT_METRONOME.beat, volume: 0 } } },
]

const WAVES: { id: ClickWave; label: string }[] = [
  { id: 'sine', label: 'Sine' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'square', label: 'Square' },
]

/** Hz field that accepts typing and commits within range on Enter / blur. */
function HzInput({ value, onCommit }: { value: number; onCommit: (hz: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const v = Math.round(Number(draft))
    if (Number.isFinite(v)) onCommit(Math.min(MAX_HZ, Math.max(MIN_HZ, v)))
    else setDraft(String(value))
  }
  return (
    <input
      className="num-input hz-input"
      value={draft}
      inputMode="numeric"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      aria-label="Pitch in hertz"
    />
  )
}

function SoundRow({ title, hint, sound, onChange, onPreview }: { title: string; hint: string; sound: ClickSound; onChange: (s: ClickSound) => void; onPreview: () => void }) {
  const note = noteName(Math.round(freqToMidi(sound.freq)))
  return (
    <div className="click-sound">
      <div className="click-sound-head">
        <span className="click-title">{title}</span>
        <span className="muted small-text">{hint}</span>
        <Btn className="small" onClick={onPreview} title="Play this click">
          ▶ Test
        </Btn>
      </div>
      <label className="metro-field">
        <span className="muted small-text">Volume</span>
        <Slider min={0} max={2} step={0.01} value={sound.volume} onChange={(e) => onChange({ ...sound, volume: +e.target.value })} onPointerUp={(e) => (onPreview(), e.currentTarget.blur())} />
        <span className="value">{Math.round(sound.volume * 100)}%</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Pitch</span>
        <Slider min={0} max={1000} value={toSlider(sound.freq)} onChange={(e) => onChange({ ...sound, freq: fromSlider(+e.target.value) })} onPointerUp={(e) => (onPreview(), e.currentTarget.blur())} />
        <span className="hz-cell">
          <HzInput value={sound.freq} onCommit={(freq) => onChange({ ...sound, freq })} />
          <span className="muted small-text">Hz {note}</span>
        </span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Length</span>
        <Slider min={8} max={200} step={1} value={sound.length} onChange={(e) => onChange({ ...sound, length: +e.target.value })} onPointerUp={(e) => (onPreview(), e.currentTarget.blur())} />
        <span className="value">{sound.length} ms</span>
      </label>
    </div>
  )
}

/** Metronome on/off plus full sound editing: level, waveform, and per-click volume, pitch and length. */
export function MetronomeEditor({ value: m, onChange, onPreview, hasGrid }: Props) {
  const [open, setOpen] = useState(false)
  const set = (patch: Partial<MetronomeSettings>) => onChange({ ...m, ...patch })
  return (
    <div className="metronome-editor">
      <div className="metro-row">
        <Btn className={`small ${m.on ? 'on' : ''}`} disabled={!hasGrid} onClick={() => onChange({ ...m, on: !m.on })} title="Click on every beat, accent on the 1 — stays in time at any speed (K)">
          {m.on ? 'Metronome on' : 'Metronome'}
        </Btn>
        <Slider min={0} max={2} step={0.01} value={m.master} onChange={(e) => set({ master: +e.target.value })} aria-label="Metronome volume" title="Metronome volume" />
        <span className="value">{Math.round(m.master * 100)}%</span>
        <Btn className={`small icon ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Edit the metronome sounds" aria-expanded={open}>
          ⚙
        </Btn>
      </div>

      {open && (
        <div className="metro-details">
          <div className="metro-field">
            <span className="muted small-text">Sound</span>
            <div className="segmented">
              {WAVES.map((w) => (
                <Btn key={w.id} className={`small ${m.wave === w.id ? 'on' : ''}`} onClick={() => (set({ wave: w.id }), requestAnimationFrame(() => onPreview(true)))}>
                  {w.label}
                </Btn>
              ))}
            </div>
          </div>
          <SoundRow title="Accent" hint="beat 1" sound={m.accent} onChange={(accent) => set({ accent })} onPreview={() => onPreview(true)} />
          <SoundRow title="Beats" hint="2, 3, 4…" sound={m.beat} onChange={(beat) => set({ beat })} onPreview={() => onPreview(false)} />
          <div className="button-row">
            <span className="muted small-text">Presets:</span>
            {PRESETS.map((p) => (
              <Btn key={p.name} className="small" onClick={() => (onChange({ ...p.settings, on: m.on }), requestAnimationFrame(() => onPreview(true)))}>
                {p.name}
              </Btn>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
