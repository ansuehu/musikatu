import type { Voicing } from '../analysis/guitar'

interface Props {
  voicing: Voicing
  /** Pitch class of the chord root, to highlight root notes. */
  rootPc: number
  tuning: number[]
  /** Semitones added by a capo (shape is relative to the capo). */
  capo: number
  noteName: (midi: number) => string
}

const FRETS_SHOWN = 5
const X0 = 22
const STRING_GAP = 15
const Y0 = 26
const FRET_GAP = 19

/** Classic chord box: strings vertical (low E on the left), nut on top, finger numbers in the dots. */
export function ChordDiagram({ voicing, rootPc, tuning, capo, noteName }: Props) {
  const { frets, fingers, barre } = voicing
  const n = frets.length
  const fretted = frets.filter((f) => f > 0)
  const maxF = fretted.length ? Math.max(...fretted) : 0
  const minF = fretted.length ? Math.min(...fretted) : 0
  const base = maxF <= FRETS_SHOWN ? 1 : minF
  const width = X0 + STRING_GAP * (n - 1)
  const bottom = Y0 + FRET_GAP * FRETS_SHOWN
  const sx = (s: number) => X0 + s * STRING_GAP
  const fy = (f: number) => Y0 + (f - base + 0.5) * FRET_GAP
  const midiAt = (s: number) => tuning[s] + capo + frets[s]
  const isRoot = (s: number) => frets[s] >= 0 && midiAt(s) % 12 === rootPc

  return (
    <svg className="chord-diagram" viewBox={`0 0 ${width + 16} ${bottom + 16}`} role="img" aria-label={`Frets ${frets.map((f) => (f < 0 ? 'x' : f)).join(' ')}`}>
      {/* nut or position label */}
      {base === 1 ? (
        <rect x={X0 - 1} y={Y0 - 3} width={width - X0 + 2} height={4} className="nut" />
      ) : (
        <text x={X0 - 6} y={fy(base) + 3.5} className="fret-label" textAnchor="end">
          {base}fr
        </text>
      )}
      {Array.from({ length: FRETS_SHOWN + 1 }, (_, i) => (
        <line key={`f${i}`} x1={X0} x2={width} y1={Y0 + i * FRET_GAP} y2={Y0 + i * FRET_GAP} className="fret" />
      ))}
      {frets.map((_, s) => (
        <line key={`s${s}`} x1={sx(s)} x2={sx(s)} y1={Y0} y2={bottom} className="string" style={{ strokeWidth: 1.6 - s * 0.16 }} />
      ))}
      {/* open / muted markers */}
      {frets.map((f, s) =>
        f < 0 ? (
          <text key={`m${s}`} x={sx(s)} y={Y0 - 8} className="mute" textAnchor="middle">
            ×
          </text>
        ) : f === 0 ? (
          <circle key={`o${s}`} cx={sx(s)} cy={Y0 - 11} r={4} className={`open ${isRoot(s) ? 'root' : ''}`} />
        ) : null,
      )}
      {barre && (
        <rect
          x={sx(barre.from) - 6}
          y={fy(barre.fret) - 6}
          width={sx(barre.to) - sx(barre.from) + 12}
          height={12}
          rx={6}
          className="barre"
        />
      )}
      {frets.map((f, s) =>
        f > 0 && !(barre && f === barre.fret && s >= barre.from && s <= barre.to) ? (
          <g key={`d${s}`}>
            <circle cx={sx(s)} cy={fy(f)} r={6.2} className={`dot ${isRoot(s) ? 'root' : ''}`} />
            {fingers[s] > 0 && (
              <text x={sx(s)} y={fy(f) + 3.2} className="finger" textAnchor="middle">
                {fingers[s]}
              </text>
            )}
          </g>
        ) : null,
      )}
      {barre && (
        <text x={(sx(barre.from) + sx(barre.to)) / 2} y={fy(barre.fret) + 3.2} className="finger" textAnchor="middle">
          1
        </text>
      )}
      {/* sounding note names under the strings */}
      {frets.map((f, s) => (
        <text key={`n${s}`} x={sx(s)} y={bottom + 11} className={`note ${isRoot(s) ? 'root' : ''}`} textAnchor="middle">
          {f < 0 ? '' : noteName(midiAt(s))}
        </text>
      ))}
    </svg>
  )
}
