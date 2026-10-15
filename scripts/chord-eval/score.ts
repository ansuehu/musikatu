/**
 * Chord-recognition scores in the style of MIREX / mir_eval, time-weighted on a 10 ms grid.
 * Labels are chord names as the app writes them ("F♯m7", "Esus4", "A/C♯") or "N" for no chord.
 */
import { QUALITIES, parseChordName } from '../../src/analysis/notes.ts'

export interface Span {
  start: number
  end: number
  label: string
}

interface Parsed {
  root: number
  tones: Set<number>
  /** 'maj' | 'min' for chords that reduce to a triad quality, else null (excluded from maj/min, as in mir_eval). */
  majmin: 'maj' | 'min' | null
}

const cache = new Map<string, Parsed | null>()

export function parseLabel(label: string): Parsed | null {
  if (cache.has(label)) return cache.get(label)!
  let out: Parsed | null = null
  if (!/^(N|X|N\.C\.)$/i.test(label)) {
    const c = parseChordName(label)
    if (!c) throw new Error(`Unknown chord label "${label}"`)
    const q = QUALITIES.find((x) => x.suffix === c.suffix)
    if (!q) throw new Error(`Unknown chord quality in "${label}"`)
    const tones = new Set(q.tones.map((t) => (c.root + t) % 12))
    const iv = new Set(q.tones)
    const majmin = iv.has(7) && iv.has(4) && !iv.has(3) ? 'maj' : iv.has(7) && iv.has(3) && !iv.has(4) ? 'min' : null
    out = { root: c.root, tones, majmin }
  }
  cache.set(label, out)
  return out
}

const labelAt = (spans: Span[], t: number) => {
  let lo = 0
  let hi = spans.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (t < spans[mid].start) hi = mid - 1
    else if (t >= spans[mid].end) lo = mid + 1
    else return spans[mid].label
  }
  return 'N'
}

/** Directional Hamming distance: how much of `a`'s segments is not covered by the single best segment of `b`. */
function directional(a: Span[], b: Span[]): number {
  let miss = 0
  let total = 0
  for (const s of a) {
    let best = 0
    for (const r of b) best = Math.max(best, Math.min(s.end, r.end) - Math.max(s.start, r.start))
    miss += s.end - s.start - best
    total += s.end - s.start
  }
  return total > 0 ? miss / total : 0
}

export interface Scores {
  root: number
  majmin: number
  mirex: number
  /** 1 − max(over-, under-segmentation); 1 = changes in exactly the right places. */
  seg: number
  changesPerMin: number
}

export function score(ref: Span[], est: Span[]): Scores {
  const step = 0.01
  const end = ref[ref.length - 1].end
  let n = 0
  let root = 0
  let mm = 0
  let mmN = 0
  let mirex = 0
  for (let t = ref[0].start + step / 2; t < end; t += step) {
    const r = parseLabel(labelAt(ref, t))
    const e = parseLabel(labelAt(est, t))
    n++
    if (!r) {
      // "no chord" in the reference: right only if we also say no chord
      if (!e) {
        root++
        mirex++
        mm++
      }
      mmN++
      continue
    }
    if (e && e.root === r.root) root++
    let shared = 0
    if (e) for (const pc of e.tones) if (r.tones.has(pc)) shared++
    if (e && shared >= Math.min(3, r.tones.size)) mirex++
    if (r.majmin) {
      mmN++
      if (e && e.root === r.root && e.majmin === r.majmin) mm++
    }
  }
  const clip = (s: Span[]) => s.filter((x) => x.end > ref[0].start && x.start < end).map((x) => ({ ...x, start: Math.max(x.start, ref[0].start), end: Math.min(x.end, end) }))
  const merge = (s: Span[]) => s.reduce<Span[]>((o, x) => (o.length && o[o.length - 1].label === x.label ? (o[o.length - 1].end = x.end, o) : (o.push({ ...x }), o)), [])
  const r = merge(clip(ref))
  const e = merge(clip(est))
  const seg = 1 - Math.max(directional(r, e), directional(e, r))
  return { root: root / n, majmin: mm / Math.max(1, mmN), mirex: mirex / n, seg, changesPerMin: (e.length - 1) / ((end - ref[0].start) / 60) }
}

export function readLab(text: string): Span[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [a, b, ...rest] = l.split(/\s+/)
      return { start: +a, end: +b, label: rest.join(' ') }
    })
}
