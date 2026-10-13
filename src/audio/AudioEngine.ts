import processorUrl from './stretch-processor.ts?worker&url'
import type { FromProcessor, ToProcessor } from './messages.ts'
import type { ChannelMode } from '../dsp/ChannelMixer.ts'
import { EQ_FREQS, PASS_MAX_HZ, PASS_MIN_HZ, type EqState } from './eq.ts'

export type Timbre = 'piano' | 'sine' | 'guitar'

export type EngineEvent = { type: 'playing'; playing: boolean }

/**
 * Main-thread facade over the stretch worklet. All positions are in samples
 * of the decoded buffer (which Web Audio decodes at the context's sample rate).
 */
export class AudioEngine {
  readonly ctx: AudioContext
  private readonly node: AudioWorkletNode
  private readonly gain: GainNode
  private readonly bands: BiquadFilterNode[]
  private readonly highpass: BiquadFilterNode
  private readonly lowpass: BiquadFilterNode
  private readonly refGain: GainNode
  private pianoWave: PeriodicWave | null = null
  private guitarWave: PeriodicWave | null = null
  private listeners = new Set<(e: EngineEvent) => void>()

  private length = 0
  private playing = false
  private speed = 1
  private pitch = 1
  private loop = { enabled: false, start: 0, end: 0 }
  private seq = 0
  private reportedPos = 0
  private reportedAt = 0

  static async create(): Promise<AudioEngine> {
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    await ctx.audioWorklet.addModule(processorUrl)
    return new AudioEngine(ctx)
  }

