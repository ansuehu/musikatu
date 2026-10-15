/**
 * Chord-chart evaluation: runs the app's chord analysis on songs with a reference annotation and scores it.
 *
 *   node scripts/chord-eval/eval.ts <dir> [song names…]
 *
 * <dir> holds, per song: <name>.lab (reference: "start end chord" per line, seconds), <name>.beats.json
 * (from prepare.cjs) and the audio as <name>.flac/.wav/.mp3/.m4a, or the path in <name>.src. Stems, when
 * present in <dir>/stems/<name>/ (separate.cjs), are evaluated too, as the app uses them.
 * DUMP=<method>:<source> writes that method's charts to <dir>/out/ for inspection; VOCAB picks the vocabulary.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { analyzeChords, BEAT_SWITCH_PENALTY, type ChordNote, type ChordSegment, type Vocabulary } from '../../src/analysis/chordTimeline.ts'
import { chordName, estimateNotes } from '../../src/analysis/notes.ts'
import { SpectrumAnalyzer } from '../../src/analysis/spectrum.ts'
import { withNotes, type NoteSet } from '../../src/analysis/noteHarmony.ts'
import { snapSegmentsToBeats } from '../../src/rhythm/sheet.ts'
import { readLab, score, type Scores, type Span } from './score.ts'

const SR = 44100
const dir = process.argv[2]
const only = process.argv.slice(3)
const vocabulary = (process.env.VOCAB ?? 'standard') as Vocabulary
// PENALTY_SCALE=<k> scales the beat switch costs, for checking how sensitive the results are to them
const scale = Number(process.env.PENALTY_SCALE ?? 1)
for (const k of Object.keys(BEAT_SWITCH_PENALTY) as (keyof typeof BEAT_SWITCH_PENALTY)[]) BEAT_SWITCH_PENALTY[k] *= scale

const decode = (file: string) => {
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  return new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}

function audioFor(name: string): string {
  const src = path.join(dir, `${name}.src`)
  if (fs.existsSync(src)) return fs.readFileSync(src, 'utf8').trim()
  for (const ext of ['flac', 'wav', 'mp3', 'm4a', 'ogg']) if (fs.existsSync(path.join(dir, `${name}.${ext}`))) return path.join(dir, `${name}.${ext}`)
  throw new Error(`No audio for ${name}`)
}

const toSpans = (segs: ChordSegment[]): Span[] => segs.map((s) => ({ start: s.start / SR, end: s.end / SR, label: s.chord ? chordName({ ...s.chord, score: 0 }) : 'N' }))

const NOTE_W = process.env.NOTE_W ? Number(process.env.NOTE_W) : undefined
const METHODS: Record<string, (mono: Float32Array, beats: number[], downbeats: number[], notes: ChordNote[] | null) => ChordSegment[] | null> = {
  // what the app did before: frame-level decoding, then changes moved to the nearest beat within 0.25 s
  'frames+snap': (mono, beats) => snapSegmentsToBeats(analyzeChords(mono, SR, { vocabulary }), beats, Math.round(0.25 * SR)),
  'beat-sync': (mono, beats, downbeats) => analyzeChords(mono, SR, { vocabulary, beats, downbeats }),
  // with the transcribed notes (notes/<song>.<source>.json from transcribe.ts)
  'audio+notes': (mono, beats, downbeats, notes) => (notes ? analyzeChords(mono, SR, { vocabulary, beats, downbeats, notes, noteWeight: NOTE_W }) : null),
  'notes only': (mono, beats, downbeats, notes) => (notes ? analyzeChords(mono, SR, { vocabulary, beats, downbeats, notes, noteWeight: 1 }) : null),
}

/**
 * The live chord guess as the panel shows it, sampled every 0.25 s (no smoothing, no beats): from the
 * spectrum alone, or with the transcribed notes blended in.
 */
function liveGuess(mono: Float32Array, notes: ChordNote[] | null): ChordSegment[] {
  const an = new SpectrumAnalyzer(16384)
  const step = Math.round(0.25 * SR)
  const set: NoteSet | null = notes ? { key: '', notes, maxLength: notes.reduce((m, n) => Math.max(m, n.end - n.start), 0) } : null
  const out: ChordSegment[] = []
  for (let pos = step / 2; pos < mono.length; pos += step) {
    let est = estimateNotes(an.analyze([mono], pos, 'stereo', SR), SR / an.size)
    if (set) est = withNotes(est, set, pos, SR, 0)
    const c = est.chord
    out.push({ start: pos - step / 2, end: Math.min(mono.length, pos + step / 2), chord: c ? { root: c.root, suffix: c.suffix, bass: c.bass } : null, confidence: 0 })
  }
  return out
}
METHODS['live guess'] = (mono) => liveGuess(mono, null)
METHODS['live+notes'] = (mono, _b, _d, notes) => (notes ? liveGuess(mono, notes) : null)

