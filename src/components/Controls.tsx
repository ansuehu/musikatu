import { useEffect, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react'
import { formatTime } from '../waveform/draw'
import { positionInfo, tempoBpm, type BeatGrid } from '../rhythm/grid'

/** Button that never takes keyboard focus, so Space always reaches the global play/pause shortcut. */
export function Btn({ className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" className={`btn ${className}`} onMouseDown={(e) => e.preventDefault()} {...rest} />
}

/** Range input that hands focus back after use, so arrow keys keep driving transport shortcuts. */
export function Slider(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="range" onPointerUp={(e) => e.currentTarget.blur()} {...props} />
}

/** Clock updated straight from the engine every frame, bypassing React renders. */
export function Clock({ getPosition, sampleRate, length }: { getPosition: () => number; sampleRate: number; length: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const text = formatTime(getPosition() / sampleRate)
      if (text !== last && ref.current) ref.current.textContent = last = text
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [getPosition, sampleRate])
  return (
    <div className="clock">
      <span ref={ref} className="clock-now">
        0:00.000
      </span>
      <span className="clock-total">/ {formatTime(length / sampleRate, 0.01)}</span>
    </div>
  )
}

/** "Bar 17 · 3" under the clock, updated every frame straight from the engine. */
export function BarClock({ grid, getPosition, sampleRate, speed }: { grid: BeatGrid | null; getPosition: () => number; sampleRate: number; speed: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!grid) return
    let raf = 0
    let last = ''
    const tick = () => {
      raf = requestAnimationFrame(tick)
      const info = positionInfo(grid, getPosition())
      const text = info.index < 0 ? 'Before bar 1' : `Bar ${info.bar} · ${info.beat}`
      if (text !== last && ref.current) ref.current.textContent = last = text
    }
    tick()
    return () => cancelAnimationFrame(raf)
  }, [grid, getPosition])
  if (!grid) return null
  const bpm = tempoBpm(grid, sampleRate)
  return (
    <div className="bar-clock">
      <span ref={ref} className="bar-now" />
      {bpm && (
        <span className="muted">
          {' '}
          · ♩ {(bpm * speed).toFixed(speed === 1 ? 1 : 0)}
          {speed !== 1 ? ` (${bpm.toFixed(0)})` : ''}
        </span>
      )}
    </div>
  )
}
