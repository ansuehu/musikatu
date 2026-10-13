import { test } from 'node:test'
import assert from 'node:assert/strict'
import { StretchEngine } from '../src/dsp/StretchEngine.ts'

const SR = 44100

function signal(seconds: number, fn: (t: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR))
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SR)
  return out
}

/** Renders in 128-sample quanta, like an AudioWorklet does. */
function render(engine: StretchEngine, frames: number): Float32Array[] {
  const out = [new Float32Array(frames), new Float32Array(frames)]
  const q = [new Float32Array(128), new Float32Array(128)]
  for (let i = 0; i < frames; i += 128) {
    engine.render(q, 128)
    const n = Math.min(128, frames - i)
    out[0].set(q[0].subarray(0, n), i)
    out[1].set(q[1].subarray(0, n), i)
  }
  return out
}

/** Mean frequency from interpolated positive-going zero crossings. */
function frequency(x: Float32Array): number {
  const crossings: number[] = []
  for (let i = 1; i < x.length; i++) {
    if (x[i - 1] < 0 && x[i] >= 0) crossings.push(i - 1 + x[i - 1] / (x[i - 1] - x[i]))
  }
  return ((crossings.length - 1) * SR) / (crossings[crossings.length - 1] - crossings[0])
}

function rms(x: Float32Array): number {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}

function richSignal(): Float32Array {
  let seed = 1
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1
  return signal(3, (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t) + 0.3 * Math.sin(2 * Math.PI * 1234.5 * t) + noise())
}

test('100% speed, 0 pitch reproduces the source sample-accurately from the seek point', () => {
  const src = richSignal()
  const e = new StretchEngine()
  e.setSource([src])
  e.reset(10000)
  const [out] = render(e, 30080)
  let maxErr = 0
  for (let i = 256; i < out.length; i++) maxErr = Math.max(maxErr, Math.abs(out[i] - src[10000 + i]))
  assert.ok(maxErr < 1e-4, `max error ${maxErr}`)
  assert.ok(Math.abs(e.position - 40080) <= 1, `position ${e.position}`)
})

test('half speed keeps pitch and advances the playhead at half rate', () => {
  const src = signal(4, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t))
  const e = new StretchEngine()
  e.setSource([src])
  e.setParams(0.5, 1)
  e.reset(SR)
  const [out] = render(e, SR)
  const f = frequency(out.subarray(4096))
  assert.ok(Math.abs(f - 440) < 1, `frequency ${f}`)
  assert.ok(Math.abs(e.position - 1.5 * SR) < 200, `position ${e.position / SR}s`)
  assert.ok(Math.abs(rms(out.subarray(4096)) - 0.5 / Math.SQRT2) < 0.03, `rms ${rms(out)}`)
})

test('+12 semitones doubles the frequency at unchanged tempo', () => {
  const src = signal(4, (t) => 0.5 * Math.sin(2 * Math.PI * 330 * t))
  const e = new StretchEngine()
  e.setSource([src])
  e.setParams(1, 2)
  e.reset(SR)
  const [out] = render(e, SR)
  const f = frequency(out.subarray(4096))
  assert.ok(Math.abs(f - 660) < 1.5, `frequency ${f}`)
  assert.ok(Math.abs(e.position - 2 * SR) < 200, `position ${e.position / SR}s`)
})

test('cents shift and slow speed combine (25% speed, -50 cents)', () => {
  const src = signal(4, (t) => 0.5 * Math.sin(2 * Math.PI * 440 * t))
  const e = new StretchEngine()
  e.setSource([src])
  const ratio = 2 ** (-0.5 / 12)
  e.setParams(0.25, ratio)
  e.reset(SR)
  const [out] = render(e, SR)
  const f = frequency(out.subarray(4096))
  assert.ok(Math.abs(f - 440 * ratio) < 1, `frequency ${f}, expected ${440 * ratio}`)
  assert.ok(Math.abs(e.position - 1.25 * SR) < 200, `position ${e.position / SR}s`)
})

test('5% speed stays stable and keeps level', () => {
  const src = signal(2, (t) => 0.5 * Math.sin(2 * Math.PI * 196 * t))
  const e = new StretchEngine()
  e.setSource([src])
  e.setParams(0.05, 1)
  e.reset(SR / 2)
  const [out] = render(e, SR * 2)
  assert.ok(out.every(Number.isFinite))
  const r = rms(out.subarray(8192))
  assert.ok(Math.abs(r - 0.5 / Math.SQRT2) < 0.05, `rms ${r}`)
  assert.ok(Math.abs(frequency(out.subarray(8192)) - 196) < 1)
})

test('loop wraps seamlessly back to the loop start', () => {
  const src = richSignal()
  const e = new StretchEngine()
  e.setSource([src])
  e.setLoop(true, 20000, 30000)
  e.reset(25000)
  const [out] = render(e, 25000)
  let maxErr = 0
  for (let i = 256; i < out.length; i++) {
    const expected = src[20000 + ((5000 + i) % 10000)]
    maxErr = Math.max(maxErr, Math.abs(out[i] - expected))
  }
  assert.ok(maxErr < 1e-4, `max error ${maxErr}`)
  assert.ok(e.position >= 20000 && e.position < 30000, `position ${e.position}`)
  assert.equal(e.ended, false)
})

test('reaching the end without a loop sets ended', () => {
  const src = richSignal()
  const e = new StretchEngine()
  e.setSource([src, src])
  e.reset(src.length - 2000)
  render(e, 4096)
  assert.equal(e.ended, true)
})