  private constructor(ctx: AudioContext) {
    this.ctx = ctx
    this.node = new AudioWorkletNode(ctx, 'stretch-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    })
    // worklet → 10 EQ bands → high-pass → low-pass → master gain → out; reference tones join at the master gain.
    this.bands = EQ_FREQS.map((f) => new BiquadFilterNode(ctx, { type: 'peaking', frequency: f, Q: 1.41, gain: 0 }))
    this.highpass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: PASS_MIN_HZ / 2, Q: Math.SQRT1_2 })
    this.lowpass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: Math.min(PASS_MAX_HZ * 1.2, ctx.sampleRate / 2), Q: Math.SQRT1_2 })
    this.gain = ctx.createGain()
    this.refGain = new GainNode(ctx, { gain: 0.6 })
    let tail: AudioNode = this.node
    for (const n of [...this.bands, this.highpass, this.lowpass, this.gain]) tail = tail.connect(n)
    this.gain.connect(ctx.destination)
    this.refGain.connect(this.gain)
    this.node.port.onmessage = (e: MessageEvent<FromProcessor>) => this.onMessage(e.data)
  }

  get sampleRate(): number {
    return this.ctx.sampleRate
  }

  get isPlaying(): boolean {
    return this.playing
  }

  dispose(): void {
    this.node.disconnect()
    void this.ctx.close()
  }

  subscribe(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  decode(data: ArrayBuffer): Promise<AudioBuffer> {
    return this.ctx.decodeAudioData(data)
  }

  load(buffer: AudioBuffer): void {
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice())
    this.length = buffer.length
    this.loop = { enabled: false, start: 0, end: buffer.length }
    this.reportedPos = 0
    this.setPlaying(false)
    this.post({ type: 'load', channels, seq: ++this.seq }, channels.map((c) => c.buffer as ArrayBuffer))
  }

  play(): void {
    if (!this.length || this.playing) return
    void this.ctx.resume()
    this.reportedAt = performance.now()
    this.post({ type: 'play', seq: ++this.seq })
    this.setPlaying(true)
  }

  pause(): void {
    if (!this.playing) return
    this.reportedPos = this.position
    this.post({ type: 'pause' })
    this.setPlaying(false)
  }

  seek(pos: number): void {
    if (!this.length) return
    const p = Math.min(Math.max(0, Math.round(pos)), this.length)
    this.reportedPos = p
    this.reportedAt = performance.now()
    this.post({ type: 'seek', pos: p, seq: ++this.seq })
  }

  setSpeed(speed: number): void {
    // Re-anchor interpolation so the playhead doesn't jump when the rate changes.
    this.reportedPos = this.position
    this.reportedAt = performance.now()
    this.speed = speed
    this.sendParams()
  }

  setPitch(semitones: number, cents: number): void {
    this.pitch = 2 ** ((semitones + cents / 100) / 12)
    this.sendParams()
  }

  setLoop(enabled: boolean, start: number, end: number): void {
    this.loop = { enabled, start, end }
    this.post({ type: 'loop', enabled, start, end })
  }

  /** Adds sources (e.g. stems) of the loaded buffer's length, mixed before time-stretching. Starts silent. */
  addLayers(buffers: AudioBuffer[]): void {
    const layers = buffers.map((b) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c).slice()))
    this.post({ type: 'addLayers', layers }, layers.flat().map((c) => c.buffer as ArrayBuffer))
  }

  /** Gain per source: [main buffer, ...layers]. */
  setGains(gains: number[]): void {
    this.post({ type: 'gains', gains })
  }

  setChannelMode(mode: ChannelMode): void {
    this.post({ type: 'channelMode', mode })
  }

  setEq(eq: EqState): void {
    const t = this.ctx.currentTime
    this.bands.forEach((b, i) => b.gain.setTargetAtTime(eq.enabled ? eq.gains[i] : 0, t, 0.02))
    const hp = eq.enabled && eq.highpass.on ? eq.highpass.freq : PASS_MIN_HZ / 2
    const lp = eq.enabled && eq.lowpass.on ? eq.lowpass.freq : Math.min(PASS_MAX_HZ * 1.2, this.sampleRate / 2)
    this.highpass.frequency.setTargetAtTime(hp, t, 0.02)
    this.lowpass.frequency.setTargetAtTime(lp, t, 0.02)
  }

  /**
   * Combined magnitude response of the EQ chain at `freqs` (Hz), for drawing the
   * curve and weighting the spectrum. Pass the state explicitly: the nodes'
   * parameters glide towards their targets and would lag.
   */
  eqResponse(eq: EqState, freqs: Float32Array<ArrayBuffer>): Float32Array<ArrayBuffer> {
    const total = new Float32Array(freqs.length).fill(1)
    const mag = new Float32Array(freqs.length)
    const phase = new Float32Array(freqs.length)
    const probe = (type: BiquadFilterType, frequency: number, Q: number, gain = 0) => {
      new BiquadFilterNode(this.ctx, { type, frequency, Q, gain }).getFrequencyResponse(freqs, mag, phase)
      for (let i = 0; i < total.length; i++) total[i] *= mag[i]
    }
    if (!eq.enabled) return total
    EQ_FREQS.forEach((f, i) => eq.gains[i] !== 0 && probe('peaking', f, 1.41, eq.gains[i]))
    if (eq.highpass.on) probe('highpass', eq.highpass.freq, Math.SQRT1_2)
    if (eq.lowpass.on) probe('lowpass', eq.lowpass.freq, Math.SQRT1_2)
    return total
  }

  /** Starts a reference tone (optionally `delay` seconds from now); call the returned function to release it. */
  playTone(freq: number, timbre: Timbre, delay = 0): () => void {
    const ctx = this.ctx
    void ctx.resume()
    const t = ctx.currentTime + delay
    const osc = new OscillatorNode(ctx, { frequency: freq })
    const env = new GainNode(ctx, { gain: 0 })
    let last: AudioNode = osc
    if (timbre === 'piano') {
      if (!this.pianoWave) {
        // Hammered-string-ish spectrum: strong low partials rolling off.
        const n = 16
        const real = new Float32Array(n)
        const imag = new Float32Array(n)
        for (let h = 1; h < n; h++) imag[h] = (h === 1 ? 1 : 0.6) / h ** 1.4
        this.pianoWave = ctx.createPeriodicWave(real, imag)
      }
      osc.setPeriodicWave(this.pianoWave)
      // Brightness decays like a struck string.
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.5, frequency: Math.min(freq * 10, 16000) })
      tone.frequency.setTargetAtTime(Math.min(freq * 3, 8000), t + 0.01, 0.35)
      last = osc.connect(tone)
      env.gain.setValueAtTime(0, t)
      env.gain.linearRampToValueAtTime(0.55, t + 0.004)
      env.gain.setTargetAtTime(0.18, t + 0.004, 0.45)
    } else if (timbre === 'guitar') {
      if (!this.guitarWave) {
        // String plucked a fifth of the way along: partials at multiples of 5 vanish.
        const n = 24
        const real = new Float32Array(n)
        const imag = new Float32Array(n)
        for (let h = 1; h < n; h++) imag[h] = Math.abs(Math.sin(h * Math.PI * 0.2)) / h
        this.guitarWave = ctx.createPeriodicWave(real, imag)
      }
      osc.setPeriodicWave(this.guitarWave)
      const tone = new BiquadFilterNode(ctx, { type: 'lowpass', Q: 0.7, frequency: Math.min(freq * 12, 14000) })
      tone.frequency.setValueAtTime(Math.min(freq * 12, 14000), t)
      tone.frequency.setTargetAtTime(Math.min(freq * 2.5, 6000), t + 0.005, 0.25)
      last = osc.connect(tone)
      env.gain.setValueAtTime(0, t)
      env.gain.linearRampToValueAtTime(0.3, t + 0.003)
      env.gain.setTargetAtTime(0, t + 0.003, 0.9)
    } else {
      env.gain.setValueAtTime(0, t)
      env.gain.linearRampToValueAtTime(0.35, t + 0.01)
    }
    last.connect(env).connect(this.refGain)
    osc.start(t)
    return () => {
      const now = Math.max(ctx.currentTime, t + 0.01)
      env.gain.cancelScheduledValues(now)
      env.gain.setValueAtTime(env.gain.value, now)
      env.gain.setTargetAtTime(0, now, timbre === 'sine' ? 0.03 : timbre === 'guitar' ? 0.25 : 0.08)
      osc.stop(now + 0.6)
    }
  }

  setVolume(v: number): void {
    this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.015)
  }

  /** Playhead (samples) of the audio currently reaching the speakers, interpolated between worklet reports. */
  get position(): number {
    if (!this.playing) return this.reportedPos
    const latency = (this.ctx.outputLatency || 0) + this.ctx.baseLatency
    let p = this.reportedPos + ((performance.now() - this.reportedAt) / 1000 - latency) * this.speed * this.sampleRate
    const { enabled, start, end } = this.loop
    if (enabled && end > start) {
      if (p >= end) p = start + ((p - end) % (end - start))
      else if (p < start && this.reportedPos >= start) p = end - (start - p)
    }
    return Math.min(Math.max(0, p), this.length)
  }

  private sendParams(): void {
    this.post({ type: 'params', speed: this.speed, pitch: this.pitch })
  }

  private post(msg: ToProcessor, transfer: Transferable[] = []): void {
    this.node.port.postMessage(msg, transfer)
  }

  private onMessage(msg: FromProcessor): void {
    if (msg.seq !== this.seq) return // stale report from before a seek/play/load
    if (msg.type === 'pos') {
      this.reportedPos = msg.pos
      this.reportedAt = performance.now()
    } else if (msg.type === 'ended') {
      this.reportedPos = this.length
      this.setPlaying(false)
    }
  }

  private setPlaying(playing: boolean): void {
    if (this.playing === playing) return
    this.playing = playing
    for (const fn of this.listeners) fn({ type: 'playing', playing })
  }
}
