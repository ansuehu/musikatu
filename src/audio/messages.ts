import type { ChannelMode } from '../dsp/ChannelMixer.ts'
import type { MetronomeSettings } from '../dsp/Metronome.ts'
import type { CountInConfig } from '../dsp/CountIn.ts'

/** Messages between AudioEngine (main thread) and the stretch AudioWorklet. Positions are source samples. */
export type ToProcessor =
  | { type: 'load'; channels: Float32Array[]; seq: number }
  | { type: 'play'; seq: number }
  | { type: 'pause' }
  | { type: 'seek'; pos: number; seq: number }
  | { type: 'params'; speed: number; pitch: number }
  | { type: 'loop'; enabled: boolean; start: number; end: number }
  | { type: 'channelMode'; mode: ChannelMode }
  | { type: 'addLayers'; layers: Float32Array[][] }
  | { type: 'gains'; gains: number[] }
  | { type: 'clicks'; positions: Float64Array; accents: Uint8Array }
  | { type: 'metronome'; enabled: boolean; settings: MetronomeSettings }
  | { type: 'metronomePreview'; accent: boolean }
  | { type: 'notes'; starts: Float64Array; ends: Float64Array; midis: Uint8Array; velocities: Float32Array }
  | { type: 'noteSynth'; enabled: boolean; volume: number; muteSource: boolean }
  | { type: 'countIn'; config: CountInConfig }

export type FromProcessor =
  | { type: 'pos'; pos: number; playing: boolean; seq: number; counting?: { beat: number; of: number } }
  | { type: 'wrap'; seq: number }
  | { type: 'ended'; seq: number }
