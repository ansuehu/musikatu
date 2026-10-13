import { useEffect, useRef, useState } from 'react'
import { DEFAULT_NOTE_PARAMS, type NoteParams } from '../transcription/basicPitch'
import { SOURCE_COLOR, SOURCE_LABEL, SOURCE_RANGE, type NoteSource, type NoteTrack } from '../transcription/types'
import type { TranscriptionController } from '../transcription/useTranscription'
import { STEM_NAMES } from '../stems/types'
import { noteName, type Spelling } from '../analysis/notes'
import { Btn, Slider } from './Controls'

export interface SynthPrefs {
  volume: number
  muteSource: boolean
}

interface Props {
  ctl: TranscriptionController
  tracks: NoteTrack[]
  onTracks: (fn: (t: NoteTrack[]) => NoteTrack[]) => void
  hasFile: boolean
  hasStems: boolean
  hasGrid: boolean
  synth: SynthPrefs
  onSynth: (s: SynthPrefs) => void
  showRoll: boolean
  onShowRoll: (on: boolean) => void
  selectedCount: number
  onExport: () => void
  spelling: Spelling
}

// Harmonic stems first; drums aren't pitched.
const STEM_SOURCES = STEM_NAMES.filter((n) => n !== 'drums')

export function NotesTab(p: Props) {
  const [editing, setEditing] = useState<NoteSource | null>(null)
  const sources: NoteSource[] = p.hasStems ? [...STEM_SOURCES, 'mix'] : ['mix']
  const trackOf = (s: NoteSource) => p.tracks.find((t) => t.source === s)
  const anyRunning = Object.values(p.ctl.status).some((s) => s?.kind === 'running')
  const current = editing ? trackOf(editing) : undefined
  const exportable = p.tracks.filter((t) => t.visible && t.notes.length)

  const setTrack = (source: NoteSource, patch: Partial<NoteTrack>) => p.onTracks((ts) => ts.map((t) => (t.source === source ? { ...t, ...patch } : t)))

  if (!p.ctl.available) return <div className="notes-tab"><p className="empty-hint">Note transcription runs in the desktop app.</p></div>

  return (
    <div className="notes-tab">
      <h3 className="stems-title">Audio → notes</h3>
      <p className="muted small-text">
        Turns an instrument into notes you can see, hear and export as MIDI. {p.hasStems ? 'Transcribing a single stem is much cleaner than the full mix.' : 'Separate the stems first for much cleaner notes per instrument.'}
      </p>

      <ul className="source-list">
        {sources.map((s) => {
          const t = trackOf(s)
          const st = p.ctl.status[s]
          return (
            <li key={s} className={editing === s ? 'selected' : ''}>
              <span className="swatch" style={{ background: SOURCE_COLOR(s) }} />
              <button type="button" className="source-name" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(t ? (editing === s ? null : s) : editing)} disabled={!t} title={t ? 'Detection settings' : undefined}>
                {SOURCE_LABEL(s)}
                <span className="muted small-text">
                  {st?.kind === 'running' ? ` ${Math.round(st.fraction * 100)}%` : t ? ` ${t.notes.length} notes${t.edited ? ' · edited' : ''}` : ''}
                </span>
              </button>
              {t ? (
                <>
                  <Btn className={`small icon ${t.visible ? 'on' : ''}`} onClick={() => setTrack(s, { visible: !t.visible })} title="Show in the piano roll">
                    👁
                  </Btn>
                  <Btn className={`small icon ${t.play ? 'on' : ''}`} onClick={() => setTrack(s, { play: !t.play })} title="Play these notes along with the recording">
                    ♪
                  </Btn>
                  <Btn className="small icon" onClick={() => (p.onTracks((ts) => ts.filter((x) => x.source !== s)), editing === s && setEditing(null))} title="Remove these notes">
                    ×
                  </Btn>
                </>
              ) : (
                <Btn className="small" disabled={!p.hasFile || anyRunning} onClick={() => void p.ctl.transcribe(s)}>
                  {st?.kind === 'running' ? 'Working…' : 'Transcribe'}
                </Btn>
              )}
              {st?.kind === 'error' && <span className="warning small-text source-error">{st.message}</span>}
            </li>
          )
        })}
      </ul>

      {current && editing && <DetectionSettings key={editing} track={current} spelling={p.spelling} onParams={(params) => void p.ctl.setParams(editing, params)} />}

      {p.tracks.length > 0 && (
        <>
          <div className="section-title">
            <span className="label">Listen</span>
          </div>
          <div className="metro-row">
            <span className="muted small-text">Notes</span>
            <Slider min={0} max={1.5} step={0.01} value={p.synth.volume} onChange={(e) => p.onSynth({ ...p.synth, volume: +e.target.value })} aria-label="Note playback volume" />
            <span className="value">{Math.round(p.synth.volume * 100)}%</span>
          </div>
          <label className="check small-text">
            <input type="checkbox" checked={p.synth.muteSource} onChange={(e) => p.onSynth({ ...p.synth, muteSource: e.target.checked })} />
            Hear the notes only (mute the recording)
          </label>
          {!p.tracks.some((t) => t.play) && <p className="muted small-text">Turn on ♪ for a source to hear its notes.</p>}
          <label className="check small-text">
            <input type="checkbox" checked={p.showRoll} onChange={(e) => p.onShowRoll(e.target.checked)} />
            Show the piano roll
          </label>
          {p.selectedCount > 0 && (
            <p className="notice small-text">
              {p.selectedCount} note{p.selectedCount > 1 ? 's' : ''} selected: <kbd>↑</kbd>
              <kbd>↓</kbd> move a semitone, <kbd>Del</kbd> removes, <kbd>Esc</kbd> deselects.
            </p>
          )}

          <div className="section-title">
            <span className="label">Export</span>
          </div>
          <Btn className="small" disabled={exportable.length === 0} onClick={p.onExport}>
            Export MIDI ({exportable.length} track{exportable.length === 1 ? '' : 's'})…
          </Btn>
          <p className="muted small-text">
            {p.hasGrid
              ? 'The MIDI file follows the beat grid: one beat per quarter note with the song’s own tempo changes, so bars line up in MuseScore, Guitar Pro or a DAW and the notes stay in sync with the audio.'
              : 'No beat grid yet, so the MIDI file uses a fixed 120 BPM (timing is still exact in seconds).'}
          </p>
        </>
      )}
      <p className="muted small-text">Basic Pitch (Spotify) · Apache-2.0 · runs on this computer</p>
    </div>
  )
}

