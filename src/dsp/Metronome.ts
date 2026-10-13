/**
 * Click track locked to source positions. Each render quantum covers source span [from, to);
 * any beat inside it starts a click at the proportional output offset, so the click stays on
 * the beat at any playback speed and across loop wraps.
 */
export class Metronome {
  enabled = false
  volume = 0.6
  private positions: Float64Array = new Float64Array(0)
  private accents: Uint8Array = new Uint8Array(0)
  private voices: { age: number; freq: number; gain: number; delay: number }[] = []
  private readonly sampleRate: number
  private readonly length: number

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
    this.length = Math.round(0.045 * sampleRate)
  }

  setClicks(positions: Float64Array, accents: Uint8Array): void {
    this.positions = positions
    this.accents = accents
  }

  /** Beats in [a, b). */
  private collect(a: number, b: number, span: number, offset: number, frames: number): void {
    const p = this.positions
    let lo = 0
    let hi = p.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (p[mid] < a) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < p.length && p[i] < b; i++) {
      const delay = Math.min(frames - 1, Math.max(0, Math.round(offset + ((p[i] - a) / span) * frames)))
      const accent = this.accents[i] === 1
      this.voices.push({ age: 0, delay, freq: accent ? 1760 : 1175, gain: accent ? 1 : 0.6 })
    }
  }

  render(out: Float32Array[], frames: number, from: number, to: number, loop: { start: number; end: number } | null): void {
    if (this.enabled && this.positions.length) {
      if (to > from) {
        // ignore seeks: a jump far bigger than one quantum at max speed isn't playback
        if (to - from < frames * 8) this.collect(from, to, to - from, 0, frames)
      } else if (loop && from < loop.end) {
        // wrapped around the loop end within this quantum
        const span = loop.end - from + (to - loop.start)
        if (span > 0 && span < frames * 8) {
          this.collect(from, loop.end, span, 0, frames)
          this.collect(loop.start, to, span, ((loop.end - from) / span) * frames, frames)
        }
      }
    }
    if (this.voices.length === 0) return
    const twoPiOverSr = (2 * Math.PI) / this.sampleRate
    const decay = this.length / 5
    for (const v of this.voices) {
      for (let i = v.delay; i < frames && v.age < this.length; i++, v.age++) {
        const s = this.volume * v.gain * Math.exp(-v.age / decay) * Math.sin(v.age * v.freq * twoPiOverSr) * 0.5
        for (const ch of out) ch[i] += s
      }
      v.delay = 0
    }
    this.voices = this.voices.filter((v) => v.age < this.length)
  }
}
