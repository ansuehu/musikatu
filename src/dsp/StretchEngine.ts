import { FFT } from './fft.ts'

const TWO_PI = Math.PI * 2
/** Stretched-stream FIFO capacity and the read index at which it gets compacted. */
const FIFO_SIZE = 32768
const COMPACT_AT = 16384
/** Ring of recent analysis-frame centres, used to label output with source positions. */
const RING = 16
/** Fade-in length after every reset (seek / play), to avoid clicks. */
const FADE_IN = 256
export const MIN_LOOP = 64

function princArg(x: number): number {
  return x - TWO_PI * Math.round(x / TWO_PI)
}

function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c1 = 0.5 * (x1 - xm1)
  const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2
  const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1)
  return ((c3 * t + c2) * t + c1) * t + x0
}

/**
 * Real-time tempo / pitch engine reading from a fully decoded source.
 *
 * A phase vocoder with identity phase locking (Laroche & Dolson) stretches the
 * source by `pitch / speed`; a Hermite resampler then reads that stretched
 * stream `pitch` times faster. Net result: tempo scales by `speed`, pitch by
 * `pitch`, independently. At speed = pitch = 1 the vocoder reconstructs the
 * input exactly, so 100% playback is bit-faithful (up to float rounding).
 *
 * Positions are in source samples. Every stretched sample carries the source
 * position it came from, so the reported playhead is latency-compensated and
 * stays correct across loop wraps and speed changes.
 */
export class StretchEngine {
  readonly frameSize: number
  readonly hop: number
  private readonly bins: number
  /** Frames between a frame's analysis and the stretched block at its centre. */
  private readonly lag: number
  private readonly fft: FFT
  private readonly window: Float64Array
  private readonly norm: number

  private source: Float32Array[] = []
  /** Extra sources (e.g. separated stems) mixed into the input before stretching. */
  private layers: Float32Array[][] = []
  /** Gain per source: index 0 is the main source, then one per layer. */
  private gains = new Float32Array([1])
  private _length = 0

  private speed = 1
  private pitch = 1

  private loopOn = false
  private loopStart = 0
  private loopEnd = 0

  /** Centre of the next analysis frame, in *unwrapped* source samples (keeps growing across loop wraps). */
  private anaPos = 0
  private lastStart = 0
  private hasPrev = false
  private frameCount = 0
  private resetPos = 0
  private readonly centers = new Float64Array(RING)

  private prevPhase: Float64Array[] = []
  private synthPhase: Float64Array[] = []
  private ola: Float64Array[] = []
  private fifo: Float32Array[] = []
  private readonly fifoPos = new Float64Array(FIFO_SIZE)
  private fifoWrite = 0
  private readIdx = 0
  private fadeIn = 0

  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly mag: Float64Array
  private readonly phase: Float64Array
  private readonly peaks: Int32Array

  ended = false

  constructor(frameSize = 4096, overlap = 4) {
    this.frameSize = frameSize
    this.hop = frameSize / overlap
    this.bins = frameSize / 2 + 1
    this.lag = frameSize / 2 / this.hop
    this.fft = new FFT(frameSize)
    this.window = new Float64Array(frameSize)
    let sumSq = 0
    for (let n = 0; n < frameSize; n++) {
      const w = 0.5 - 0.5 * Math.cos((TWO_PI * n) / frameSize)
      this.window[n] = w
      sumSq += w * w
    }
    // Overlapping analysis*synthesis windows sum to sumSq / hop; undo that gain.
    this.norm = this.hop / sumSq
    this.re = new Float64Array(frameSize)
    this.im = new Float64Array(frameSize)
    this.mag = new Float64Array(this.bins)
    this.phase = new Float64Array(this.bins)
    this.peaks = new Int32Array(this.bins)
  }

  get length(): number {
    return this._length
  }

  get channelCount(): number {
    return this.source.length
  }

  setSource(channels: Float32Array[]): void {
    this.source = channels
    this.layers = []
    this.gains = new Float32Array([1])
    this._length = channels[0]?.length ?? 0
    const n = channels.length
    this.prevPhase = Array.from({ length: n }, () => new Float64Array(this.bins))
    this.synthPhase = Array.from({ length: n }, () => new Float64Array(this.bins))
    this.ola = Array.from({ length: n }, () => new Float64Array(this.frameSize))
    this.fifo = Array.from({ length: n }, () => new Float32Array(FIFO_SIZE))
    this.loopOn = false
    this.reset(0)
  }

