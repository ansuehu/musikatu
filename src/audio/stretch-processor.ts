import { StretchEngine } from '../dsp/StretchEngine.ts'
import { ChannelMixer } from '../dsp/ChannelMixer.ts'
import type { ToProcessor } from './messages.ts'
import { Metronome } from '../dsp/Metronome.ts'
import { NoteSynth } from '../dsp/NoteSynth.ts'
import { CountIn } from '../dsp/CountIn.ts'

const FADE_OUT = 256
const REPORT_EVERY = 2 // render quanta (~6 ms at 44.1 kHz)

class StretchProcessor extends AudioWorkletProcessor {
  private engine = new StretchEngine()
  private mixer = new ChannelMixer(sampleRate)
  private metronome = new Metronome(sampleRate)
  private synth = new NoteSynth(sampleRate)
  private pitch = 1
  private speed = 1
  private countIn = new CountIn()
  private muteSource = false
  private state: 'stopped' | 'countin' | 'playing' | 'stopping' = 'stopped'
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
        if (this.state === 'stopped' || this.state === 'stopping') {
          const resume = this.state === 'stopped' ? this.pos : this.engine.position
          if (this.countIn.config.enabled) this.beginCountIn(resume)
          else {
            this.engine.reset(resume)
            this.state = 'playing'
          }
        }
        break
      case 'pause':
        if (this.state === 'playing') {
          this.state = 'stopping'
          this.fade = FADE_OUT
        } else if (this.state === 'countin') {
          this.countIn.active = false
          this.pos = this.countIn.resumePos
          this.state = 'stopped'
          this.report()
        }
        break
      case 'seek':
        this.seq = msg.seq
        if (this.state === 'playing') {
          this.engine.reset(msg.pos)
        } else if (this.state === 'countin') {
          this.countIn.resumePos = msg.pos
        } else {
          this.pos = msg.pos
          this.state = 'stopped'
        }
        this.report()
        break
      case 'params':
        this.engine.setParams(msg.speed, msg.pitch)
        this.pitch = msg.pitch
        this.speed = msg.speed
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
      case 'countIn':
        this.countIn.config = msg.config
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
    if (this.state === 'countin') {
      const before = this.countIn.beat
      const startAt = this.countIn.step(frames, (accent, offset) => this.metronome.scheduleClick(accent, offset))
      this.metronome.render(out, frames, null, null, null)
      if (startAt >= 0) {
        // the rest of this quantum stays silent; audio starts on the next one, a fraction of a millisecond later
        this.engine.reset(this.countIn.resumePos)
        this.state = 'playing'
        this.report()
      } else if (this.countIn.beat !== before) this.report()
      return true
    }

    const from = this.engine.position
    this.engine.render(out, frames)
    const loop = this.engine.loopRegion
    let wrapAt = -1
    // A real wrap jumps back by about the loop length; tiny backward steps (e.g. while the speed
    // changes) are not wraps — mistaking them for one would make the speed trainer run away.
    const back = from - this.engine.position
    if (loop && this.state === 'playing' && back > 0.5 * (loop.end - loop.start) && back < loop.end - loop.start + frames * 8) {
      const span = loop.end - from + (this.engine.position - loop.start)
      wrapAt = span > 0 ? Math.round(((loop.end - from) / span) * frames) : 0
      this.port.postMessage({ type: 'wrap', seq: this.seq })
    }
    this.mixer.process(out, frames)
    if (this.muteSource) for (const ch of out) ch.fill(0, 0, frames)
    this.synth.render(out, frames, this.state === 'playing' ? from : null, this.state === 'playing' ? this.engine.position : null, this.engine.loopRegion, this.pitch)
    // Clicks go in after the channel mixer so vocal-cut and friends never cancel them.
    if (this.state === 'playing') this.metronome.render(out, frames, from, this.engine.position, this.engine.loopRegion)

    if (wrapAt >= 0 && this.countIn.config.enabled && this.countIn.config.eachLoop) {
      // cut the audio at the loop end and count in again before the next pass
      for (const ch of out) ch.fill(0, wrapAt, frames)
      this.beginCountIn(loop!.start)
      return true
    }

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

  private beginCountIn(resume: number): void {
    this.countIn.start(resume, this.speed, sampleRate)
    this.state = 'countin'
    this.report()
  }

  private report(): void {
    const counting = this.state === 'countin' ? { beat: this.countIn.beat, of: this.countIn.total } : undefined
    const pos = this.state === 'stopped' ? this.pos : counting ? this.countIn.resumePos : this.engine.position
    this.port.postMessage({ type: 'pos', pos, playing: this.state === 'playing' || this.state === 'countin', seq: this.seq, counting })
  }
}

registerProcessor('stretch-processor', StretchProcessor)
