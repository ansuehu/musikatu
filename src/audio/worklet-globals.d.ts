// AudioWorkletGlobalScope declarations (not part of lib.dom).
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}

declare const sampleRate: number

declare function registerProcessor(name: string, processorCtor: new () => AudioWorkletProcessor): void
