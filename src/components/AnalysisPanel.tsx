import { useEffect, useRef, useState } from 'react'
import type { AudioEngine, Timbre } from '../audio/AudioEngine'
import { SpectrumAnalyzer } from '../analysis/spectrum'
import { chordName, estimateNotes, HIGHEST_KEY, LOWEST_KEY, midiToFreq, noteName, type NoteEstimate, type Spelling } from '../analysis/notes'
import type { ChannelMode } from '../dsp/ChannelMixer'
import type { Peaks } from '../waveform/peaks'
import { Btn } from './Controls'
import { GuitarPanel } from './GuitarPanel'

interface Props {
  engine: AudioEngine | null
  peaks: Peaks | null
  getPosition: () => number
  pitchRatio: number
  channelMode: ChannelMode
  /** EQ magnitude per analyser bin, or null when flat. */
  eqWeights: Float32Array | null
  /** When stems are playing: the audible sources and their gains, so analysis follows what you hear. */
  layers: { id: string; channels: Float32Array[]; gain: number }[] | null
  transpose: number
  spelling: Spelling
  a4: number
  onA4: (hz: number) => void
  timbre: Timbre
  onTimbre: (t: Timbre) => void
  showGuitar: boolean
  onShowGuitar: (on: boolean) => void
  capo: number
  onCapo: (c: number) => void
}

const KEYS_H = 62
const DB_FLOOR = -90
const DB_TOP = -12
const BLACK = new Set([1, 3, 6, 8, 10])
const isBlack = (m: number) => BLACK.has(m % 12)
const WHITE_KEYS = 52
const ANALYSIS_INTERVAL_MS = 33

interface KeyGeom {
  x0: Float64Array
  x1: Float64Array
  center: Float64Array
}

/** Piano geometry over width W, for A0..C8. */
function keyGeometry(W: number): KeyGeom {
  const x0 = new Float64Array(128)
  const x1 = new Float64Array(128)
  const center = new Float64Array(128)
  const ww = W / WHITE_KEYS
  const bw = ww * 0.62
  let wi = 0
  for (let m = LOWEST_KEY; m <= HIGHEST_KEY; m++) {
    if (isBlack(m)) {
      const c = wi * ww
      x0[m] = c - bw / 2
      x1[m] = c + bw / 2
      center[m] = c
    } else {
      x0[m] = wi * ww
      x1[m] = (wi + 1) * ww
      center[m] = x0[m] + ww / 2
      wi++
    }
  }
  return { x0, x1, center }
}

/** Fractional MIDI note at each pixel column (inverse of the key-centre mapping). */
function pixelMidi(geom: KeyGeom, W: number): Float64Array {
  const out = new Float64Array(W + 1)
  let m = LOWEST_KEY
  for (let x = 0; x <= W; x++) {
    while (m < HIGHEST_KEY - 1 && geom.center[m + 1] < x) m++
    const c0 = geom.center[m]
    const c1 = geom.center[m + 1]
    out[x] = m + (x - c0) / (c1 - c0)
  }
  return out
}

