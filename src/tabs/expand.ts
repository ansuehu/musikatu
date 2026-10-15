import type { TabBar, TabDirection } from './model.ts'

/** One bar of the tab as it is played: repeats, alternate endings and D.C./D.S./Coda jumps written out. */
export interface PlayedBar {
  /** Index of the written bar. */
  bar: number
  /** Pass through the repeat it is in, 0-based (0 outside repeats). */
  pass: number
  /** Index of the block (section, or stretch between repeat signs and jumps) this play belongs to. */
  block: number
  /** Section name in force at this bar ("" before the first section marker). */
  section: string
}

/** Safety net against malformed files (repeat loops that never end). */
const MAX_PLAYED = 20000

const JUMPS: Partial<Record<TabDirection, { to: 'start' | 'Segno' | 'SegnoSegno'; until: 'end' | 'Fine' | 'Coda' | 'DoubleCoda' }>> = {
  DaCapo: { to: 'start', until: 'end' },
  DaCapoAlFine: { to: 'start', until: 'Fine' },
  DaCapoAlCoda: { to: 'start', until: 'Coda' },
  DaCapoAlDoubleCoda: { to: 'start', until: 'DoubleCoda' },
  DalSegno: { to: 'Segno', until: 'end' },
  DalSegnoAlFine: { to: 'Segno', until: 'Fine' },
  DalSegnoAlCoda: { to: 'Segno', until: 'Coda' },
  DalSegnoAlDoubleCoda: { to: 'Segno', until: 'DoubleCoda' },
  DalSegnoSegno: { to: 'SegnoSegno', until: 'end' },
  DalSegnoSegnoAlFine: { to: 'SegnoSegno', until: 'Fine' },
  DalSegnoSegnoAlCoda: { to: 'SegnoSegno', until: 'Coda' },
  DalSegnoSegnoAlDoubleCoda: { to: 'SegnoSegno', until: 'DoubleCoda' },
}

/**
 * Writes out the order the bars are played in. Repeats are taken as marked, alternate endings on their
 * passes. After a D.C. or D.S. jump, repeats are not taken again and only the last ending of each group
 * is played (the usual convention); "al Coda" jumps at "To Coda" (DaCoda), "al Fine" stops at Fine.
 */
export function expandBars(bars: TabBar[]): PlayedBar[] {
  const n = bars.length
  const out: PlayedBar[] = []
  const find = (d: TabDirection) => bars.findIndex((b) => b.directions.includes(d))
  // the last ending of each group of endings: the one played after a jump
  const lastEnding = bars.map(() => false)
  for (let k0 = 0; k0 < n; k0++) {
    if (!bars[k0].endings || (k0 > 0 && bars[k0 - 1].endings)) continue
    let k1 = k0
    while (k1 + 1 < n && bars[k1 + 1].endings) k1++
    let top = 0
    for (let k = k0; k <= k1; k++) top = Math.max(top, highBit(bars[k].endings))
    for (let k = k0; k <= k1; k++) lastEnding[k] = highBit(bars[k].endings) === top
  }

  let i = 0
  let pass = 0
  let start = 0
  let jumped = false
  let until: 'end' | 'Fine' | 'Coda' | 'DoubleCoda' = 'end'
  const taken = new Set<number>()
  let section = ''
  let block = -1
  let newBlock = true

  while (i < n && out.length < MAX_PLAYED) {
    const b = bars[i]
    if (b.endings && !(jumped ? lastEnding[i] : b.endings & (1 << pass))) {
      i++
      newBlock = true
      continue
    }
    if (b.section !== null) {
      section = b.section
      newBlock = true
    }
    if (newBlock) block++
    newBlock = false
    out.push({ bar: i, pass: jumped ? 0 : pass, block, section })

    if (jumped && until === 'Fine' && b.directions.includes('Fine')) break
    if (jumped && until === 'Coda' && b.directions.includes('DaCoda')) {
      i = Math.max(0, find('Coda'))
      newBlock = true
      continue
    }
    if (jumped && until === 'DoubleCoda' && b.directions.includes('DaDoubleCoda')) {
      i = Math.max(0, find('DoubleCoda'))
      newBlock = true
      continue
    }
    const jump = b.directions.map((d) => JUMPS[d]).find((j) => j)
    if (jump && !taken.has(i) && (!jumped || jump.until === 'end')) {
      // a D.C./D.S. is taken once; repeats before it are done first
      if (b.repeatEnd > 0 && !jumped && pass < b.repeatEnd - 1) {
        pass++
        i = start
        newBlock = true
        continue
      }
      taken.add(i)
      jumped = true
      until = jump.until
      i = jump.to === 'start' ? 0 : Math.max(0, find(jump.to))
      pass = 0
      newBlock = true
      continue
    }
    if (b.repeatEnd > 0 && !jumped) {
      if (pass < b.repeatEnd - 1) {
        pass++
        i = start
        newBlock = true
        continue
      }
      pass = 0
      start = i + 1
      newBlock = true
    } else if (b.endings && !(i + 1 < n && bars[i + 1].endings)) {
      // left the last ending of a group: the repeat is over
      pass = 0
      start = i + 1
      newBlock = true
    }
    i++
    if (i < n && bars[i].repeatStart) {
      start = i
      pass = 0
      newBlock = true
    }
  }
  return out
}

function highBit(mask: number): number {
  return 31 - Math.clz32(mask)
}
