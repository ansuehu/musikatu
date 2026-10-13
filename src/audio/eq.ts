/** Ten-band graphic EQ (octave bands) plus optional high-/low-pass filters for isolating a register. */
export const EQ_FREQS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const EQ_MAX_DB = 18
export const PASS_MIN_HZ = 20
export const PASS_MAX_HZ = 20000

export interface EqState {
  enabled: boolean
  gains: number[]
  highpass: { on: boolean; freq: number }
  lowpass: { on: boolean; freq: number }
}

export const FLAT_EQ: EqState = {
  enabled: true,
  gains: EQ_FREQS.map(() => 0),
  highpass: { on: false, freq: 80 },
  lowpass: { on: false, freq: 8000 },
}

export const EQ_PRESETS: { name: string; eq: EqState }[] = [
  { name: 'Flat', eq: FLAT_EQ },
  {
    name: 'Bass line',
    eq: { enabled: true, gains: [3, 6, 6, 3, 0, -6, -12, -12, -12, -12], highpass: { on: true, freq: 30 }, lowpass: { on: true, freq: 500 } },
  },
  {
    name: 'Kill bass',
    eq: { enabled: true, gains: [-12, -12, -6, 0, 0, 0, 0, 0, 0, 0], highpass: { on: true, freq: 180 }, lowpass: { on: false, freq: 8000 } },
  },
  {
    name: 'Melody / vocal',
    eq: { enabled: true, gains: [-12, -9, -3, 0, 3, 4, 3, 0, -3, -6], highpass: { on: true, freq: 160 }, lowpass: { on: true, freq: 5000 } },
  },
  {
    name: 'Guitar / piano mids',
    eq: { enabled: true, gains: [-12, -6, 0, 3, 3, 2, 0, -2, -6, -9], highpass: { on: true, freq: 90 }, lowpass: { on: true, freq: 4000 } },
  },
  {
    name: 'Cymbals / detail',
    eq: { enabled: true, gains: [-12, -12, -12, -9, -6, 0, 3, 4, 4, 3], highpass: { on: true, freq: 1500 }, lowpass: { on: false, freq: 8000 } },
  },
]

export function formatHz(f: number): string {
  return f >= 1000 ? `${+(f / 1000).toFixed(f >= 10000 ? 0 : 1)}k` : `${Math.round(f)}`
}
