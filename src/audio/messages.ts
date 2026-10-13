import type { ChannelMode } from '../dsp/ChannelMixer.ts'

/** Messages between AudioEngine (main thread) and the stretch AudioWorklet. Positions are source samples. */
export type ToProcessor =
  | { type: 'load'; channels: Float32Array[]; seq: number }
  | { type: 'play'; seq: number }
  | { type: 'pause' }
  | { type: 'seek'; pos: number; seq: number }
  | { type: 'params'; speed: number; pitch: number }
  | { type: 'loop'; enabled: boolean; start: number; end: number }
  | { type: 'channelMode'; mode: ChannelMode }

export type FromProcessor =
  | { type: 'pos'; pos: number; playing: boolean; seq: number }
  | { type: 'ended'; seq: number }
