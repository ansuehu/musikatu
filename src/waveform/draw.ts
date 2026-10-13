import { rangeOf, type Peaks, type Range } from './peaks'

export const colors = {
  bg: '#0d0f13',
  lane: '#11141a',
  axis: '#252b38',
  peak: '#1f8a7a',
  rms: '#5fe3c6',
  line: '#7ff0d8',
  ruler: '#151922',
  rulerText: '#8590a6',
  tick: '#3a4255',
  playhead: '#ff5a4f',
  selection: 'rgba(140, 165, 210, 0.16)',
  selectionEdge: 'rgba(170, 190, 230, 0.7)',
  loop: 'rgba(255, 181, 71, 0.17)',
  loopEdge: '#ffb547',
  viewport: 'rgba(255, 255, 255, 0.08)',
  viewportEdge: 'rgba(255, 255, 255, 0.45)',
  markerSelected: '#ffffff',
}

export const markerColors = {
  section: '#b48cff',
  measure: '#9aa6c0',
  beat: '#6f7b94',
}

const scratch: Range = { min: 0, max: 0, rms: 0 }

/**
 * Draws all channels (max 2) stacked in the box (x0, y0, w, h), device pixels.
 * `start` is the sample at x0, `spp` samples per device pixel.
 */
export function drawWave(
  g: CanvasRenderingContext2D,
  peaks: Peaks,
  x0: number,
  y0: number,
  w: number,
  h: number,
  start: number,
  spp: number,
  dpr: number,
): void {
  const nCh = Math.min(peaks.channels.length, 2)
  const laneH = h / nCh
  g.fillStyle = colors.lane
  g.fillRect(x0, y0, w, h)

  for (let c = 0; c < nCh; c++) {
    const mid = Math.round(y0 + laneH * (c + 0.5))
    const amp = laneH * 0.46
    g.fillStyle = colors.axis
    g.fillRect(x0, mid, w, 1)
    if (c > 0) g.fillRect(x0, Math.round(y0 + laneH * c), w, 1)

    if (spp >= 1) {
      const lo = new Float32Array(w)
      const hi = new Float32Array(w)
      const rms = new Float32Array(w)
      for (let x = 0; x < w; x++) {
        const s0 = start + x * spp
        rangeOf(peaks, c, s0, s0 + spp, scratch)
        lo[x] = scratch.min
        hi[x] = scratch.max
        rms[x] = scratch.rms
      }
      g.fillStyle = colors.peak
      for (let x = 0; x < w; x++) {
        if (hi[x] < lo[x]) continue
        const top = mid - hi[x] * amp
        g.fillRect(x0 + x, top, 1, Math.max(1, (hi[x] - lo[x]) * amp))
      }
      g.fillStyle = colors.rms
      for (let x = 0; x < w; x++) {
        if (hi[x] < lo[x]) continue
        const top = Math.min(rms[x], hi[x])
        const bottom = Math.max(-rms[x], lo[x])
        if (top > bottom) g.fillRect(x0 + x, mid - top * amp, 1, Math.max(1, (top - bottom) * amp))
      }
    } else {
      // Zoomed past one sample per pixel: draw the actual sample curve.
      const data = peaks.channels[c]
      const i0 = Math.max(0, Math.floor(start) - 1)
      const i1 = Math.min(peaks.length - 1, Math.ceil(start + w * spp) + 1)
      g.save()
      g.beginPath()
      g.rect(x0, y0, w, h)
      g.clip()
      g.strokeStyle = colors.line
      g.lineWidth = Math.max(1, dpr)
      g.beginPath()
      for (let i = i0; i <= i1; i++) {
        const x = x0 + (i - start) / spp
        const y = mid - data[i] * amp
        if (i === i0) g.moveTo(x, y)
        else g.lineTo(x, y)
      }
      g.stroke()
      if (1 / spp >= 8) {
        g.fillStyle = colors.line
        const r = 2 * dpr
        for (let i = i0; i <= i1; i++) {
          g.fillRect(x0 + (i - start) / spp - r / 2, mid - data[i] * amp - r / 2, r, r)
        }
      }
      g.restore()
    }
  }
}

const STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200]

/** Time ruler across (0, 0, w, h) in device pixels. */
export function drawRuler(
  g: CanvasRenderingContext2D,
  w: number,
  h: number,
  start: number,
  spp: number,
  sampleRate: number,
  dpr: number,
): void {
  g.fillStyle = colors.ruler
  g.fillRect(0, 0, w, h)
  const secPerPx = (spp / sampleRate) * dpr // per CSS pixel
  const step = STEPS.find((s) => s / secPerPx >= 90) ?? STEPS[STEPS.length - 1]
  const minor = step / 5
  const t0 = start / sampleRate
  const t1 = (start + w * spp) / sampleRate
  const toX = (t: number) => (t * sampleRate - start) / spp
  if (!Number.isFinite(t1) || (t1 - t0) / minor > 5000) return

  g.fillStyle = colors.tick
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = Math.round(toX(t))
    g.fillRect(x, h - 4 * dpr, 1, 4 * dpr)
  }
  g.font = `${11 * dpr}px ui-monospace, "JetBrains Mono", Menlo, monospace`
  g.textBaseline = 'top'
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(toX(t))
    g.fillStyle = colors.tick
    g.fillRect(x, h - 9 * dpr, 1, 9 * dpr)
    g.fillStyle = colors.rulerText
    g.fillText(formatTime(t, step), x + 4 * dpr, 4 * dpr)
  }
  g.fillStyle = colors.axis
  g.fillRect(0, h - 1, w, 1)
}

/** m:ss with as many decimals as `resolution` (seconds) needs. */
export function formatTime(seconds: number, resolution = 0.001): string {
  const decimals = resolution >= 1 ? 0 : resolution >= 0.1 ? 1 : resolution >= 0.01 ? 2 : 3
  const f = 10 ** decimals
  const s = Math.round(Math.max(0, seconds) * f) / f
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  const secs = rest.toFixed(decimals).padStart(decimals ? decimals + 3 : 2, '0')
  return `${m}:${secs}`
}
