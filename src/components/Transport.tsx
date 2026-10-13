import { Btn, Clock, Slider } from './Controls'
import { BackIcon, ForwardIcon, LoopIcon, PauseIcon, PlayIcon, StopIcon, ToStartIcon } from './Icons'
import { formatTime } from '../waveform/draw'
import type { Selection } from '../types'

export const MIN_SPEED = 0.05
export const MAX_SPEED = 2
const SPEED_PRESETS = [0.25, 0.5, 0.75, 1]

interface Props {
  disabled: boolean
  getPosition: () => number
  sampleRate: number
  length: number
  playing: boolean
  onTogglePlay: () => void
  onStop: () => void
  onToStart: () => void
  onJump: (seconds: number) => void
  loopOn: boolean
  onToggleLoop: () => void
  selection: Selection | null
  speed: number
  onSpeed: (s: number) => void
  semitones: number
  onSemitones: (s: number) => void
  cents: number
  onCents: (c: number) => void
}

export function Transport(p: Props) {
  const ratio = 2 ** ((p.semitones + p.cents / 100) / 12)
  const sel = p.selection
  return (
    <footer className="transport">
      <section className="panel panel-time">
        <Clock getPosition={p.getPosition} sampleRate={p.sampleRate} length={p.length} />
        <div className={`loop-info ${p.loopOn ? 'on' : ''}`}>
          {sel
            ? `${p.loopOn ? 'Looping' : 'Selection'} ${formatTime(sel.start / p.sampleRate)} – ${formatTime(sel.end / p.sampleRate)} (${((sel.end - sel.start) / p.sampleRate).toFixed(2)} s)`
            : p.loopOn
              ? 'Looping whole file'
              : 'Drag on the waveform to select a loop'}
        </div>
      </section>

      <section className="panel panel-buttons">
        <Btn onClick={p.onToStart} disabled={p.disabled} title="To start / loop start (Home)">
          <ToStartIcon />
        </Btn>
        <Btn onClick={() => p.onJump(-1)} disabled={p.disabled} title="Back 1 s (←, Shift+← 5 s)">
          <BackIcon />
        </Btn>
        <Btn className="play" onClick={p.onTogglePlay} disabled={p.disabled} title="Play / Pause (Space)">
          {p.playing ? <PauseIcon /> : <PlayIcon />}
        </Btn>
        <Btn onClick={p.onStop} disabled={p.disabled} title="Stop and return to start (S)">
          <StopIcon />
        </Btn>
        <Btn onClick={() => p.onJump(1)} disabled={p.disabled} title="Forward 1 s (→, Shift+→ 5 s)">
          <ForwardIcon />
        </Btn>
        <Btn
          className={`loop ${p.loopOn ? 'on' : ''}`}
          onClick={p.onToggleLoop}
          disabled={p.disabled}
          title="Loop selection (L)"
          aria-pressed={p.loopOn}
        >
          <LoopIcon />
        </Btn>
      </section>

      <section className="panel panel-speed">
        <div className="panel-head">
          <span className="label">Speed</span>
          <span className="readout">{Math.round(p.speed * 100)}%</span>
        </div>
        <Slider
          min={MIN_SPEED * 100}
          max={MAX_SPEED * 100}
          step={1}
          value={Math.round(p.speed * 100)}
          onChange={(e) => p.onSpeed(+e.target.value / 100)}
          onDoubleClick={() => p.onSpeed(1)}
          aria-label="Playback speed"
        />
        <div className="presets">
          {SPEED_PRESETS.map((s) => (
            <Btn key={s} className={`small ${Math.abs(p.speed - s) < 1e-6 ? 'on' : ''}`} onClick={() => p.onSpeed(s)}>
              {s * 100}%
            </Btn>
          ))}
          <span className="hint">[ / ] ±5%</span>
        </div>
      </section>

      <section className="panel panel-pitch">
        <div className="panel-head">
          <span className="label">Pitch</span>
          <span className="readout">
            {p.semitones > 0 ? '+' : ''}
            {p.semitones} st {p.cents > 0 ? '+' : ''}
            {p.cents} ¢
          </span>
        </div>
        <div className="pitch-row">
          <Btn className="small" onClick={() => p.onSemitones(Math.max(-12, p.semitones - 1))} title="Down a semitone">
            −1 st
          </Btn>
          <Btn className="small" onClick={() => p.onSemitones(Math.min(12, p.semitones + 1))} title="Up a semitone">
            +1 st
          </Btn>
          <Btn
            className="small"
            onClick={() => {
              p.onSemitones(0)
              p.onCents(0)
            }}
            disabled={p.semitones === 0 && p.cents === 0}
          >
            Reset
          </Btn>
        </div>
        <Slider
          min={-50}
          max={50}
          step={1}
          value={p.cents}
          onChange={(e) => p.onCents(+e.target.value)}
          onDoubleClick={() => p.onCents(0)}
          aria-label="Fine tune in cents"
        />
        <div className="hint">A 440 Hz plays as {(440 * ratio).toFixed(1)} Hz</div>
      </section>
    </footer>
  )
}
