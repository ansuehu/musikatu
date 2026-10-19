/**
 * Finding a song's stems and project after its audio file was moved or renamed. Both are kept under the
 * song's path, so a moved file looks like a new song. Cached songs whose file is gone and that last as
 * long are candidates; one is taken only when its stems, added together, sound like the song (the
 * stems of a song sum back to its mix), so a different song of the same length is never picked up.
 * Projects without stems carry the song's name and duration, and are taken when both match.
 */

/** Loudness envelope window, seconds. */
const WINDOW_S = 0.5
/** Envelopes this alike (correlation) are the same recording. */
const SAME = 0.95

/** Log loudness every WINDOW_S seconds of the sum of `channels`. */
export function loudness(channels: Float32Array[], sampleRate: number): Float32Array {
  const hop = Math.max(1, Math.round(WINDOW_S * sampleRate))
  const n = Math.floor((channels[0]?.length ?? 0) / hop)
  const out = new Float32Array(n)
  for (let w = 0; w < n; w++) {
    let e = 0
    for (let i = w * hop; i < (w + 1) * hop; i++) {
      let v = 0
      for (const c of channels) v += c[i]
      e += v * v
    }
    out[w] = Math.log10(1e-10 + e / hop)
  }
  return out
}

/** Correlation of two envelopes over their common length (−1 … 1; 0 when either is flat). */
export function likeness(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  if (n < 4) return 0
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i]
    mb += b[i]
  }
  ma /= n
  mb /= n
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb)
    saa += (a[i] - ma) ** 2
    sbb += (b[i] - mb) ** 2
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0
}

/** Whether stems (decoded, any sample rate) add up to the recording `song`. */
export function sameSong(song: { channels: Float32Array[]; sampleRate: number }, stems: { channels: Float32Array[]; sampleRate: number }): boolean {
  return likeness(loudness(song.channels, song.sampleRate), loudness(stems.channels, stems.sampleRate)) >= SAME
}

export interface MovedSong {
  /** The song's old key. */
  from: string
  /** Its cached stems were found (and checked by sound). */
  stems: boolean
}

interface Deps {
  stems: { findMoved(length: number): Promise<string[]>; load(key: string): Promise<{ stems: { name: string; data: Uint8Array }[] } | null> }
  findMovedProjects(duration: number): Promise<{ key: string; name: string }[]>
  decode(data: ArrayBuffer): Promise<AudioBuffer>
}

/**
 * The old key of a moved song, or null. `modelRate` is the rate stems are made at (their length is
 * kept in it); `hint` is an old key to try first (the user pointed at the file from the stem cache).
 */
export async function findMovedSong(deps: Deps, buffer: AudioBuffer, name: string, modelRate: number, hint?: string): Promise<MovedSong | null> {
  const song = { channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)), sampleRate: buffer.sampleRate }
  const keys = await deps.stems.findMoved(Math.ceil(buffer.duration * modelRate))
  keys.sort((a, b) => Number(b === hint) - Number(a === hint))
  for (const key of keys) {
    const cached = await deps.stems.load(key)
    if (!cached?.stems.length) continue
    const decoded = await Promise.all(cached.stems.map((s) => deps.decode(s.data.buffer.slice(s.data.byteOffset, s.data.byteOffset + s.data.byteLength) as ArrayBuffer)))
    const channels = decoded.flatMap((d) => Array.from({ length: d.numberOfChannels }, (_, c) => d.getChannelData(c)))
    if (sameSong(song, { channels, sampleRate: decoded[0].sampleRate })) return { from: key, stems: true }
  }
  // no stems: a project of a song with the same name and duration (or the one the user pointed at),
  // unless its stems were just found to be another song's
  const projects = (await deps.findMovedProjects(buffer.duration)).filter((x) => !keys.includes(x.key))
  const p = projects.find((x) => x.key === hint) ?? projects.find((x) => x.name === name)
  return p ? { from: p.key, stems: false } : null
}
