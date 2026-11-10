// Mixes cached stems (16-bit PCM WAVs) into one WAV, each scaled by its playback gain, the way
// playback sums them: no normalising, no limiting.

/** Sample rate, channel count and the 16-bit samples of a PCM WAV. */
function readPcm16(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file')
  let fmt = null
  for (let off = 12; off + 8 <= buf.length; ) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) }
    } else if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.bits !== 16 || fmt.channels < 1) throw new Error('Stem is not a 16-bit PCM WAV')
      const frame = 2 * fmt.channels
      const bytes = Math.floor(Math.min(size, buf.length - body) / frame) * frame
      // Int16Array is little-endian on every platform Electron runs on, like WAV; it needs an even offset.
      const samples =
        (buf.byteOffset + body) % 2 === 0
          ? new Int16Array(buf.buffer, buf.byteOffset + body, bytes / 2)
          : new Int16Array(buf.buffer.slice(buf.byteOffset + body, buf.byteOffset + body + bytes))
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, samples }
    }
    off = body + size + (size % 2) // chunks are padded to an even length
  }
  throw new Error('WAV has no audio data')
}

/**
 * Sum of the stems, each times its gain, in 16-bit sample units: 16-bit PCM when it fits (a single
 * stem at gain 1 comes out bit-identical), else 32-bit float so peaks above full scale aren't clipped.
 * @param {Buffer[]} wavs  @param {number[]} gains  one per wav
 */
function mixStems(wavs, gains) {
  const stems = wavs.map(readPcm16).map((s, i) => ({ ...s, g: gains[i] })).filter((s) => s.g !== 0)
  if (stems.length === 0) throw new Error('Nothing to export: every stem is muted or at 0%.')
  const { sampleRate, channels } = stems[0]
  if (stems.some((s) => s.sampleRate !== sampleRate || s.channels !== channels)) throw new Error('The stems have different formats')
  const n = Math.max(...stems.map((s) => s.samples.length))
  const at = (i) => {
    let v = 0
    for (const s of stems) if (i < s.samples.length) v += s.g * s.samples[i]
    return v
  }
  let fits = true
  for (let i = 0; i < n && fits; i++) {
    const v = Math.round(at(i))
    fits = v >= -32768 && v <= 32767
  }
  const bytes = fits ? 2 : 4
  // PCM: 44-byte header. Float: fmt carries cbSize and a fact chunk follows, as the WAV spec requires for non-PCM.
  const header = fits ? 44 : 58
  const out = Buffer.alloc(header + n * bytes)
  out.write('RIFF', 0)
  out.writeUInt32LE(out.length - 8, 4)
  out.write('WAVEfmt ', 8)
  out.writeUInt32LE(fits ? 16 : 18, 16)
  out.writeUInt16LE(fits ? 1 : 3, 20)
  out.writeUInt16LE(channels, 22)
  out.writeUInt32LE(sampleRate, 24)
  out.writeUInt32LE(sampleRate * channels * bytes, 28)
  out.writeUInt16LE(channels * bytes, 32)
  out.writeUInt16LE(bytes * 8, 34)
  if (!fits) {
    out.writeUInt16LE(0, 36)
    out.write('fact', 38)
    out.writeUInt32LE(4, 42)
    out.writeUInt32LE(n / channels, 46)
  }
  out.write('data', header - 8)
  out.writeUInt32LE(n * bytes, header - 4)
  // 16-bit sample s is s / 32768 in float, the usual convention (and how the stems are decoded for playback).
  if (fits) for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(at(i)), header + i * 2)
  else for (let i = 0; i < n; i++) out.writeFloatLE(at(i) / 32768, header + i * 4)
  return { wav: out, float: !fits }
}

module.exports = { readPcm16, mixStems }
