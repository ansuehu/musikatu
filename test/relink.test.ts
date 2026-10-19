import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findMovedSong, likeness, loudness, sameSong } from '../src/stems/relink.ts'
import { hasUserWork } from '../src/project.ts'

const SR = 8000

function rand(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
}

/** A "song": noise whose loudness follows a pattern of its own (`seed`), `seconds` long. */
function song(seed: number, seconds = 40): Float32Array {
  const r = rand(seed)
  const out = new Float32Array(seconds * SR)
  let level = 0.5
  for (let i = 0; i < out.length; i++) {
    if (i % (SR / 4) === 0) level = 0.05 + r()
    out[i] = level * (r() * 2 - 1)
  }
  return out
}

/** Split a signal into `n` parts that add back up to it (like stems). */
function split(x: Float32Array, n: number): Float32Array[] {
  const parts = Array.from({ length: n }, () => new Float32Array(x.length))
  for (let i = 0; i < x.length; i++) {
    const band = Math.floor(i / 997) % n
    parts[band][i] = x[i]
  }
  return parts
}

const fakeBuffer = (channels: Float32Array[]) =>
  ({ numberOfChannels: channels.length, sampleRate: SR, length: channels[0].length, duration: channels[0].length / SR, getChannelData: (c: number) => channels[c] }) as unknown as AudioBuffer

test('loudness envelopes of the same recording match, of different ones do not', () => {
  const a = song(1)
  assert.ok(likeness(loudness([a], SR), loudness([a], SR)) > 0.999)
  assert.ok(likeness(loudness([a], SR), loudness([song(2)], SR)) < 0.5)
})

test('stems that add up to the song are recognised as that song', () => {
  const a = song(3)
  assert.ok(sameSong({ channels: [a, a], sampleRate: SR }, { channels: split(a, 6), sampleRate: SR }))
  assert.ok(!sameSong({ channels: [a, a], sampleRate: SR }, { channels: split(song(4), 6), sampleRate: SR }))
})

/** The app's side of the search, with a stem cache and projects in memory. */
function deps(cache: Record<string, Float32Array>, projects: { key: string; name: string }[] = []) {
  const encoded = new Map<string, Float32Array[]>()
  return {
    stems: {
      findMoved: async () => Object.keys(cache),
      load: async (key: string) => {
        const parts = split(cache[key], 6)
        return { stems: parts.map((p, i) => (encoded.set(`${key}:${i}`, [p]), { name: `${key}:${i}`, data: new TextEncoder().encode(`${key}:${i}`) })) }
      },
    },
    findMovedProjects: async () => projects,
    decode: async (data: ArrayBuffer) => fakeBuffer(encoded.get(new TextDecoder().decode(data))!),
  }
}

test('a moved song is found by the sound of its stems, not by name or length alone', async () => {
  const mine = song(5)
  const other = song(6)
  const d = deps({ 'path:/old/other.flac': other, 'path:/old/mine.flac': mine })
  const found = await findMovedSong(d, fakeBuffer([mine, mine]), 'renamed.flac', 44100)
  assert.deepEqual(found, { from: 'path:/old/mine.flac', stems: true })
  // another song of the same length is not taken
  assert.equal(await findMovedSong(deps({ 'path:/old/other.flac': other }), fakeBuffer([mine, mine]), 'mine.flac', 44100), null)
})

test('without stems, a project is taken when the name matches, or when the user pointed at it', async () => {
  const mine = song(7)
  const projects = [
    { key: 'path:/old/a.flac', name: 'a.flac' },
    { key: 'path:/old/mine.flac', name: 'mine.flac' },
  ]
  assert.deepEqual(await findMovedSong(deps({}, projects), fakeBuffer([mine]), 'mine.flac', 44100), { from: 'path:/old/mine.flac', stems: false })
  assert.equal(await findMovedSong(deps({}, projects), fakeBuffer([mine]), 'b.flac', 44100), null)
  assert.deepEqual(await findMovedSong(deps({}, projects), fakeBuffer([mine]), 'b.flac', 44100, 'path:/old/a.flac'), { from: 'path:/old/a.flac', stems: false })
  // a project whose stems turned out to be another song's is not taken either
  const wrong = deps({ 'path:/old/mine.flac': song(8) }, projects)
  assert.equal(await findMovedSong(wrong, fakeBuffer([mine]), 'mine.flac', 44100), null)
})

test('only projects with work in them are kept from being replaced', () => {
  assert.equal(hasUserWork(null), false)
  assert.equal(hasUserWork({ version: 1, markers: [], loops: [], speed: 0.8 }), false)
  assert.equal(hasUserWork({ version: 1, markers: [{ id: 'm', kind: 'section', pos: 0, name: 'Verse' }] }), true)
})
