import { useEffect, useMemo, useRef, useState } from 'react'
import { VOCABULARIES, segmentAt, type Chord, type Vocabulary } from '../analysis/chordTimeline'
import type { ChordSource, ChordStatus, ChordTrack } from '../analysis/useChordTrack'
import { STANDARD_TUNING, chordVoicings } from '../analysis/guitar'
import { midiToFreq, pitchClassName, type Spelling } from '../analysis/notes'
import type { AudioEngine } from '../audio/AudioEngine'
import { formatTime } from '../waveform/draw'
import { ChordDiagram } from './ChordDiagram'
import { Btn } from './Controls'
import { positionInfo, type BeatGrid } from '../rhythm/grid'
import { chordSheetByBars } from '../rhythm/sheet'

interface Props {
  track: ChordTrack | null
  status: ChordStatus
  hasFile: boolean
  hasStems: boolean
  sampleRate: number
  fileName: string | null
  getPosition: () => number
  /** Display name of a stored chord (applies transposition, pitch shift, spelling). */
  label: (c: Chord) => string
  /** Parses a typed display name back into a stored chord; undefined if invalid. */
  parse: (text: string) => Chord | null | undefined
  /** Semitones the playback is pitch-shifted, for the diagrams' sounding pitch. */
  pitchShift: number
  spelling: Spelling
  capo: number
  a4: number
  engine: AudioEngine | null
  onRun: (source: ChordSource, vocabulary: Vocabulary) => void
  onEdit: (index: number, chord: Chord | null) => void
  onDelete: (index: number) => void
  onSplit: () => void
  onSeek: (index: number) => void
  onLoop: (index: number) => void
  grid: BeatGrid | null
  songLength: number
}

