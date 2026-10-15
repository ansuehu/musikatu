/**
 * Makes Guitar Pro test tabs, and where each of their bars falls in the recording, from song
 * descriptions (<dir>/<song>.json, kept local with the audio):
 *
 *   node scripts/tab-eval/make-tabs.ts <dir>
 *
 * Writes <dir>/out/<song>.<variant>.gp, .truth.json and .written.json (written bar number per played bar). A description lists the guitar shapes, the
 * sections in tab order with their bars and repeat counts, and the beat (of <song>.beats.json) where
 * each pass starts in the recording. Variants change the tab the way real tabs differ from recordings:
 *
 *   clean        as described
 *   cut-intro    first section left out
 *   cut-outro    last section left out
 *   drop-pass    a section repeated fewer times than the recording plays it ("dropPass": [section, n])
 *   extra-pass   a section repeated more times than the recording plays it ("extraPass": [section, n])
 *   transposed   written without capo / in standard tuning ("transposed": { capo, tuning })
 *   guitar-only  no bass track
 *   messy        cut-intro, drop-pass, extra-pass and transposed together
 *
 * Truth: per played bar, the beats it may start on (several when passes of a repeat are
 * interchangeable, none when the recording doesn't play it).
 */
import fs from 'node:fs'
import path from 'node:path'
import * as alphaTab from '@coderline/alphatab'

interface Section {
  name: string
  /** Bars: "Em7 G" (4/4, chords share the bar), or "2/4: A7sus4". */
  bars: string[]
  repeat?: number
  /** Beat where the first pass starts; passes follow each other. */
  at: number
}

interface Song {
  title: string
  tempo: number
  tuning: number[]
  capo: number
  /** Frets per chord, lowest string first ("x" mutes), relative to the capo. */
  shapes: Record<string, string>
  sections: Section[]
  dropPass: [string, number]
  extraPass: [string, number]
  transposed: { capo: number; tuning: number[] }
}

const NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
const noteName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`

function parseBar(b: string): { num: number; den: number; chords: string[] } {
  const m = /^(\d+)\/(\d+):\s*(.*)$/.exec(b)
  return m ? { num: +m[1], den: +m[2], chords: m[3].split(/\s+/) } : { num: 4, den: 4, chords: b.split(/\s+/) }
}

/** alphaTex for the tab, and the truth per played bar. */
function build(song: Song, sections: (Section & { audioPasses: number })[], opts: { capo: number; tuning: number[]; bass: boolean }) {
  const guitar: string[] = []
  const bass: string[] = []
  const truth: number[][] = []
  /** Written bar number (1-based) of each played bar. */
  const written: number[] = []
  let lastTs = '4/4'
  for (const s of sections) {
    const passes = s.repeat ?? 1
    const bars = s.bars.map(parseBar)
    const passBeats = bars.reduce((a, b) => a + (b.num * 4) / b.den, 0)
    // which recording passes each tab pass may sit on: shifted by the passes the tab has more or fewer
    const first = guitar.length + 1
    for (let p = 0; p < passes; p++) {
      const lo = Math.max(0, p - Math.max(0, passes - s.audioPasses))
      const hi = Math.min(s.audioPasses - 1, p + Math.max(0, s.audioPasses - passes))
      let beat = 0
      for (const [k, b] of bars.entries()) {
        written.push(first + k)
        const ok: number[] = []
        for (let a = lo; a <= hi; a++) ok.push(s.at + a * passBeats + beat)
        truth.push(ok)
        beat += (b.num * 4) / b.den
      }
    }
    bars.forEach((b, i) => {
      const meta: string[] = []
      if (i === 0) meta.push(`\\section "${s.name}"`)
      if (i === 0 && passes > 1) meta.push('\\ro')
      if (i === bars.length - 1 && passes > 1) meta.push(`\\rc ${passes}`)
      const ts = `${b.num}/${b.den}`
      if (ts !== lastTs) meta.push(`\\ts ${b.num} ${b.den}`)
      lastTs = ts
      // eighth-note strums, each chord for its share of the bar
      const eighths = (b.num * 8) / b.den / b.chords.length
      const strums = b.chords.flatMap((c) => {
        const frets = song.shapes[c]
        if (!frets) throw new Error(`no shape for ${c}`)
        const notes = frets
          .split(/\s+/)
          .map((f, k) => (f === 'x' ? null : `${f}.${6 - k}`))
          .filter(Boolean)
        return Array(eighths).fill(`(${notes.join(' ')})`)
      })
      guitar.push(`${meta.join(' ')} :8 ${strums.join(' ')}`)
      // bass: the chord's lowest sounding note on quarters, as played on a 4-string bass in E
      const quarters = (b.num * 4) / b.den / b.chords.length
      const notes = b.chords.flatMap((c) => {
        const frets = song.shapes[c].split(/\s+/)
        const k = frets.findIndex((f) => f !== 'x')
        // in the tab's key: a transposed tab moves the bass with the guitar
        let midi = opts.tuning[k] + opts.capo + Number(frets[k])
        while (midi >= 43 + 5) midi -= 12
        while (midi < 28) midi += 12
        const str = midi >= 43 ? 1 : midi >= 38 ? 2 : midi >= 33 ? 3 : 4
        const fret = midi - [43, 38, 33, 28][str - 1]
        return Array(quarters).fill(`${fret}.${str}`)
      })
      bass.push(`:4 ${notes.join(' ')}`)
    })
  }
  const tuning = [...opts.tuning].reverse().map(noteName).join(' ')
  const tex = [
    `\\title "${song.title} (test tab)" \\tempo ${song.tempo}`,
    `\\track "Guitar"`,
    `\\staff {tabs}`,
    `\\tuning (${tuning})`,
    opts.capo ? `\\capo ${opts.capo}` : '',
    guitar.join(' |\n') + ' |',
    ...(opts.bass ? [`\\track "Bass"`, `\\staff {tabs}`, `\\tuning (g2 d2 a1 e1)`, bass.join(' |\n') + ' |'] : []),
  ].join('\n')
  return { tex, truth, written }
}

const dir = process.argv[2]
fs.mkdirSync(path.join(dir, 'out'), { recursive: true })
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
  const song = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Song
  const name = f.slice(0, -5)
  const base = song.sections.map((s) => ({ ...s, audioPasses: s.repeat ?? 1 }))
  const withRepeat = (secs: typeof base, [sec, n]: [string, number]) => secs.map((s) => (s.name === sec ? { ...s, repeat: n } : s))
  const plain = { capo: song.capo, tuning: song.tuning, bass: true }
  const variants: Record<string, [typeof base, typeof plain]> = {
    clean: [base, plain],
    'cut-intro': [base.slice(1), plain],
    'cut-outro': [base.slice(0, -1), plain],
    'drop-pass': [withRepeat(base, song.dropPass), plain],
    'extra-pass': [withRepeat(base, song.extraPass), plain],
    transposed: [base, { ...song.transposed, bass: true }],
    'guitar-only': [base, { ...plain, bass: false }],
    messy: [withRepeat(withRepeat(base.slice(1), song.dropPass), song.extraPass), { ...song.transposed, bass: true }],
  }
  for (const [variant, [secs, opts]] of Object.entries(variants)) {
    const { tex, truth, written } = build(song, secs, opts)
    const score = alphaTab.importer.ScoreLoader.loadAlphaTex(tex, new alphaTab.Settings())
    const bytes = new alphaTab.exporter.Gp7Exporter().export(score, new alphaTab.Settings())
    fs.writeFileSync(path.join(dir, 'out', `${name}.${variant}.gp`), bytes)
    fs.writeFileSync(path.join(dir, 'out', `${name}.${variant}.truth.json`), JSON.stringify(truth))
    fs.writeFileSync(path.join(dir, 'out', `${name}.${variant}.written.json`), JSON.stringify(written))
  }
  console.log(`${name}: ${Object.keys(variants).length} variants`)
}
