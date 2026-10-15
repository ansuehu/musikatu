// Decodes songs for the chord evaluation and tracks their beats with the app's beat model.
// Usage: node scripts/chord-eval/prepare.cjs <outDir> <audio files…>
// Writes <outDir>/<name>.f32 (mono, 22.05 kHz, float32) and <name>.beats.json ({ beats, downbeats } in seconds).
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const ort = require('onnxruntime-node')
const bt = require('../../electron/beats/beat-tracker.cjs')

;(async () => {
  const [outDir, ...files] = process.argv.slice(2)
  const sessions = await bt.createSessions(ort)
  for (const file of files) {
    const name = path.basename(file).replace(/\.[^.]+$/, '')
    const raw = path.join(outDir, `${name}.f32`)
    if (!fs.existsSync(raw)) execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(bt.SAMPLE_RATE), '-f', 'f32le', '-y', raw])
    const b = fs.readFileSync(raw)
    const mono = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)
    const { beats, downbeats } = await bt.trackBeats(ort, sessions, mono)
    fs.writeFileSync(path.join(outDir, `${name}.beats.json`), JSON.stringify({ beats, downbeats }))
    const ibi = beats.slice(1).map((x, i) => x - beats[i]).sort((a, c) => a - c)
    console.log(`${name}: ${(mono.length / bt.SAMPLE_RATE).toFixed(1)} s, ${beats.length} beats (${(60 / ibi[ibi.length >> 1]).toFixed(1)} BPM), ${downbeats.length} downbeats, first downbeats ${downbeats.slice(0, 4).map((x) => x.toFixed(2)).join(' ')}`)
  }
})()
