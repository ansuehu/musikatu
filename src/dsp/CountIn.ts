export interface CountInConfig {
  enabled: boolean
  /** Total clicks (e.g. one bar of 4, or two bars = 8). */
  beats: number
  /** Accent every N clicks (the meter). */
  accentEvery: number
  /** Beat length in source samples; divided by the playback speed to get real time. */
  sourceInterval: number
  /** Also count in before every repeat of a loop. */
  eachLoop: boolean
}

export const DEFAULT_COUNT_IN: CountInConfig = { enabled: false, beats: 4, accentEvery: 4, sourceInterval: 0, eachLoop: false }

/** A count-in in progress: clicks at the tempo of the (slowed) song, then hands over to playback. */
export class CountIn {
  config: CountInConfig = DEFAULT_COUNT_IN
  active = false
  /** Source position playback resumes from when the count-in ends. */
  resumePos = 0
  private interval = 0
  private elapsed = 0
  private nextBeat = 0

  start(resumePos: number, speed: number, sampleRate: number): void {
    // Without a beat grid fall back to 100 BPM at the current speed.
    const source = this.config.sourceInterval > 0 ? this.config.sourceInterval : 0.6 * sampleRate
    this.interval = source / Math.max(0.01, speed)
    this.resumePos = resumePos
    this.elapsed = 0
    this.nextBeat = 0
    this.active = true
  }

  /** 1-based number of the click most recently sounded (0 before the first). */
  get beat(): number {
    return this.nextBeat
  }

  get total(): number {
    return this.config.beats
  }

  /**
   * Advances one render quantum, calling `click(accent, offset)` for clicks that fall inside it.
   * Returns the offset (in this quantum) where playback should begin, or -1 if still counting.
   */
  step(frames: number, click: (accent: boolean, offset: number) => void): number {
    if (!this.active) return -1
    const end = this.elapsed + frames
    while (this.nextBeat < this.config.beats) {
      const t = this.nextBeat * this.interval
      if (t >= end) break
      click(this.nextBeat % Math.max(1, this.config.accentEvery) === 0, Math.max(0, Math.round(t - this.elapsed)))
      this.nextBeat++
    }
    const done = this.config.beats * this.interval
    this.elapsed = end
    if (end >= done) {
      this.active = false
      return Math.max(0, Math.min(frames - 1, Math.round(done - (end - frames))))
    }
    return -1
  }
}
