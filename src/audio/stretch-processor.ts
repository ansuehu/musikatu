import { StretchEngine } from '../dsp/StretchEngine.ts'
import { ChannelMixer } from '../dsp/ChannelMixer.ts'
import type { ToProcessor } from './messages.ts'
import { Metronome } from '../dsp/Metronome.ts'
import { NoteSynth } from '../dsp/NoteSynth.ts'

const FADE_OUT = 256
const REPORT_EVERY = 2 // render quanta (~6 ms at 44.1 kHz)

class StretchProcessor extends AudioWorkletProcessor {
  private engine = new StretchEngine()
  private mixer = new ChannelMixer(sampleRate)
  private metronome = new Metronome(sampleRate)
  private synth = new NoteSynth(sampleRate)
  private pitch = 1
  private muteSource = false
  private state: 'stopped' | 'playing' | 'stopping' = 'stopped'
  /** Playhead while stopped, in source samples. */
  private pos = 0
  private fade = 0
  private seq = 0
  private tick = 0

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<ToProcessor>) => this.handle(e.data)
  }

  private handle(msg: ToProcessor): void {
    switch (msg.type) {
      case 'load':
        this.engine.setSource(msg.channels)
        this.state = 'stopped'
        this.pos = 0
        this.seq = msg.seq
        this.report()
        break
      case 'play':
        this.seq = msg.seq
        if (this.state !== 'playing') {
          this.engine.reset(this.state === 'stopped' ? this.pos : this.engine.position)
          this.state = 'playing'
        }
        break
      case 'pause':
        if (this.state === 'playing') {
          this.state = 'stopping'
          this.fade = FADE_OUT
        }
        break
      case 'seek':
        this.seq = msg.seq
        if (this.state === 'playing') {
          this.engine.reset(msg.pos)
        } else {
          this.pos = msg.pos
          this.state = 'stopped'
        }
        this.report()
        break
      case 'params':
        this.engine.setParams(msg.speed, msg.pitch)
        this.pitch = msg.pitch
        break
      case 'loop':
        this.engine.setLoop(msg.enabled, msg.start, msg.end)
        break
      case 'channelMode':
        this.mixer.mode = msg.mode
        break
      case 'addLayers':
        this.engine.addLayers(msg.layers)
        break
      case 'gains':
        this.engine.setGains(msg.gains)
        break
      case 'clicks':
        this.metronome.setClicks(msg.positions, msg.accents)
        break
      case 'metronome':
        this.metronome.enabled = msg.enabled
        this.metronome.settings = msg.settings
        break
      case 'metronomePreview':
        this.metronome.preview(msg.accent)
        break
      case 'notes':
        this.synth.setNotes(msg.starts, msg.ends, msg.midis, msg.velocities)
        break
      case 'noteSynth':
        this.synth.enabled = msg.enabled
        this.synth.volume = msg.volume
        this.muteSource = msg.muteSource
        break
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    if (this.state === 'stopped' || this.engine.channelCount === 0) {
      // auditioning a click works while stopped (outputs arrive zeroed)
      if (this.metronome.busy) this.metronome.render(out, out[0].length, null, null, null)
      if (this.synth.busy) this.synth.render(out, out[0].length, null, null, null, this.pitch)
      return true
    }

    const frames = out[0].length
    const from = this.engine.position
    this.engine.render(out, frames)
    this.mixer.process(out, frames)
    if (this.muteSource) for (const ch of out) ch.fill(0, 0, frames)
    this.synth.render(out, frames, this.state === 'playing' ? from : null, this.state === 'playing' ? this.engine.position : null, this.engine.loopRegion, this.pitch)
    // Clicks go in after the channel mixer so vocal-cut and friends never cancel them.
    if (this.state === 'playing') this.metronome.render(out, frames, from, this.engine.position, this.engine.loopRegion)

    if (this.state === 'stopping') {
      for (const ch of out) {
        for (let i = 0; i < frames; i++) ch[i] *= Math.max(0, this.fade - i) / FADE_OUT
      }
      this.fade -= frames
      if (this.fade <= 0) {
        this.state = 'stopped'
        this.pos = this.engine.position
        this.report()
        return true
      }
    }

    if (this.engine.ended) {
      this.state = 'stopped'
      this.pos = this.engine.length
      this.report()
      this.port.postMessage({ type: 'ended', seq: this.seq })
      return true
    }

    if (++this.tick % REPORT_EVERY === 0) this.report()
    return true
  }

  private report(): void {
    const pos = this.state === 'stopped' ? this.pos : this.engine.position
    this.port.postMessage({ type: 'pos', pos, playing: this.state === 'playing', seq: this.seq })
  }
}

registerProcessor('stretch-processor', StretchProcessor)
