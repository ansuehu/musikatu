import { useEffect, useMemo, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { STANDARD_TUNING, chordVoicings } from '../analysis/guitar'
import { chordName, midiToFreq, pitchClassName, type ChordGuess, type Spelling } from '../analysis/notes'
import { ChordDiagram } from './ChordDiagram'
import { Btn } from './Controls'

interface Props {
  chord: ChordGuess | null
  engine: AudioEngine | null
  spelling: Spelling
  /** Written-pitch transposition of the note display; diagrams always sound at concert pitch. */
  transpose: number
  capo: number
  onCapo: (c: number) => void
  a4: number
}

/** A guess has to hold this long before the diagram switches, so it doesn't flicker during playback. */
const HOLD_MS = 220
const chordKey = (c: ChordGuess | null) => (c ? `${c.root}|${c.suffix}|${c.bass}` : '')

/** Guitar chord box for the current chord guess, with alternative voicings, capo, and click-to-strum. */
export function GuitarPanel({ chord, engine, spelling, transpose, capo, onCapo, a4 }: Props) {
  const [shown, setShown] = useState<ChordGuess | null>(null)
  const [index, setIndex] = useState(0)
  const key = chordKey(chord)

  useEffect(() => {
    if (!chord || key === chordKey(shown)) return
    const t = setTimeout(() => {
      setShown(chord)
      setIndex(0)
    }, HOLD_MS)
    return () => clearTimeout(t)
    // `chord` is a fresh object per analysis frame; `key` captures what matters
  }, [key])

  // The shape is fingered relative to the capo, so look up the chord `capo` semitones lower.
  const voicings = useMemo(() => {
    if (!shown) return []
    const down = (pc: number) => (pc - capo + 120) % 12
    return chordVoicings(down(shown.root), shown.suffix, shown.bass === null ? null : down(shown.bass))
  }, [shown, capo])
  const voicing = voicings[Math.min(index, voicings.length - 1)]
  const current = !!chord && key === chordKey(shown)

  const strum = () => {
    if (!engine || !voicing) return
    voicing.frets.forEach((f, s) => {
      if (f < 0) return
      const release = engine.playTone(midiToFreq(STANDARD_TUNING[s] + capo + f, a4), 'guitar', s * 0.035)
      setTimeout(release, 2500)
    })
  }

  const transposed = transpose % 12 !== 0
  const shapeName = shown && capo ? chordName({ ...shown, root: (shown.root - capo + 120) % 12, bass: shown.bass === null ? null : (shown.bass - capo + 120) % 12 }, 0, spelling) : null

  return (
    <div className={`guitar-panel ${current ? '' : 'stale'}`}>
      <div className="guitar-head">
        <span className="label">Guitar</span>
        <span className="guitar-name" title={transposed ? 'Concert pitch (guitar sounds as written, an octave lower)' : undefined}>
          {shown ? chordName(shown, 0, spelling) : '—'}
          {shapeName && <span className="muted"> ({shapeName} shape)</span>}
        </span>
        <select className="select capo" value={capo} onChange={(e) => (onCapo(+e.target.value), e.currentTarget.blur())} title="Capo">
          {Array.from({ length: 10 }, (_, i) => (
            <option key={i} value={i}>
              {i === 0 ? 'No capo' : `Capo ${i}`}
            </option>
          ))}
        </select>
      </div>
      {voicing ? (
        <button type="button" className="diagram-button" onMouseDown={(e) => e.preventDefault()} onClick={strum} title="Click to strum">
          <ChordDiagram
            voicing={voicing}
            rootPc={shown!.root}
            tuning={STANDARD_TUNING}
            capo={capo}
            noteName={(m) => pitchClassName(m, spelling)}
          />
        </button>
      ) : (
        <div className="diagram-empty">{shown ? 'No playable shape' : 'Waiting for a chord…'}</div>
      )}
      <div className="guitar-foot">
        <Btn className="small icon" disabled={voicings.length < 2} onClick={() => setIndex((i) => (i - 1 + voicings.length) % voicings.length)} title="Previous voicing">
          ‹
        </Btn>
        <span className="muted small-text">{voicings.length ? `${Math.min(index, voicings.length - 1) + 1} / ${voicings.length}` : ''}</span>
        <Btn className="small icon" disabled={voicings.length < 2} onClick={() => setIndex((i) => (i + 1) % voicings.length)} title="Next voicing">
          ›
        </Btn>
      </div>
    </div>
  )
}
