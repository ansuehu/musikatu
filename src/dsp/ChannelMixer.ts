export type ChannelMode = 'stereo' | 'mono' | 'left' | 'right' | 'karaoke' | 'karaoke-bass'

export const CHANNEL_MODES: { id: ChannelMode; label: string; hint: string }[] = [
  { id: 'stereo', label: 'Stereo', hint: 'Unchanged' },
  { id: 'mono', label: 'Mono', hint: 'L + R mixed to both speakers' },
  { id: 'left', label: 'Left only', hint: 'Isolate whatever is panned left' },
  { id: 'right', label: 'Right only', hint: 'Isolate whatever is panned right' },
  { id: 'karaoke', label: 'Vocal cut', hint: 'L − R: cancels anything panned dead centre (usually lead vocal, bass, kick)' },
  { id: 'karaoke-bass', label: 'Vocal cut, keep bass', hint: 'L − R, plus the centre below ~180 Hz so the bass line survives' },
]

/** Low-pass crossover used by the bass-preserving vocal cut. */
export const KARAOKE_CROSSOVER = 180

/** Per-sample channel remixing (centre-channel cancellation etc.), run after the stretcher. */
export class ChannelMixer {
  mode: ChannelMode = 'stereo'
  private readonly b0: number
  private readonly b1: number
  private readonly b2: number
  private readonly a1: number
  private readonly a2: number
  private z1 = 0
  private z2 = 0

  constructor(sampleRate: number, crossover = KARAOKE_CROSSOVER) {
    // RBJ biquad low-pass, Q = 1/sqrt(2)
    const w = (2 * Math.PI * crossover) / sampleRate
    const alpha = Math.sin(w) / Math.SQRT2
    const cos = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 - cos) / 2 / a0
    this.b1 = (1 - cos) / a0
    this.b2 = this.b0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
  }

  process(out: Float32Array[], frames: number): void {
    if (out.length < 2 || this.mode === 'stereo') return
    const L = out[0]
    const R = out[1]
    switch (this.mode) {
      case 'mono':
        for (let i = 0; i < frames; i++) L[i] = R[i] = 0.5 * (L[i] + R[i])
        break
      case 'left':
        R.set(L.subarray(0, frames))
        break
      case 'right':
        L.set(R.subarray(0, frames))
        break
      case 'karaoke':
        for (let i = 0; i < frames; i++) L[i] = R[i] = L[i] - R[i]
        break
      case 'karaoke-bass':
        for (let i = 0; i < frames; i++) {
          const mid = 0.5 * (L[i] + R[i])
          // transposed direct form II
          const low = this.b0 * mid + this.z1
          this.z1 = this.b1 * mid - this.a1 * low + this.z2
          this.z2 = this.b2 * mid - this.a2 * low
          L[i] = R[i] = L[i] - R[i] + low
        }
        break
    }
  }
}
