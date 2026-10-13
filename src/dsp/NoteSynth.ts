/**
 * Plays transcribed notes in sync with the stretched audio, from the audio worklet. Like the
 * metronome it works in source positions: a note starts when playback crosses its start and
 * releases when playback passes its end, so it follows any speed, loop wrap and pitch shift.
 */

interface Voice {
  freq: number
  gain: number
  age: number
  delay: number
  /** Source position where the note ends. */
  end: number
  /** Output samples since release, or -1 while held. */
  rel: number
}

const MAX_VOICES = 48
const RELEASE_S = 0.08

export class NoteSynth {
  enabled = false
  volume = 0.7
  private starts: Float64Array = new Float64Array(0)
  private ends: Float64Array = new Float64Array(0)
  private midis: Uint8Array = new Uint8Array(0)
  private vels: Float32Array = new Float32Array(0)
  private voices: Voice[] = []
  private readonly sr: number

  constructor(sampleRate: number) {
    this.sr = sampleRate
  }

  /** Notes sorted by start (all playable tracks merged). */
  setNotes(starts: Float64Array, ends: Float64Array, midis: Uint8Array, velocities: Float32Array): void {
    this.starts = starts
    this.ends = ends
    this.midis = midis
    this.vels = velocities
    this.releaseAll()
  }

  releaseAll(): void {
    for (const v of this.voices) if (v.rel < 0) v.rel = 0
  }

  get busy(): boolean {
    return this.voices.length > 0
  }

  private collect(a: number, b: number, span: number, offset: number, frames: number, pitch: number): void {
    const p = this.starts
    let lo = 0
    let hi = p.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (p[mid] < a) lo = mid + 1
      else hi = mid
    }
    for (let i = lo; i < p.length && p[i] < b; i++) {
      const delay = Math.min(frames - 1, Math.max(0, Math.round(offset + ((p[i] - a) / span) * frames)))
      const freq = 440 * 2 ** ((this.midis[i] - 69) / 12) * pitch
      // louder for higher velocities, a little softer for low notes that carry anyway
      const gain = 0.22 * (0.35 + 0.65 * (this.vels[i] / 127))
      this.voices.push({ freq, gain, age: 0, delay, end: this.ends[i], rel: -1 })
    }
    if (this.voices.length > MAX_VOICES) this.voices.splice(0, this.voices.length - MAX_VOICES)
  }

  /** `from`/`to` null when not playing: everything releases. `pitch` is the playback pitch ratio. */
  render(out: Float32Array[], frames: number, from: number | null, to: number | null, loop: { start: number; end: number } | null, pitch: number): void {
    if (from === null || to === null || !this.enabled) {
      this.releaseAll()
    } else if (to > from && to - from < frames * 8) {
      this.collect(from, to, to - from, 0, frames, pitch)
      for (const v of this.voices) if (v.rel < 0 && v.end <= to) v.rel = 0
    } else if (to <= from && loop && from < loop.end) {
      // loop wrap: what was sounding stops at the loop end; notes at the loop start begin
      this.releaseAll()
      const span = loop.end - from + (to - loop.start)
      if (span > 0 && span < frames * 8) this.collect(loop.start, to, span, ((loop.end - from) / span) * frames, frames, pitch)
    } else {
      this.releaseAll() // a seek
    }
    if (this.voices.length === 0) return

    const twoPi = 2 * Math.PI
    const relLen = Math.round(RELEASE_S * this.sr)
    const attack = Math.round(0.004 * this.sr)
    const vol = this.volume
    for (const v of this.voices) {
      const w = (twoPi * v.freq) / this.sr
      for (let i = v.delay; i < frames; i++) {
        const t = v.age
        // electric-piano-ish: fundamental plus decaying 2nd/3rd harmonics
        const env = Math.min(1, t / attack) * (0.55 + 0.45 * Math.exp(-t / (0.25 * this.sr)))
        const bright = Math.exp(-t / (0.12 * this.sr))
        let s = Math.sin(w * t) + 0.35 * bright * Math.sin(2 * w * t) + 0.12 * bright * Math.sin(3 * w * t)
        let r = 1
        if (v.rel >= 0) {
          r = 1 - v.rel / relLen
          v.rel++
          if (r <= 0) break
        }
        s *= vol * v.gain * env * r
        for (const ch of out) ch[i] += s
        v.age++
      }
      v.delay = 0
    }
    this.voices = this.voices.filter((v) => v.rel < 0 || v.rel < relLen)
  }
}
