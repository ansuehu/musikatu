import type { TrainerSettings, TrainerState } from '../practice/trainer'
import { trainerProgress } from '../practice/trainer'
import { Btn, Slider } from './Controls'

export interface CountInPrefs {
  enabled: boolean
  bars: 1 | 2
  eachLoop: boolean
}

interface Props {
  countIn: CountInPrefs
  onCountIn: (c: CountInPrefs) => void
  hasGrid: boolean
  meter: number
  trainer: TrainerSettings
  onTrainer: (t: TrainerSettings) => void
  state: TrainerState | null
  onStart: () => void
  onStop: () => void
  hasFile: boolean
  loopReady: boolean
}

const pct = (x: number) => `${Math.round(x * 100)}%`

/** Count-in and speed-trainer settings (top of the Practice tab). */
export function PracticePanel(p: Props) {
  const t = p.trainer
  const st = p.state
  const set = (patch: Partial<TrainerSettings>) => p.onTrainer({ ...t, ...patch })
  return (
    <div className="practice-panel">
      <div className="section-title">
        <span className="label">Count-in</span>
        <Btn className={`small ${p.countIn.enabled ? 'on' : ''}`} onClick={() => p.onCountIn({ ...p.countIn, enabled: !p.countIn.enabled })} title="Click a bar before playback starts (I)">
          {p.countIn.enabled ? 'On' : 'Off'}
        </Btn>
      </div>
      <div className="metro-row">
        <span className="muted small-text">Length</span>
        <div className="segmented">
          {([1, 2] as const).map((b) => (
            <Btn key={b} className={`small ${p.countIn.bars === b ? 'on' : ''}`} onClick={() => p.onCountIn({ ...p.countIn, bars: b })}>
              {b} bar{b > 1 ? 's' : ''}
            </Btn>
          ))}
        </div>
        <span className="muted small-text">({p.countIn.bars * p.meter} clicks)</span>
      </div>
      <label className="check small-text">
        <input type="checkbox" checked={p.countIn.eachLoop} onChange={(e) => p.onCountIn({ ...p.countIn, eachLoop: e.target.checked })} />
        Count in again before every loop repeat
      </label>
      <p className="muted small-text">
        {p.hasGrid
          ? 'Uses the song’s tempo at your current speed, with the metronome sounds.'
          : 'No beat grid yet: counts at 100 BPM (at your current speed).'}
      </p>

      <div className="section-title">
        <span className="label">Speed trainer</span>
        {st?.active ? (
          <Btn className="small on" onClick={p.onStop} title="Stop the trainer (R)">
            Stop
          </Btn>
        ) : (
          <Btn className="small" disabled={!p.hasFile} onClick={p.onStart} title="Start at the first speed and speed up as you repeat the loop (R)">
            Start
          </Btn>
        )}
      </div>
      <p className="muted small-text">
        {p.loopReady ? 'Loops the current selection, getting faster as you repeat it.' : 'Select a passage first (or a saved loop); without one it loops the whole song.'}
      </p>
      <label className="metro-field">
        <span className="muted small-text">Start</span>
        <Slider min={0.25} max={1.5} step={0.05} value={t.from} onChange={(e) => set({ from: +e.target.value })} />
        <span className="value">{pct(t.from)}</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Target</span>
        <Slider min={0.25} max={1.5} step={0.05} value={t.to} onChange={(e) => set({ to: +e.target.value })} />
        <span className="value">{pct(t.to)}</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Step</span>
        <Slider min={0.01} max={0.2} step={0.01} value={t.step} onChange={(e) => set({ step: +e.target.value })} />
        <span className="value">+{pct(t.step)}</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Every</span>
        <Slider min={1} max={8} step={1} value={t.every} onChange={(e) => set({ every: +e.target.value })} />
        <span className="value">
          {t.every} pass{t.every > 1 ? 'es' : ''}
        </span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">At target</span>
        <select className="select" value={t.atTarget} onChange={(e) => (set({ atTarget: e.target.value as TrainerSettings['atTarget'] }), e.currentTarget.blur())}>
          <option value="hold">keep looping</option>
          <option value="restart">start over from {pct(t.from)}</option>
          <option value="stop">stop playback</option>
        </select>
        <span />
      </label>
      {st && (st.active || st.pass > 0) && (
        <div className="trainer-progress">
          <div className="progress">
            <div style={{ width: `${trainerProgress(st, t) * 100}%` }} />
          </div>
          <span className="muted small-text">
            Pass {st.pass} · now {pct(st.speed)} · {t.every - st.passesAtSpeed} more at this speed
            {!st.active && st.stop ? ' · done!' : ''}
          </span>
        </div>
      )}
    </div>
  )
}