/** Real-time spectrum aligned to an 88-key reference piano, with note / chord estimation. */
export function AnalysisPanel(props: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const [estimate, setEstimate] = useState<NoteEstimate | null>(null)
  const [hoverKey, setHoverKey] = useState<number | null>(null)
  const pressed = useRef<{ midi: number; release: () => void } | null>(null)
  const geomRef = useRef<{ W: number; dpr: number; geom: KeyGeom; px: Float64Array } | null>(null)
  const hoverRef = useRef<number | null>(null)
  hoverRef.current = hoverKey

  useEffect(() => {
    const canvas = canvasRef.current!
    const g = canvas.getContext('2d')!
    const analyzer = new SpectrumAnalyzer(16384)
    let raf = 0
    let lastAnalysis = 0
    let analysisKey = ''
    let est: NoteEstimate | null = null
    let mags: Float32Array | null = null
    let drawnKey = ''

    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(canvas.clientWidth * dpr)
      canvas.height = Math.round(canvas.clientHeight * dpr)
    })
    ro.observe(canvas)

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const p = latest.current
      const W = canvas.width
      const H = canvas.height
      if (!W || !H) return
      const dpr = W / canvas.clientWidth
      let geo = geomRef.current
      if (!geo || geo.W !== W) {
        const geom = keyGeometry(W)
        geo = geomRef.current = { W, dpr, geom, px: pixelMidi(geom, W) }
      }

      // --- analysis (throttled, and only when the inputs changed) ---
      const sr = p.engine?.sampleRate ?? 48000
      const binHz = (sr / analyzer.size) * p.pitchRatio
      if (p.peaks && now - lastAnalysis >= ANALYSIS_INTERVAL_MS) {
        const pos = p.getPosition()
        const key = `${p.peaks.id}|${Math.round(pos / 256)}|${p.channelMode}|${p.pitchRatio}|${p.a4}|${weightsId(p.eqWeights)}|${p.layers?.map((l) => `${l.id}:${l.gain.toFixed(3)}`).join(',') ?? 'mix'}`
        if (key !== analysisKey) {
          analysisKey = key
          lastAnalysis = now
          if (p.layers) {
            // Mix just the analysis window from the audible stems.
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
          est = estimateNotes(mags, binHz, p.a4)
          setEstimate(est)
        }
      } else if (!p.peaks && mags) {
        mags = null
        est = null
        setEstimate(null)
      }

      const pk = pressed.current?.midi ?? -1
      const dk = `${analysisKey}|${W}|${H}|${pk}|${hoverRef.current}|${p.transpose}|${p.spelling}`
      if (dk === drawnKey) return
      drawnKey = dk

      // --- drawing ---
      const keysH = Math.round(KEYS_H * dpr)
      const specH = H - keysH
      const { geom, px } = geo
      g.fillStyle = '#0b0d11'
      g.fillRect(0, 0, W, specH)

      // octave guides at every C
      g.fillStyle = '#1b2030'
      for (let m = 24; m <= HIGHEST_KEY; m += 12) g.fillRect(Math.round(geom.x0[m]), 0, 1, specH)
      // dB guides
      g.fillStyle = '#161a24'
      for (let db = -80; db <= DB_TOP; db += 20) g.fillRect(0, Math.round(dbToY(db, specH)), W, 1)

      if (mags) {
        const grad = g.createLinearGradient(0, 0, 0, specH)
        grad.addColorStop(0, 'rgba(127, 240, 216, 0.95)')
        grad.addColorStop(1, 'rgba(31, 138, 122, 0.25)')
        g.beginPath()
        g.moveTo(0, specH)
        for (let x = 0; x < W; x++) {
          const f0 = midiToFreq(px[x], p.a4) / binHz
          const f1 = midiToFreq(px[x + 1], p.a4) / binHz
          let m = 0
          if (f1 - f0 < 1) {
            const k = Math.floor(f0)
            const t = f0 - k
            m = (mags[k] ?? 0) * (1 - t) + (mags[k + 1] ?? 0) * t
          } else {
            for (let k = Math.floor(f0); k <= Math.ceil(f1) && k < mags.length; k++) if (mags[k] > m) m = mags[k]
          }
          g.lineTo(x, dbToY(20 * Math.log10(m + 1e-9), specH))
        }
        g.lineTo(W, specH)
        g.closePath()
        g.fillStyle = grad
        g.fill()
      }

      // detected notes: markers above the keys
      if (est) {
        g.fillStyle = '#ffb547'
        for (const n of est.notes) {
          const c = geom.center[n]
          g.fillRect(Math.round(c - 2 * dpr), specH - 5 * dpr, 4 * dpr, 5 * dpr)
        }
      }

      drawKeys(g, geom, specH, keysH, dpr, est, pk, hoverRef.current, p.transpose, p.spelling)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  // release any held reference tone if we unmount mid-press
  useEffect(() => () => pressed.current?.release(), [])

  const keyAt = (e: React.PointerEvent): number | null => {
    const geo = geomRef.current
    const canvas = canvasRef.current
    if (!geo || !canvas) return null
    const rect = canvas.getBoundingClientRect()
    const x = (e.clientX - rect.left) * geo.dpr
    const y = (e.clientY - rect.top) * geo.dpr
    const keysTop = canvas.height - KEYS_H * geo.dpr
    if (y < keysTop) return Math.round(geo.px[Math.max(0, Math.min(geo.W, Math.round(x)))])
    // black keys sit on top of the upper 62% of the keyboard
    if (y < keysTop + KEYS_H * geo.dpr * 0.62) {
      for (let m = LOWEST_KEY; m <= HIGHEST_KEY; m++) if (isBlack(m) && x >= geo.geom.x0[m] && x < geo.geom.x1[m]) return m
    }
    for (let m = LOWEST_KEY; m <= HIGHEST_KEY; m++) if (!isBlack(m) && x >= geo.geom.x0[m] && x < geo.geom.x1[m]) return m
    return null
  }

  const press = (m: number | null) => {
    const p = latest.current
    if (pressed.current?.midi === m) return
    pressed.current?.release()
    pressed.current = null
    if (m === null || !p.engine) return
    pressed.current = { midi: m, release: p.engine.playTone(midiToFreq(m, p.a4), p.timbre) }
  }

  const { transpose, spelling, a4 } = props
  const peak = estimate?.peak
  const hoverText = hoverKey !== null ? `${noteName(hoverKey, transpose, spelling)} · ${midiToFreq(hoverKey, a4).toFixed(1)} Hz` : ''

  return (
    <section className={`analysis ${props.showGuitar ? 'with-guitar' : ''}`}>
      <div className="analysis-canvas-wrap">
      <canvas
        ref={canvasRef}
        className="analysis-canvas"
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.currentTarget.setPointerCapture(e.pointerId)
          press(keyAt(e))
        }}
        onPointerMove={(e) => {
          const m = keyAt(e)
          setHoverKey(m)
          if (pressed.current) press(m)
        }}
        onPointerUp={() => press(null)}
        onPointerCancel={() => press(null)}
        onPointerLeave={() => !pressed.current && setHoverKey(null)}
      />
      </div>
      <div className="analysis-info">
        <div className="info-head">
          <span className="label">Chord guess</span>
          <Btn
            className={`small ${props.showGuitar ? 'on' : ''}`}
            onClick={() => props.onShowGuitar(!props.showGuitar)}
            title="Show the chord as a guitar diagram"
            aria-pressed={props.showGuitar}
          >
            Guitar
          </Btn>
        </div>
        <div className="chord">{estimate?.chord ? chordName(estimate.chord, transpose, spelling) : '—'}</div>
        <div className="notes">
          {estimate && estimate.notes.length > 0 ? estimate.notes.map((n) => noteName(n, transpose, spelling)).join('  ') : 'No clear notes'}
        </div>
        <div className="peak" title="Strongest frequency and its deviation from equal temperament">
          {peak ? (
            <>
              Peak {noteName(peak.midi, transpose, spelling)}{' '}
              <span className={Math.abs(peak.cents) <= 5 ? 'in-tune' : 'off-tune'}>
                {peak.cents >= 0 ? '+' : ''}
                {peak.cents.toFixed(0)}¢
              </span>{' '}
              · {peak.freq.toFixed(1)} Hz
            </>
          ) : (
            ' '
          )}
        </div>
        <div className="hover">{hoverText || 'Click keys for reference tones'}</div>
        <div className="ref-row">
          <label title="Tuning reference for reference tones, key positions and note detection">
            A4
            <input
              type="number"
              min={400}
              max={480}
              step={0.5}
              value={a4}
              onChange={(e) => {
                const v = +e.target.value
                if (v >= 400 && v <= 480) props.onA4(v)
              }}
            />
            Hz
          </label>
          <Btn className={`small ${props.timbre === 'piano' ? 'on' : ''}`} onClick={() => props.onTimbre('piano')}>
            Piano
          </Btn>
          <Btn className={`small ${props.timbre === 'sine' ? 'on' : ''}`} onClick={() => props.onTimbre('sine')}>
            Sine
          </Btn>
        </div>
      </div>
      {props.showGuitar && (
        <GuitarPanel
          chord={estimate?.chord ?? null}
          engine={props.engine}
          spelling={spelling}
          transpose={transpose}
          capo={props.capo}
          onCapo={props.onCapo}
          a4={a4}
        />
      )}
    </section>
  )
}

