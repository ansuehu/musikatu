// Separates songs into stems with the app's separator, outside Electron (for the chord evaluation).
// Usage: node scripts/chord-eval/separate.cjs <modelPath> <outDir> <audio files…>  → <outDir>/<name>/<stem>.wav
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

let handler = null
let resolveJob = null
// stand-in for Electron's utility-process port
process.parentPort = {
  on: (_event, fn) => (handler = fn),
  postMessage: (m) => {
    if (m.type === 'progress' && m.done !== undefined) process.stdout.write(`\r  ${m.done}/${m.total} chunks (${m.ep})   `)
    if (m.type === 'done' || m.type === 'error') resolveJob(m)
  },
}
require('../../electron/stems/separator-process.cjs')

;(async () => {
  const [modelPath, outDir, ...files] = process.argv.slice(2)
  for (const file of files) {
    const name = path.basename(file).replace(/\.[^.]+$/, '')
    const dir = path.join(outDir, name)
    if (fs.existsSync(path.join(dir, 'guitar.wav'))) continue
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', '44100', '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
    const all = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4)
    const n = all.length / 2
    const left = new Float32Array(n)
    const right = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      left[i] = all[2 * i]
      right[i] = all[2 * i + 1]
    }
    console.log(name)
    const done = new Promise((r) => (resolveJob = r))
    handler({ data: { type: 'separate', jobId: 1, modelPath, device: process.env.DEVICE ?? 'gpu', left, right, outDir: dir, sources: ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'] } })
    const m = await done
    console.log(m.type === 'done' ? `\n  done in ${m.seconds.toFixed(0)} s` : `\n  error: ${m.message}`)
  }
  process.exit(0)
})()