/** Transcribed notes for a song's source ('mix', or the harmony stems together), in samples. */
function notesFor(song: string, source: string): ChordNote[] | null {
  const files = (source === 'mix' ? ['mix'] : ['bass', 'guitar', 'piano', 'other']).map((s) => path.join(dir, 'notes', `${song}.${s}.json`)).filter((f) => fs.existsSync(f))
  if (!files.length) return null
  return files
    .flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')) as ChordNote[])
    .map((n) => ({ ...n, start: Math.round(n.start * SR), end: Math.round(n.end * SR) }))
    .sort((a, b) => a.start - b.start)
}

const songs = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith('.lab'))
  .map((f) => f.slice(0, -4))
  .filter((n) => only.length === 0 || only.includes(n))

const rows: { song: string; source: string; method: string; s: Scores }[] = []
for (const song of songs) {
  const ref = readLab(fs.readFileSync(path.join(dir, `${song}.lab`), 'utf8'))
  const { beats: bs, downbeats: ds } = JSON.parse(fs.readFileSync(path.join(dir, `${song}.beats.json`), 'utf8')) as { beats: number[]; downbeats: number[] }
  const beats = bs.map((t) => Math.round(t * SR))
  // downbeats as indices into beats
  const downbeats = ds.map((t) => bs.reduce((best, b, i) => (Math.abs(b - t) < Math.abs(bs[best] - t) ? i : best), 0))
  const sources: [string, () => Float32Array][] = [['mix', () => decode(audioFor(song))]]
  const stemDir = path.join(dir, 'stems', song)
  if (fs.existsSync(path.join(stemDir, 'guitar.wav')))
    sources.push([
      'stems',
      () => {
        const parts = ['bass', 'guitar', 'piano', 'other'].map((s) => decode(path.join(stemDir, `${s}.wav`)))
        const out = new Float32Array(parts[0].length)
        for (const p of parts) for (let i = 0; i < out.length; i++) out[i] += p[i]
        return out
      },
    ])
  for (const [source, load] of sources) {
    const mono = load()
    const notes = notesFor(song, source)
    for (const [method, run] of Object.entries(METHODS)) {
      const segs = run(mono, beats, downbeats, notes)
      if (!segs) continue
      const est = toSpans(segs)
      rows.push({ song, source, method, s: score(ref, est) })
      if (process.env.DUMP === `${method}:${source}`) fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
      if (process.env.DUMP === `${method}:${source}`) fs.writeFileSync(path.join(dir, 'out', `${song}.${method}.${source}.lab`), est.map((e) => `${e.start.toFixed(3)} ${e.end.toFixed(3)} ${e.label}`).join('\n'))
    }
  }
}

const pct = (v: number) => (100 * v).toFixed(1).padStart(5)
console.log(`vocabulary: ${vocabulary}`)
console.log('song                          source  method       root  maj/min  ≥3 notes  segm.  changes/min')
for (const r of rows) console.log(`${r.song.padEnd(30)}${r.source.padEnd(8)}${r.method.padEnd(13)}${pct(r.s.root)}  ${pct(r.s.majmin)}    ${pct(r.s.mirex)}  ${pct(r.s.seg)}  ${r.s.changesPerMin.toFixed(1).padStart(6)}`)
for (const source of ['mix', 'stems'])
  for (const method of Object.keys(METHODS)) {
    const rs = rows.filter((r) => r.source === source && r.method === method)
    if (!rs.length) continue
    const m = (k: keyof Scores) => rs.reduce((a, r) => a + r.s[k], 0) / rs.length
    console.log(`${'MEAN'.padEnd(30)}${source.padEnd(8)}${method.padEnd(13)}${pct(m('root'))}  ${pct(m('majmin'))}    ${pct(m('mirex'))}  ${pct(m('seg'))}  ${m('changesPerMin').toFixed(1).padStart(6)}`)
  }