function dbToY(db: number, h: number): number {
  const t = (Math.max(DB_FLOOR, Math.min(DB_TOP, db)) - DB_FLOOR) / (DB_TOP - DB_FLOOR)
  return h - t * (h - 2)
}

const weightIds = new WeakMap<object, number>()
let nextWeightId = 1
function weightsId(w: Float32Array | null): number {
  if (!w) return 0
  let id = weightIds.get(w)
  if (!id) weightIds.set(w, (id = nextWeightId++))
  return id
}

function drawKeys(
  g: CanvasRenderingContext2D,
  geom: KeyGeom,
  top: number,
  h: number,
  dpr: number,
  est: NoteEstimate | null,
  pressedKey: number,
  hover: number | null,
  transpose: number,
  spelling: Spelling,
): void {
  const detected = new Set(est?.notes ?? [])
  const energy = est?.energy
  const W = geom.x1[HIGHEST_KEY]
  g.fillStyle = '#05060a'
  g.fillRect(0, top, W + 2, h)

  const tint = (m: number, base: [number, number, number]): string => {
    if (m === pressedKey) return '#49d6b8'
    if (detected.has(m)) return '#ffb547'
    const e = energy ? Math.min(1, energy[m] * 1.2) ** 1.5 : 0
    const accent: [number, number, number] = [73, 214, 184]
    const mix = (i: number) => Math.round(base[i] + (accent[i] - base[i]) * e * 0.7)
    const hov = m === hover ? 18 : 0
    return `rgb(${mix(0) - hov}, ${mix(1) - hov}, ${mix(2) - hov})`
  }

  g.font = `${9 * dpr}px Inter, system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'bottom'
  for (let m = LOWEST_KEY; m <= HIGHEST_KEY; m++) {
    if (isBlack(m)) continue
    const x0 = Math.round(geom.x0[m])
    const x1 = Math.round(geom.x1[m])
    g.fillStyle = tint(m, [222, 226, 234])
    g.fillRect(x0 + 0.5 * dpr, top, x1 - x0 - dpr, h - dpr)
    if ((m + transpose) % 12 === 0) {
      g.fillStyle = '#5a6378'
      g.fillText(noteName(m, transpose, spelling), (x0 + x1) / 2, top + h - 3 * dpr)
    }
  }
  const bh = Math.round(h * 0.62)
  for (let m = LOWEST_KEY; m <= HIGHEST_KEY; m++) {
    if (!isBlack(m)) continue
    const x0 = Math.round(geom.x0[m])
    const x1 = Math.round(geom.x1[m])
    g.fillStyle = tint(m, [28, 32, 42])
    g.fillRect(x0, top, x1 - x0, bh)
  }
  g.textAlign = 'start'
}
