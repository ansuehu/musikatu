export type ClickWave = 'sine' | 'triangle' | 'square'

export interface ClickSound {
  /** 0..2 (1 = default level). */
  volume: number
  /** Pitch of the click in Hz. */
  freq: number
  /** Decay length in milliseconds. */
  length: number
}

export interface MetronomeSettings {
  /** Overall level, 0..2. */
  master: number
  wave: ClickWave
  /** Beat 1 of each bar. */
  accent: ClickSound
  /** Every other beat. */
  beat: ClickSound
}

export const DEFAULT_METRONOME: MetronomeSettings = {
  master: 1,
  wave: 'sine',
  accent: { volume: 1, freq: 1760, length: 45 },
  beat: { volume: 0.7, freq: 1175, length: 45 },
}

/** Peak level of a click at volume 1 × master 1 (the first version used 0.3 / 0.18 and was too quiet). */
const BASE_LEVEL = 0.6

interface Voice {
  age: number
  delay: number
  freq: number
  gain: number
  length: number
}

/**
 * Click track locked to source positions. Each render quantum covers source span [from, to);
 * any beat inside it starts a click at the proportional output offset, so the click stays on
 * the beat at any playback speed and across loop wraps.
 */
export class Metronome {
  enabled = false
  settings: MetronomeSettings = DEFAULT_METRONOME
  private positions: Float64Array = new Float64Array(0)
  private accents: Uint8Array = new Uint8Array(0)
  private voices: Voice[] = []
  private readonly sampleRate: number

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate
  }

  setClicks(positions: Float64Array, accents: Uint8Array): void {
    this.positions = positions
    this.accents = accents
  }

  /** Starts one click right away (audition), whether or not the transport is playing. */
  preview(accent: boolean): void {
    this.voices.push(this.voice(accent, 0))
  }

  get busy(): boolean {
    return this.voices.length > 0
  }

  private voice(accent: boolean, delay: number): Voice {
    const s = accent ? this.settings.accent : this.settings.beat
    return {
      age: 0,
      delay,
      freq: s.freq,
      gain: BASE_LEVEL * s.volume * this.settings.master,
      length: Math.max(8, Math.round((s.length / 1000) * this.sampleRate)),
    }
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
      this.voices.push(this.voice(this.accents[i] === 1, delay))
    }
  }

  /** Renders clicks into `out`. Pass `from`/`to` = null when not playing (only auditions sound then). */
  render(out: Float32Array[], frames: number, from: number | null, to: number | null, loop: { start: number; end: number } | null): void {
    if (this.enabled && this.positions.length && from !== null && to !== null) {
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
    const wave = this.settings.wave
    const twoPiOverSr = (2 * Math.PI) / this.sampleRate
    for (const v of this.voices) {
      const decay = v.length / 5
      const attack = Math.max(1, Math.round(this.sampleRate * 0.0008)) // 0.8 ms, avoids a click-on-the-click
      for (let i = v.delay; i < frames && v.age < v.length; i++, v.age++) {
        const ph = Math.sin(v.age * v.freq * twoPiOverSr)
        // triangle via asin(sin); "square" softened with tanh so it's bright but not harsh
        const osc = wave === 'sine' ? ph : wave === 'triangle' ? (2 / Math.PI) * Math.asin(ph) : Math.tanh(4 * ph) * 0.8
        const env = Math.min(1, v.age / attack) * Math.exp(-v.age / decay)
        const s = v.gain * env * osc
        for (const ch of out) ch[i] += s
      }
      v.delay = 0
    }
    this.voices = this.voices.filter((v) => v.age < v.length)
  }
}