  /** Adds sources of the same length as the main one; they start silent until setGains. */
  addLayers(layers: Float32Array[][]): void {
    this.layers.push(...layers)
    const g = new Float32Array(1 + this.layers.length)
    g.set(this.gains.subarray(0, Math.min(this.gains.length, g.length)))
    this.gains = g
  }

  /** Gain changes take effect from the next analysis frame; the overlap-add crossfades them. */
  setGains(gains: ArrayLike<number>): void {
    for (let i = 0; i < Math.min(gains.length, this.gains.length); i++) this.gains[i] = gains[i]
  }

  setParams(speed: number, pitch: number): void {
    this.speed = Math.min(4, Math.max(0.01, speed))
    this.pitch = Math.min(4, Math.max(0.25, pitch))
  }

  setLoop(enabled: boolean, start: number, end: number): void {
    // Fold the unwrapped cursor back into the old loop first, so it is a real
    // source position before the new region (or no region) takes over.
    if (this.loopOn && this.anaPos >= this.loopEnd) {
      const d = this.mapPos(this.anaPos) - this.anaPos
      this.anaPos += d
      this.lastStart += d
    }
    this.loopStart = Math.max(0, Math.round(Math.min(start, end)))
    this.loopEnd = Math.min(this._length, Math.round(Math.max(start, end)))
    this.loopOn = enabled && this.loopEnd - this.loopStart >= MIN_LOOP
  }

  /** Restart output at `position` (source samples). */
  reset(position: number): void {
    const pos = Math.max(0, position)
    const haF = this.analysisHop()
    // Prime so the first sample we emit sits at the centre of a frame whose
    // analysis centre is exactly `pos` (see the labelling in produceFrame).
    this.anaPos = pos - this.lag * haF
    this.hasPrev = false
    this.frameCount = 0
    for (const o of this.ola) o.fill(0)
    this.fifoWrite = 0
    this.readIdx = 2 * this.lag * this.hop
    this.resetPos = this.mapPos(pos)
    this.fadeIn = FADE_IN
    this.ended = !this.loopOn && pos >= this._length
  }

  /** Source position of the next sample to be rendered. */
  get position(): number {
    const qi = Math.floor(this.readIdx)
    return qi < this.fifoWrite ? this.fifoPos[qi] : this.resetPos
  }

  render(out: Float32Array[], frames: number): void {
    const nOut = out.length
    const nSrc = this.source.length
    if (nSrc === 0) {
      for (const o of out) o.fill(0, 0, frames)
      return
    }
    for (let i = 0; i < frames; i++) {
      const qi = Math.floor(this.readIdx)
      while (qi + 2 >= this.fifoWrite) this.produceFrame()
      const t = this.readIdx - qi
      let g = 1
      if (this.fadeIn > 0) {
        g = 1 - this.fadeIn / FADE_IN
        this.fadeIn--
      }
      for (let c = 0; c < nOut; c++) {
        const f = this.fifo[c < nSrc ? c : nSrc - 1]
        out[c][i] = g * hermite(f[qi - 1], f[qi], f[qi + 1], f[qi + 2], t)
      }
      this.readIdx += this.pitch
      if (this.readIdx > COMPACT_AT) this.compact()
    }
    if (!this.loopOn && this.position >= this._length) this.ended = true
  }

  private analysisHop(): number {
    return (this.hop * this.speed) / this.pitch
  }

  private mapPos(x: number): number {
    if (this.loopOn && x >= this.loopEnd) {
      return this.loopStart + ((x - this.loopEnd) % (this.loopEnd - this.loopStart))
    }
    return x
  }

  private compact(): void {
    const shift = Math.floor(this.readIdx) - 4
    for (const f of this.fifo) f.copyWithin(0, shift, this.fifoWrite)
    this.fifoPos.copyWithin(0, shift, this.fifoWrite)
    this.fifoWrite -= shift
    this.readIdx -= shift
  }

