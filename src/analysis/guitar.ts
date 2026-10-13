import { QUALITIES } from './notes.ts'

/** Standard tuning, low E → high e, as MIDI notes. */
export const STANDARD_TUNING = [40, 45, 50, 55, 59, 64]

export interface Barre {
  fret: number
  /** String indices (0 = low E), inclusive. */
  from: number
  to: number
}

export interface Voicing {
  /** Per string, low E → high e: -1 muted, 0 open, n fretted. */
  frets: number[]
  /** Finger per string (1 = index … 4 = pinky), 0 for open/muted. */
  fingers: number[]
  barre: Barre | null
}

const LETTER_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

/**
 * Familiar open / first-position shapes, preferred over generated ones.
 * Keyed by chord name; validated against the chord tones by the tests.
 */
const COMMON_SHAPES: Record<string, string[]> = {
  C: ['x32010', 'x35553'],
  C7: ['x32310'],
  Cmaj7: ['x32000'],
  Cadd9: ['x32030'],
  Cm: ['x35543'],
  D: ['xx0232', 'x57775'],
  Dm: ['xx0231', 'x57765'],
  D7: ['xx0212'],
  Dmaj7: ['xx0222'],
  Dm7: ['xx0211'],
  Dsus2: ['xx0230'],
  Dsus4: ['xx0233'],
  D5: ['x57xxx'],
  E: ['022100', '076454'],
  Em: ['022000'],
  E7: ['020100'],
  Em7: ['022030'],
  Emaj7: ['021100'],
  Esus4: ['022200'],
  E5: ['022xxx'],
  F: ['133211', 'xx3211'],
  Fmaj7: ['xx3210'],
  Fm: ['133111'],
  G: ['320003', '320033', '355433'],
  G7: ['320001'],
  Gmaj7: ['320002'],
  Gm: ['355333'],
  G5: ['355xxx'],
  A: ['x02220', '577655'],
  Am: ['x02210', '577555'],
  A7: ['x02020'],
  Am7: ['x02010'],
  Amaj7: ['x02120'],
  Asus2: ['x02200'],
  Asus4: ['x02230'],
  A5: ['x022xx'],
  B7: ['x21202'],
  Bm: ['x24432'],
  B: ['x24442'],
}

export function parseShape(shape: string): number[] {
  return [...shape].map((c) => (c === 'x' ? -1 : parseInt(c, 36)))
}

export function shapeToString(frets: number[]): string {
  return frets.map((f) => (f < 0 ? 'x' : f.toString(36))).join('')
}

/** Finger assignment, with a barre only when one is needed. Null if it needs more than four fingers. */
export function fingering(frets: number[]): { fingers: number[]; barre: Barre | null } | null {
  const fingers = frets.map(() => 0)
  const fretted = frets.flatMap((f, s) => (f > 0 ? [s] : []))
  if (fretted.length === 0) return { fingers, barre: null }
  const byFret = (a: number, b: number) => frets[a] - frets[b] || a - b
  if (fretted.length <= 4) {
    fretted.sort(byFret).forEach((s, i) => (fingers[s] = i + 1))
    return { fingers, barre: null }
  }
  const fmin = Math.min(...fretted.map((s) => frets[s]))
  const from = fretted.find((s) => frets[s] === fmin)!
  let to = from
  for (let s = from + 1; s < frets.length && frets[s] >= fmin; s++) to = s
  const covered = new Set<number>()
  for (let s = from; s <= to; s++) if (frets[s] === fmin) covered.add(s)
  if (covered.size < 2) return null
  for (const s of covered) fingers[s] = 1
  const rest = fretted.filter((s) => !covered.has(s)).sort(byFret)
  if (rest.length > 3) return null
  rest.forEach((s, i) => (fingers[s] = i + 2))
  return { fingers, barre: { fret: fmin, from, to } }
}

function toVoicing(frets: number[]): Voicing | null {
  const f = fingering(frets)
  return f ? { frets, ...f } : null
}

interface Candidate {
  frets: number[]
  score: number
}

