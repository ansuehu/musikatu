// Turns a beat-indexed chord chart into a .lab reference using the song's tracked beats.
// Chart lines: "<start beat> <beats per chord> <chord> [<chord>…] [xN]" (beats index <name>.beats.json),
// plus "end <beat>" to close the last chord. Usage: node chart2lab.cjs <dir> <name>
const fs = require('node:fs')
const path = require('node:path')
const [dir, name] = process.argv.slice(2)
const { beats } = JSON.parse(fs.readFileSync(path.join(dir, `${name}.beats.json`), 'utf8'))
const events = []
let end = null
for (const raw of fs.readFileSync(path.join(dir, `${name}.chart`), 'utf8').split('\n')) {
  const line = raw.replace(/(^|\s)#(\s.*)?$/, '').trim() // "# comment", but not the # in F#m
  if (!line) continue
  const parts = line.split(/\s+/)
  if (parts[0] === 'end') {
    end = +parts[1]
    continue
  }
  let [b, per, ...chords] = parts
  let times = 1
  if (/^x\d+$/.test(chords[chords.length - 1])) times = +chords.pop().slice(1)
  let k = +b
  for (let t = 0; t < times; t++) for (const c of chords) (events.push([k, c]), (k += +per))
}
events.sort((a, b) => a[0] - b[0])
const lab = events.map(([k, c], i) => {
  const next = i + 1 < events.length ? events[i + 1][0] : end
  if (next === null) throw new Error('missing "end <beat>"')
  if (i + 1 < events.length && next !== k + 0 && events[i + 1][0] < k) throw new Error(`overlap at beat ${k}`)
  return `${beats[k].toFixed(3)} ${beats[next].toFixed(3)} ${c}`
})
// check that the chart has no gaps
for (let i = 1; i < events.length; i++) if (events[i][0] <= events[i - 1][0]) throw new Error(`chart out of order at beat ${events[i][0]}`)
fs.writeFileSync(path.join(dir, `${name}.lab`), lab.join('\n') + '\n')
console.log(`${name}: ${lab.length} chords, ${beats[events[0][0]].toFixed(1)}–${beats[end].toFixed(1)} s`)
