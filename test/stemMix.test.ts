import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DEFAULT_STEM_MIX, STEM_NAMES, stemGains, type StemMix } from '../src/stems/types.ts'

const { mixStems, readPcm16 } = createRequire(import.meta.url)('../electron/stems/mix.cjs') as {
  mixStems(wavs: Buffer[], gains: number[]): { wav: Buffer; float: boolean }
  readPcm16(buf: Buffer): { sampleRate: number; channels: number; samples: Int16Array }
}

/** Stereo 16-bit WAV at 44.1 kHz, laid out like the separator writes it (optionally with a LIST chunk before data). */
function wav(samples: number[], extraChunk = false): Buffer {
  const extra = extraChunk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0')]) : Buffer.alloc(0)
  const head = Buffer.alloc(36)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + extra.length + samples.length * 2, 4) // file length - 8
  head.write('WAVEfmt ', 8)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(2, 22)
  head.writeUInt32LE(44100, 24)
  head.writeUInt32LE(44100 * 4, 28)
  head.writeUInt16LE(4, 32)
  head.writeUInt16LE(16, 34)
  const data = Buffer.alloc(8 + samples.length * 2)
  data.write('data', 0)
  data.writeUInt32LE(samples.length * 2, 4)
  samples.forEach((s, i) => data.writeInt16LE(s, 8 + i * 2))
  return Buffer.concat([head, extra, data])
}

test('a single stem at 100% comes out sample for sample the same, as 16-bit PCM', () => {
  const s = [0, 1, -1, 32767, -32768, 1234, -4321, 7]
  const { wav: out, float } = mixStems([wav(s)], [1])
  assert.equal(float, false)
  const r = readPcm16(out)
  assert.deepEqual([r.sampleRate, r.channels, out.length], [44100, 2, 44 + s.length * 2])
  assert.deepEqual([...r.samples], s)
})

test('stems are summed, each at its own volume', () => {
  const a = [1000, -2000, 3000, 0]
  const b = [400, 400, -401, 9]
  const { wav: out, float } = mixStems([wav(a), wav(b, true)], [0.5, 1.25])
  assert.equal(float, false)
  assert.deepEqual([...readPcm16(out).samples], a.map((v, i) => Math.round(0.5 * v + 1.25 * b[i])))
})

test('mute and solo: the mix holds exactly the stems you hear', () => {
  const data = STEM_NAMES.map((_, k) => [100 * (k + 1), -100 * (k + 1)])
  const mix: StemMix = { ...DEFAULT_STEM_MIX, stems: { ...DEFAULT_STEM_MIX.stems, drums: { volume: 1, mute: true, solo: false }, bass: { volume: 0.5, mute: false, solo: false } } }
  const g = stemGains(mix)
  const out = mixStems(data.map((d) => wav(d)), STEM_NAMES.map((n) => g[n]))
  const expected = [0, 1].map((i) => Math.round(STEM_NAMES.reduce((sum, n, k) => sum + g[n] * data[k][i], 0)))
  assert.deepEqual([...readPcm16(out.wav).samples], expected)
  assert.equal(g.drums, 0) // muted stem left out

  const solo = stemGains({ ...mix, stems: { ...mix.stems, piano: { volume: 0.8, mute: false, solo: true } } })
  const k = STEM_NAMES.indexOf('piano')
  assert.deepEqual([...readPcm16(mixStems(data.map((d) => wav(d)), STEM_NAMES.map((n) => solo[n])).wav).samples], data[k].map((v) => Math.round(0.8 * v)))
})

test('everything muted is refused instead of writing silence', () => {
  assert.throws(() => mixStems([wav([1, 2]), wav([3, 4])], [0, 0]), /every stem is muted/)
})

test('a mix above full scale is kept unclipped as 32-bit float WAV', () => {
  const a = [30000, -30000, 100, 0]
  const { wav: out, float } = mixStems([wav(a), wav(a)], [1.5, 1])
  assert.equal(float, true)
  assert.equal(out.toString('ascii', 0, 4), 'RIFF')
  assert.equal(out.readUInt32LE(4), out.length - 8)
  assert.deepEqual([out.readUInt32LE(16), out.readUInt16LE(20), out.readUInt16LE(22), out.readUInt32LE(24), out.readUInt16LE(34)], [18, 3, 2, 44100, 32])
  assert.deepEqual([out.toString('ascii', 38, 42), out.readUInt32LE(46)], ['fact', a.length / 2])
  assert.deepEqual([out.toString('ascii', 50, 54), out.readUInt32LE(54)], ['data', a.length * 4])
  const got = a.map((_, i) => out.readFloatLE(58 + i * 4))
  a.forEach((v, i) => assert.ok(Math.abs(got[i] - (2.5 * v) / 32768) < 1e-6))
  assert.ok(got[0] > 1) // not clipped
})

test('exactly full scale still fits 16-bit', () => {
  assert.equal(mixStems([wav([16384, -16384]), wav([16383, -16384])], [1, 1]).float, false)
  assert.equal(mixStems([wav([16384, 0]), wav([16384, 0])], [1, 1]).float, true)
})

test('reads what the separator writes', async () => {
  // separator-process.cjs's writer, copied: it can't be required outside Electron's utility process
  const src = (await import('node:fs')).readFileSync(new URL('../electron/stems/separator-process.cjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('function wav16'), src.indexOf('\n}\n', src.indexOf('function wav16')) + 2)
  const wav16 = new Function('Buffer', 'SAMPLE_RATE', `${body}; return wav16`)(Buffer, 44100) as (l: Float32Array, r: Float32Array) => Buffer
  const l = Float32Array.from([0, 0.5, -0.5, 1])
  const r = Float32Array.from([0.25, -1, 0, -0.25])
  const s = readPcm16(wav16(l, r))
  assert.deepEqual([s.sampleRate, s.channels], [44100, 2])
  assert.deepEqual([...s.samples], [0, 0.25, 0.5, -1, -0.5, 0, 1, -0.25].map((v) => Math.round(v * 32767))) // interleaved L, R
})