/** Search the fretboard (4-fret windows) for playable shapes of a chord. */
function generate(tones: Set<number>, required: number[], optional: number | null, bass: number, tuning: number[]): Candidate[] {
  const out = new Map<string, Candidate>()
  const nStrings = tuning.length
  const minSounding = tones.size <= 2 ? 2 : 4
  const frets = new Array<number>(nStrings)

  for (let lo = 1; lo <= 12; lo++) {
    const hi = lo + 3
    const options = tuning.map((open) => {
      const o = [-1]
      if (tones.has(open % 12)) o.push(0)
      for (let f = lo; f <= hi; f++) if (tones.has((open + f) % 12)) o.push(f)
      return o
    })
    // mutes only as a run on the bass side and/or a run on the treble side, never in between
    const walk = (s: number, phase: 0 | 1 | 2) => {
      if (s === nStrings) return evaluate()
      for (const f of options[s]) {
        if (f < 0) {
          if (phase === 1) {
            frets[s] = -1
            walk(s + 1, 2)
          } else {
            frets[s] = -1
            walk(s + 1, phase)
          }
        } else if (phase !== 2) {
          frets[s] = f
          walk(s + 1, 1)
        }
      }
    }
    const evaluate = () => {
      const sounding = frets.flatMap((f, s) => (f >= 0 ? [s] : []))
      if (sounding.length < minSounding) return
      if ((tuning[sounding[0]] + frets[sounding[0]]) % 12 !== bass) return
      const present = new Set(sounding.map((s) => (tuning[s] + frets[s]) % 12))
      if (!required.every((pc) => present.has(pc))) return
      const fretted = sounding.filter((s) => frets[s] > 0).map((s) => frets[s])
      const minF = fretted.length ? Math.min(...fretted) : 0
      const maxF = fretted.length ? Math.max(...fretted) : 0
      const opens = sounding.length - fretted.length
      if (opens > 0 && maxF > 5) return // open strings far from the nut are awkward
      const key = shapeToString(frets)
      if (out.has(key)) return
      const f = fingering(frets)
      if (!f) return
      const bassMutes = sounding[0]
      const trebleMutes = nStrings - 1 - sounding[sounding.length - 1]
      const fingersUsed = new Set(f.fingers.filter((x) => x > 0)).size
      // an open string ringing between fretted ones (x10331) is harder to keep clean than a barre
      let interiorOpens = 0
      for (const s of sounding) if (frets[s] === 0 && sounding.some((t) => t < s && frets[t] > 0) && sounding.some((t) => t > s && frets[t] > 0)) interiorOpens++
      const score =
        bassMutes * 1 +
        trebleMutes * 2 +
        (minF > 0 ? minF * 0.35 : 0) +
        fingersUsed * 0.25 +
        (f.barre ? 0.6 : 0) +
        (maxF - minF) * 0.45 -
        opens * 0.3 +
        interiorOpens * 1.5 +
        (f.barre && f.barre.from > sounding.find((t) => frets[t] > 0)! ? 0.8 : 0) +
        (optional !== null && !present.has(optional) ? 0.4 : 0)
      out.set(key, { frets: [...frets], score })
    }
    walk(0, 0)
  }
  return [...out.values()]
}

const cache = new Map<string, Voicing[]>()

/**
 * Up to `max` voicings for a chord (root/bass as pitch classes, `suffix` as in QUALITIES),
 * familiar shapes first, then generated ones spread across the neck.
 */
export function chordVoicings(root: number, suffix: string, bass: number | null = null, max = 4, tuning = STANDARD_TUNING): Voicing[] {
  const quality = QUALITIES.find((q) => q.suffix === suffix)
  if (!quality) return []
  const bassPc = bass ?? root
  const key = `${root}|${suffix}|${bassPc}|${max}|${tuning.join(',')}`
  const hit = cache.get(key)
  if (hit) return hit

  const tones = new Set(quality.tones.map((t) => (root + t) % 12))
  tones.add(bassPc)
  // In four-or-more-note chords the fifth may be dropped.
  const fifth = quality.tones.includes(7) && quality.tones.length >= 4 ? (root + 7) % 12 : null
  const required = [...tones].filter((pc) => pc !== fifth)

  const result: Voicing[] = []
  const seen = new Set<string>()
  const push = (frets: number[]) => {
    const k = shapeToString(frets)
    if (seen.has(k) || result.length >= max) return
    const v = toVoicing(frets)
    if (v) {
      seen.add(k)
      result.push(v)
    }
  }

  if (bassPc === root && tuning === STANDARD_TUNING) {
    for (const [name, shapes] of Object.entries(COMMON_SHAPES)) {
      const m = /^([A-G])(.*)$/.exec(name)!
      if (LETTER_PC[m[1]] === root && m[2] === suffix) shapes.forEach((s) => push(parseShape(s)))
    }
  }

  const generated = generate(tones, required, fifth, bassPc, tuning).sort((a, b) => a.score - b.score)
  // Prefer variety: take shapes in different neck positions before near-duplicates.
  const position = (c: Candidate) => Math.min(...c.frets.filter((f) => f > 0).concat(99))
  const used = result.map((v) => Math.min(...v.frets.filter((f) => f > 0).concat(99)))
  for (const c of generated) {
    if (result.length >= max) break
    const p = position(c)
    if (used.some((u) => Math.abs(u - p) < 2)) continue
    used.push(p)
    push(c.frets)
  }
  for (const c of generated) push(c.frets)

  cache.set(key, result)
  return result
}

/** Exposed for tests: every curated shape, by name. */
export const COMMON_SHAPE_NAMES = Object.keys(COMMON_SHAPES)
export function commonShapes(name: string): string[] {
  return COMMON_SHAPES[name] ?? []
}
export { LETTER_PC }
