/** Multi-resolution min/max/energy pyramid for fast waveform drawing at any zoom. */
export interface PeakLevel {
  /** Samples per bucket. */
  spb: number
  min: Float32Array[]
  max: Float32Array[]
  /** Sum of squares per bucket (for RMS). */
  sq: Float32Array[]
}

export interface Peaks {
  id: number
  channels: Float32Array[]
  length: number
  sampleRate: number
  levels: PeakLevel[]
}

export interface Range {
  min: number
  max: number
  rms: number
}

const BASE = 32
let nextId = 1

export function buildPeaks(buffer: AudioBuffer): Peaks {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
  const length = buffer.length
  const count = Math.ceil(length / BASE)
  const base: PeakLevel = { spb: BASE, min: [], max: [], sq: [] }
  for (const data of channels) {
    const min = new Float32Array(count)
    const max = new Float32Array(count)
    const sq = new Float32Array(count)
    for (let b = 0; b < count; b++) {
      let lo = Infinity
      let hi = -Infinity
      let s = 0
      const end = Math.min(length, (b + 1) * BASE)
      for (let i = b * BASE; i < end; i++) {
        const v = data[i]
        if (v < lo) lo = v
        if (v > hi) hi = v
        s += v * v
      }
      min[b] = lo
      max[b] = hi
      sq[b] = s
    }
    base.min.push(min)
    base.max.push(max)
    base.sq.push(sq)
  }

  const levels = [base]
  let prev = base
  while (prev.min[0].length > 1) {
    const n = Math.ceil(prev.min[0].length / 2)
    const next: PeakLevel = { spb: prev.spb * 2, min: [], max: [], sq: [] }
    for (let c = 0; c < channels.length; c++) {
      const pMin = prev.min[c], pMax = prev.max[c], pSq = prev.sq[c]
      const min = new Float32Array(n), max = new Float32Array(n), sq = new Float32Array(n)
      for (let b = 0; b < n; b++) {
        const a = 2 * b
        const z = Math.min(a + 1, pMin.length - 1)
        min[b] = Math.min(pMin[a], pMin[z])
        max[b] = Math.max(pMax[a], pMax[z])
        sq[b] = pSq[a] + (z !== a ? pSq[z] : 0)
      }
      next.min.push(min)
      next.max.push(max)
      next.sq.push(sq)
    }
    levels.push(next)
    prev = next
  }

  return { id: nextId++, channels, length, sampleRate: buffer.sampleRate, levels }
}

/** Min / max / RMS of channel `ch` over samples [s0, s1), written into `out`. */
export function rangeOf(peaks: Peaks, ch: number, s0: number, s1: number, out: Range): Range {
  const a = Math.max(0, Math.floor(s0))
  const b = Math.min(peaks.length, Math.ceil(s1))
  if (b <= a) {
    out.min = out.max = out.rms = 0
    return out
  }
  const n = b - a
  let lo = Infinity
  let hi = -Infinity
  let s = 0
  if (n < BASE * 2) {
    const data = peaks.channels[ch]
    for (let i = a; i < b; i++) {
      const v = data[i]
      if (v < lo) lo = v
      if (v > hi) hi = v
      s += v * v
    }
    out.rms = Math.sqrt(s / n)
  } else {
    const li = Math.min(peaks.levels.length - 1, Math.floor(Math.log2(n / (2 * BASE))))
    const level = peaks.levels[li]
    const b0 = Math.floor(a / level.spb)
    const b1 = Math.min(level.min[ch].length, Math.ceil(b / level.spb))
    const min = level.min[ch], max = level.max[ch], sq = level.sq[ch]
    for (let k = b0; k < b1; k++) {
      if (min[k] < lo) lo = min[k]
      if (max[k] > hi) hi = max[k]
      s += sq[k]
    }
    out.rms = Math.sqrt(s / Math.max(1, (b1 - b0) * level.spb))
  }
  out.min = lo
  out.max = hi
  return out
}