  private produceFrame(): void {
    const N = this.frameSize
    const hop = this.hop
    const half = N >> 1
    const bins = this.bins
    const haF = this.analysisHop()
    const start = Math.floor(this.anaPos) - half
    // The true (integer) analysis hop since the previous frame, so phase
    // advance stays exact even though the requested hop is fractional.
    const ha = this.hasPrev ? Math.max(1, start - this.lastStart) : haF
    const { re, im, mag, phase, window, peaks } = this
    const len = this._length
    const loopOn = this.loopOn
    const loopStart = this.loopStart
    const loopEnd = this.loopEnd
    const loopLen = loopEnd - loopStart
    const w0 = this.fifoWrite

    // Sources contributing to this frame (just the main one in the common case).
    const active: { chs: Float32Array[]; g: number }[] = []
    if (this.gains[0] !== 0) active.push({ chs: this.source, g: this.gains[0] })
    for (let l = 0; l < this.layers.length; l++) if (this.gains[l + 1] !== 0) active.push({ chs: this.layers[l], g: this.gains[l + 1] })
    const direct = active.length === 1 && active[0].g === 1 && active[0].chs === this.source

    for (let c = 0; c < this.source.length; c++) {
      const src = this.source[c]
      for (let n = 0; n < N; n++) {
        let idx = start + n
        if (loopOn && idx >= loopEnd) idx = loopStart + ((idx - loopEnd) % loopLen)
        im[n] = 0
        if (idx < 0 || idx >= len) {
          re[n] = 0
        } else if (direct) {
          re[n] = src[idx] * window[n]
        } else {
          let v = 0
          for (const a of active) v += a.g * a.chs[c < a.chs.length ? c : a.chs.length - 1][idx]
          re[n] = v * window[n]
        }
      }
      this.fft.transform(re, im, false)
      for (let k = 0; k < bins; k++) {
        mag[k] = Math.hypot(re[k], im[k])
        phase[k] = Math.atan2(im[k], re[k])
      }

      const prev = this.prevPhase[c]
      const syn = this.synthPhase[c]
      if (!this.hasPrev) {
        syn.set(phase)
      } else {
        let np = 0
        for (let k = 1; k < bins - 1; k++) {
          if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks[np++] = k
        }
        if (np === 0) {
          for (let k = 0; k < bins; k++) peaks[np++] = k
        }
        // Advance each peak by its instantaneous frequency...
        for (let j = 0; j < np; j++) {
          const k = peaks[j]
          const omega = (TWO_PI * k) / N
          const dphi = princArg(phase[k] - prev[k] - omega * ha)
          syn[k] = princArg(syn[k] + (omega + dphi / ha) * hop)
        }
        // ...and lock every other bin to its nearest peak's phase rotation.
        let j = 0
        for (let k = 0; k < bins; k++) {
          while (j + 1 < np && Math.abs(peaks[j + 1] - k) < Math.abs(k - peaks[j])) j++
          const p = peaks[j]
          if (p !== k) syn[k] = syn[p] + phase[k] - phase[p]
        }
      }
      prev.set(phase)

      for (let k = 0; k < bins; k++) {
        re[k] = mag[k] * Math.cos(syn[k])
        im[k] = mag[k] * Math.sin(syn[k])
      }
      for (let k = 1; k < half; k++) {
        re[N - k] = re[k]
        im[N - k] = -im[k]
      }
      this.fft.transform(re, im, true)

      const ola = this.ola[c]
      const scale = this.norm / N
      for (let n = 0; n < N; n++) ola[n] += re[n] * window[n] * scale
      const f = this.fifo[c]
      for (let n = 0; n < hop; n++) f[w0 + n] = ola[n]
      ola.copyWithin(0, hop)
      ola.fill(0, N - hop)
    }

    // Stretched block k is centred on synthesis frame k - lag, whose analysis
    // centre we recorded `lag` frames ago.
    const k = this.frameCount
    const ratio = haF / hop
    const base = k >= this.lag ? this.centers[(k - this.lag) % RING] : this.mapPos(this.anaPos)
    for (let n = 0; n < hop; n++) this.fifoPos[w0 + n] = this.mapPos(base + n * ratio)
    this.centers[k % RING] = this.mapPos(this.anaPos)

    this.fifoWrite += hop
    this.lastStart = start
    this.hasPrev = true
    this.frameCount++
    this.anaPos += haF
  }
}