function DetectionSettings({ track, onParams, spelling }: { track: NoteTrack; onParams: (p: NoteParams) => void; spelling: Spelling }) {
  const [draft, setDraft] = useState(track.params)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  // Re-apply shortly after the user stops dragging.
  const set = (patch: Partial<NoteParams>) => {
    const next = { ...draft, ...patch }
    setDraft(next)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => onParams(next), 250)
  }
  const [defLo, defHi] = SOURCE_RANGE[track.source]
  // lower thresholds find more notes; present them as "sensitivity" so right = more
  const sens = (thr: number, lo: number, hi: number) => Math.round(((hi - thr) / (hi - lo)) * 100)
  return (
    <div className="metro-details detection">
      <div className="click-sound-head">
        <span className="click-title">Detection · {SOURCE_LABEL(track.source)}</span>
        <Btn className="small" onClick={() => (setDraft({ ...DEFAULT_NOTE_PARAMS, minMidi: defLo, maxMidi: defHi }), onParams({ ...DEFAULT_NOTE_PARAMS, minMidi: defLo, maxMidi: defHi }))}>
          Defaults
        </Btn>
      </div>
      <label className="metro-field" title="How readily a new note is started (onset threshold)">
        <span className="muted small-text">New notes</span>
        <Slider min={0.2} max={0.8} step={0.01} value={1 - draft.onsetThreshold} onChange={(e) => set({ onsetThreshold: 1 - +e.target.value })} />
        <span className="value">{sens(draft.onsetThreshold, 0.2, 0.8)}%</span>
      </label>
      <label className="metro-field" title="How quiet a note may get before it ends (frame threshold)">
        <span className="muted small-text">Sustain</span>
        <Slider min={0.4} max={0.9} step={0.01} value={1 - draft.frameThreshold} onChange={(e) => set({ frameThreshold: 1 - +e.target.value })} />
        <span className="value">{sens(draft.frameThreshold, 0.1, 0.6)}%</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Shortest</span>
        <Slider min={30} max={400} step={5} value={draft.minNoteMs} onChange={(e) => set({ minNoteMs: +e.target.value })} />
        <span className="value">{Math.round(draft.minNoteMs)} ms</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Lowest</span>
        <Slider min={21} max={108} step={1} value={draft.minMidi} onChange={(e) => set({ minMidi: Math.min(+e.target.value, draft.maxMidi - 1) })} />
        <span className="value">{noteName(draft.minMidi, 0, spelling)}</span>
      </label>
      <label className="metro-field">
        <span className="muted small-text">Highest</span>
        <Slider min={21} max={108} step={1} value={draft.maxMidi} onChange={(e) => set({ maxMidi: Math.max(+e.target.value, draft.minMidi + 1) })} />
        <span className="value">{noteName(draft.maxMidi, 0, spelling)}</span>
      </label>
      {track.edited && <p className="muted small-text">Changing these re-detects the notes and discards your edits.</p>}
    </div>
  )
}
