export const STEM_NAMES = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const
export type StemName = (typeof STEM_NAMES)[number]

export const STEM_LABELS: Record<StemName, string> = {
  vocals: 'Vocals',
  drums: 'Drums',
  bass: 'Bass',
  guitar: 'Guitar',
  piano: 'Piano / keys',
  other: 'Other',
}

export const STEM_COLORS: Record<StemName, string> = {
  vocals: '#ff7aa8',
  drums: '#ffb547',
  bass: '#7aa2ff',
  guitar: '#49d6b8',
  piano: '#b48cff',
  other: '#9aa6c0',
}

export interface StemChannel {
  volume: number
  mute: boolean
  solo: boolean
}

/** Per-file stem mixer state, saved with the project. */
export interface StemMix {
  /** Play the stems (true) or the original recording (false). */
  enabled: boolean
  stems: Record<StemName, StemChannel>
}

export const DEFAULT_STEM_MIX: StemMix = {
  enabled: true,
  stems: Object.fromEntries(STEM_NAMES.map((n) => [n, { volume: 1, mute: false, solo: false }])) as Record<StemName, StemChannel>,
}

/** Effective gain of each stem, honouring solo and mute. */
export function stemGains(mix: StemMix): Record<StemName, number> {
  const anySolo = STEM_NAMES.some((n) => mix.stems[n].solo)
  return Object.fromEntries(
    STEM_NAMES.map((n) => {
      const s = mix.stems[n]
      const audible = anySolo ? s.solo : !s.mute
      return [n, audible ? s.volume : 0]
    }),
  ) as Record<StemName, number>
}

/** The single stem being heard on its own, if exactly one is audible. */
export function soloStem(mix: StemMix): StemName | null {
  const g = stemGains(mix)
  const audible = STEM_NAMES.filter((n) => g[n] > 0)
  return audible.length === 1 ? audible[0] : null
}

export type Device = 'auto' | 'gpu' | 'cpu'

export interface Benchmark {
  cpu: number | null
  gpu: number | null
  gpuEp: string | null
  gpuError: string | null
  at: number
}

export interface StemsInfo {
  model: { installed: boolean; path: string; size: number; name: string; credit: string }
  sources: string[]
  sampleRate: number
  preference: Device
  benchmark: Benchmark | null
  platform: string
  cacheBytes: number
}

export interface StemsMeta {
  key: string
  sources: string[]
  sampleRate: number
  length: number
  backend: string
  seconds: number
  createdAt: string
}

export type StemsEvent =
  | { type: 'download'; received: number; total: number }
  | { type: 'phase'; phase: 'benchmark' | 'loading'; device?: string }
  | { type: 'progress'; done: number; total: number; ep: string; label: string; elapsed: number }
  | { type: 'notice'; text: string }

export interface StemsApi {
  info(): Promise<StemsInfo>
  setPreference(p: Device): Promise<void>
  benchmark(): Promise<Benchmark>
  downloadModel(): Promise<StemsInfo['model']>
  cancelDownload(): Promise<void>
  importModel(): Promise<StemsInfo['model'] | null>
  separate(key: string, left: Float32Array, right: Float32Array): Promise<StemsMeta>
  cancel(): Promise<void>
  load(key: string): Promise<{ meta: StemsMeta; stems: { name: string; data: Uint8Array }[] } | null>
  exportStems(key: string, baseName: string): Promise<string | null>
  clearCache(): Promise<number>
  onEvent(callback: (e: StemsEvent) => void): () => void
}
