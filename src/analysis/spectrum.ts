import { FFT } from '../dsp/fft.ts'
import { KARAOKE_CROSSOVER, type ChannelMode } from '../dsp/ChannelMixer.ts'

/**
 * Magnitude spectrum of the *source* around a position, remixed the way the
 * playback chain remixes it. Analysing the decoded buffer directly (instead of
 * tapping the output) means it also works while paused and at any speed.
 */
export class SpectrumAnalyzer {
  readonly size: number
  /** Linear magnitudes, full-scale sine ≈ 1. Index = source bin. */
  readonly mags: Float32Array
  private readonly fft: FFT
  private readonly window: Float64Array
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly scale: number

  constructor(size = 16384) {
    this.size = size
    this.fft = new FFT(size)
    this.window = new Float64Array(size)
    let sum = 0
    for (let n = 0; n < size; n++) {
      // 4-term Blackman-Harris: ~92 dB sidelobes, keeps quiet notes visible next to loud ones
      const x = (2 * Math.PI * n) / size
      const w = 0.35875 - 0.48829 * Math.cos(x) + 0.14128 * Math.cos(2 * x) - 0.01168 * Math.cos(3 * x)
      this.window[n] = w
      sum += w
    }
    this.scale = 2 / sum
    this.re = new Float64Array(size)
    this.im = new Float64Array(size)
    this.mags = new Float32Array(size / 2)
  }

  /**
   * @param weights optional per-bin linear gain (e.g. the EQ's response), length size/2
   * @param sampleRate needed only for the bass-preserving vocal cut crossover
   */
  analyze(channels: Float32Array[], center: number, mode: ChannelMode, sampleRate: number, weights?: Float32Array | null): Float32Array {
    const N = this.size
    const { re, im, window, mags } = this
    const L = channels[0]
    const R = channels[1] ?? L
    const len = L.length
    const start = Math.round(center) - N / 2
    const split = mode === 'karaoke-bass'
    for (let n = 0; n < N; n++) {
      const i = start + n
      let l = 0
      let r = 0
      if (i >= 0 && i < len) {
        l = L[i]
        r = R[i]
      }
      const w = window[n]
      im[n] = 0
      switch (mode) {
        case 'left': re[n] = l * w; break
        case 'right': re[n] = r * w; break
        case 'karaoke': re[n] = (l - r) * w; break
        case 'karaoke-bass':
          // side in the real part, mid in the imaginary part; separated after one FFT
          re[n] = (l - r) * w
          im[n] = 0.5 * (l + r) * w
          break
        default: re[n] = 0.5 * (l + r) * w
      }
    }
    this.fft.transform(re, im, false)
    const half = N / 2
    const crossoverBin = (KARAOKE_CROSSOVER / sampleRate) * N
    for (let k = 0; k < half; k++) {
      let m: number
      if (split) {
        const j = (N - k) % N
        const sRe = 0.5 * (re[k] + re[j])
        const sIm = 0.5 * (im[k] - im[j])
        const mRe = 0.5 * (im[k] + im[j])
        const mIm = -0.5 * (re[k] - re[j])
        const lp = 1 / Math.sqrt(1 + (k / crossoverBin) ** 4)
        m = Math.hypot(sRe + lp * mRe, sIm + lp * mIm)
      } else {
        m = Math.hypot(re[k], im[k])
      }
      mags[k] = m * this.scale * (weights ? weights[k] : 1)
    }
    return mags
  }
}
