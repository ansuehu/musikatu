/**
 * Transcribes evaluation songs to notes the way the app does (Basic Pitch, per-source note ranges), from the
 * full mix and from each harmony stem. Writes <dir>/notes/<name>.<source>.json: [{ start, end, midi, velocity }]
 * in seconds.  Usage: node scripts/chord-eval/transcribe.ts <dir> [song names…]
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_NOTE_PARAMS, extractNotes, frameTime } from '../../src/transcription/basicPitch.ts'
import { SOURCE_RANGE, type NoteSource } from '../../src/transcription/types.ts'

const require = createRequire(import.meta.url)
const ort = require('onnxruntime-node')
const bp = require('../../electron/transcription/basic-pitch.cjs')

const dir = process.argv[2]
const only = process.argv.slice(3)
const decode = (file: string) => {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(bp.SAMPLE_RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}

const session = await bp.createSession(ort)
fs.mkdirSync(path.join(dir, 'notes'), { recursive: true })
for (const song of fs.readdirSync(dir).filter((f) => f.endsWith('.lab')).map((f) => f.slice(0, -4))) {
  if (only.length && !only.includes(song)) continue
  const srcFile = path.join(dir, `${song}.src`)
  const sources: [NoteSource, string][] = [['mix', fs.readFileSync(srcFile, 'utf8').trim()]]
  for (const s of ['bass', 'guitar', 'piano', 'other'] as const) {
    const f = path.join(dir, 'stems', song, `${s}.wav`)
    if (fs.existsSync(f)) sources.push([s, f])
  }
  for (const [source, file] of sources) {
    const out = path.join(dir, 'notes', `${song}.${source}.json`)
    if (fs.existsSync(out)) continue
    const t0 = performance.now()
    const p = await bp.posteriors(ort, session, decode(file))
    const [minMidi, maxMidi] = SOURCE_RANGE[source]
    const notes = extractNotes(p.note, p.onset, p.frames, { ...DEFAULT_NOTE_PARAMS, minMidi, maxMidi }).map((n) => ({
      start: +frameTime(n.start).toFixed(4),
      end: +frameTime(n.end).toFixed(4),
      midi: n.midi,
      velocity: Math.max(1, Math.min(127, Math.round(127 * n.amplitude))),
    }))
    fs.writeFileSync(out, JSON.stringify(notes))
    console.log(`${song} / ${source}: ${notes.length} notes in ${((performance.now() - t0) / 1000).toFixed(1)} s`)
  }
}