export function ChordsTab(p: Props) {
  const [current, setCurrent] = useState(-1)
  const listRef = useRef<HTMLUListElement>(null)
  const segments = p.track?.segments ?? []

  // Follow the playhead (5×/s is plenty for a list).
  useEffect(() => {
    const id = setInterval(() => setCurrent(segmentAt(segments, p.getPosition())), 200)
    return () => clearInterval(id)
  }, [segments, p.getPosition])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${current}"]`)
    if (el && document.activeElement?.tagName !== 'INPUT') el.scrollIntoView({ block: 'nearest' })
  }, [current])

  // Every distinct chord, in order of first appearance, with its total duration.
  const used = useMemo(() => {
    const m = new Map<string, { chord: Chord; seconds: number }>()
    for (const s of segments) {
      if (!s.chord) continue
      const k = p.label(s.chord)
      const e = m.get(k) ?? { chord: s.chord, seconds: 0 }
      e.seconds += (s.end - s.start) / p.sampleRate
      m.set(k, e)
    }
    return [...m.entries()].map(([name, v]) => ({ name, ...v }))
  }, [segments, p.label, p.sampleRate])

  const strum = (c: Chord) => {
    const root = (c.root + p.pitchShift + 120) % 12
    const v = chordVoicings((root - p.capo + 120) % 12, c.suffix, c.bass === null ? null : (c.bass + p.pitchShift - p.capo + 120) % 12)[0]
    if (!v || !p.engine) return
    v.frets.forEach((f, s) => {
      if (f < 0) return
      const release = p.engine!.playTone(midiToFreq(STANDARD_TUNING[s] + p.capo + f, p.a4), 'guitar', s * 0.035)
      setTimeout(release, 2500)
    })
  }

  const sheet = () => {
    const lines = [`${p.fileName ?? 'Song'} — chord chart (Musikatu)`, '']
    lines.push(
      segments
        .filter((s) => s.chord)
        .map((s) => p.label(s.chord!))
        .join(' | ')
        .replace(/^/, '| ')
        .concat(' |'),
    )
    if (p.grid) lines.push('', 'By bar:', chordSheetByBars(segments, p.grid, p.songLength, p.label))
    lines.push('', 'Timeline:')
    for (const s of segments) lines.push(`${formatTime(s.start / p.sampleRate, 0.1).padStart(7)}  ${s.chord ? p.label(s.chord) : 'N.C.'}`)
    return lines.join('\n') + '\n'
  }

  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  const running = p.status.kind === 'running'
  const vocab = p.track?.vocabulary ?? 'standard'
  const source: ChordSource = p.track?.source ?? (p.hasStems ? 'instruments' : 'mix')

  return (
    <div className="chords-tab">
      <div className="chords-settings">
        <label className="field">
          <span className="label">Listen to</span>
          <select className="select" value={source} disabled={running || !p.hasFile} onChange={(e) => p.onRun(e.target.value as ChordSource, vocab)}>
            <option value="mix">Full mix</option>
            <option value="instruments" disabled={!p.hasStems}>
              Instruments only (no vocals/drums){p.hasStems ? '' : ' — separate stems first'}
            </option>
          </select>
        </label>
        <label className="field">
          <span className="label">Chords</span>
          <select className="select" value={vocab} disabled={running || !p.hasFile} onChange={(e) => p.onRun(source, e.target.value as Vocabulary)}>
            {VOCABULARIES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {p.track?.edited && !running && <p className="muted small-text">You've edited this chart; changing the settings above re-analyses it and discards your edits.</p>}

      {running && (
        <div className="progress-block">
          <div className="progress">
            <div style={{ width: `${(p.status as { fraction: number }).fraction * 100}%` }} />
          </div>
          <span className="muted small-text">Analysing chords…</span>
        </div>
      )}
      {p.status.kind === 'error' && <p className="warning">{p.status.message}</p>}
      {!p.hasFile && <p className="empty-hint">Open a song and its chords are charted automatically.</p>}

      {used.length > 0 && (
        <>
          <div className="section-title">
            <span className="label">Chords in this song</span>
            <span className="muted small-text">{p.capo ? `capo ${p.capo} · ` : ''}click to hear</span>
          </div>
          <div className="diagram-grid">
            {used.map((u) => {
              const root = (u.chord.root + p.pitchShift + 120) % 12
              const shapeRoot = (root - p.capo + 120) % 12
              const bass = u.chord.bass === null ? null : (u.chord.bass + p.pitchShift - p.capo + 120) % 12
              const v = chordVoicings(shapeRoot, u.chord.suffix, bass)[0]
              return (
                <button type="button" key={u.name} className="diagram-card" onMouseDown={(e) => e.preventDefault()} onClick={() => strum(u.chord)} title={`${u.name} · ${u.seconds.toFixed(0)} s in total`}>
                  <span className="diagram-name">{u.name}</span>
                  {v ? (
                    <ChordDiagram voicing={v} rootPc={root} tuning={STANDARD_TUNING} capo={p.capo} noteName={(m) => pitchClassName(m, p.spelling)} />
                  ) : (
                    <span className="muted small-text no-shape">no shape</span>
                  )}
                </button>
              )
            })}
          </div>
        </>
      )}

      {segments.length > 0 && (
        <>
          <div className="section-title">
            <span className="label">Progression</span>
            <div className="button-row">
              <Btn className="small" onClick={p.onSplit} title="Split the chord under the playhead in two, to insert a change (then rename one half)">
                Split at playhead
              </Btn>
            </div>
          </div>
          <ul className="list chord-list" ref={listRef}>
            {segments.map((s, i) => (
              <li key={`${s.start}-${i}`} data-index={i} className={i === current ? 'selected' : ''}>
                <button type="button" className="time link" onMouseDown={(e) => e.preventDefault()} onClick={() => p.onSeek(i)}>
                  {formatTime(s.start / p.sampleRate, 0.1)}
                </button>
                {p.grid && <span className="bar-pos muted small-text">{barLabel(p.grid, s.start)}</span>}
                <ChordInput value={s.chord ? p.label(s.chord) : 'N.C.'} parse={p.parse} onCommit={(c) => p.onEdit(i, c)} />
                <span className="muted small-text dur">{((s.end - s.start) / p.sampleRate).toFixed(1)} s</span>
                <Btn className="small icon" onClick={() => p.onLoop(i)} title="Select and loop this chord">
                  ⟲
                </Btn>
                <Btn className="small icon" onClick={() => p.onDelete(i)} title="Remove (merge into the previous chord)">
                  ×
                </Btn>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <Btn
              className="small"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(sheet())
                  setCopied('ok')
                } catch {
                  setCopied('failed')
                }
                setTimeout(() => setCopied(null), 1800)
              }}
            >
              {copied === 'ok' ? 'Copied ✓' : copied === 'failed' ? 'Copy failed: use Save' : 'Copy chord sheet'}
            </Btn>
            <Btn
              className="small"
              onClick={() => {
                const a = document.createElement('a')
                a.href = URL.createObjectURL(new Blob([sheet()], { type: 'text/plain' }))
                a.download = `${(p.fileName ?? 'song').replace(/\.[^.]+$/, '')} - chords.txt`
                a.click()
                setTimeout(() => URL.revokeObjectURL(a.href), 1000)
              }}
            >
              Save as text…
            </Btn>
          </div>
          <p className="muted small-text">
            Type over a chord to correct it (e.g. <i>Am7</i>, <i>F#m7b5</i>, <i>Bb/D</i>, <i>N.C.</i>). Click a chord in the lane above the waveform to jump to
            it, double-click to select it.
          </p>
        </>
      )}
    </div>
  )
}

/** Chord name field: commits on Enter/blur, reverts (with a red flash) on something that isn't a chord. */
function ChordInput({ value, parse, onCommit }: { value: string; parse: Props['parse']; onCommit: (c: Chord | null) => void }) {
  const [draft, setDraft] = useState(value)
  const [bad, setBad] = useState(false)
  useEffect(() => setDraft(value), [value])
  return (
    <input
      className={`name-input chord-input ${bad ? 'bad' : ''}`}
      value={draft}
      spellCheck={false}
      onChange={(e) => {
        setDraft(e.target.value)
        setBad(false)
      }}
      onBlur={(e) => {
        const text = e.currentTarget.value.trim()
        if (!text || text === value) return setDraft(value)
        const c = parse(text)
        if (c === undefined) {
          setBad(true)
          setTimeout(() => {
            setBad(false)
            setDraft(value)
          }, 900)
          return
        }
        onCommit(c)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
          setDraft(value)
          requestAnimationFrame(() => e.currentTarget?.blur())
        }
      }}
    />
  )
}

function barLabel(grid: BeatGrid, pos: number): string {
  const info = positionInfo(grid, pos + 1)
  return info.index < 0 ? '' : `${info.bar}.${info.beat}`
}
