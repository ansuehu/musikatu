import { Btn, Slider } from './Controls'
import { FolderIcon, VolumeIcon } from './Icons'
import { formatTime } from '../waveform/draw'
import { TRANSPOSITIONS, type Spelling } from '../analysis/notes'

const NEXT_SPELLING: Record<Spelling, Spelling> = { auto: 'sharps', sharps: 'flats', flats: 'auto' }
const SPELLING_LABEL: Record<Spelling, string> = { auto: 'Auto', sharps: '♯', flats: '♭' }

interface Props {
  fileName: string | null
  info: { sampleRate: number; channels: number; duration: number } | null
  volume: number
  onVolume: (v: number) => void
  onOpen: () => void
  onZoom: (factor: number) => void
  onFit: () => void
  follow: boolean
  onFollow: (on: boolean) => void
  transposition: string
  onTransposition: (id: string) => void
  spelling: Spelling
  onSpelling: (s: Spelling) => void
  onShortcuts: () => void
  sidebarOpen: boolean
  onSidebar: (open: boolean) => void
  disabled: boolean
}

export function TopBar(p: Props) {
  return (
    <header className="topbar">
      <div className="brand">Earwork <span className="brand-ai">AI</span></div>
      <Btn onClick={p.onOpen} title="Open audio file (Ctrl+O)">
        <FolderIcon /> Open
      </Btn>
      <div className="file-info">
        {p.fileName ? (
          <>
            <span className="file-name">{p.fileName}</span>
            {p.info && (
              <span className="file-meta">
                {formatTime(p.info.duration, 1)} · {(p.info.sampleRate / 1000).toFixed(1)} kHz ·{' '}
                {p.info.channels === 1 ? 'mono' : p.info.channels === 2 ? 'stereo' : `${p.info.channels} ch`}
              </span>
            )}
          </>
        ) : (
          <span className="file-meta">No file loaded — drop an audio file anywhere</span>
        )}
      </div>
      <label className="inline-field" title="Show note names as written for a transposing instrument">
        <span className="muted">Notes for</span>
        <select className="select" value={p.transposition} onChange={(e) => (p.onTransposition(e.target.value), e.currentTarget.blur())}>
          {TRANSPOSITIONS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <Btn
          className="small spelling"
          onClick={() => p.onSpelling(NEXT_SPELLING[p.spelling])}
          title="Accidentals: Auto (B♭, E♭, F♯ as on lead sheets), all sharps, or all flats"
        >
          {SPELLING_LABEL[p.spelling]}
        </Btn>
      </label>
      <div className="group" aria-label="Zoom">
        <Btn onClick={() => p.onZoom(1 / 1.6)} disabled={p.disabled} title="Zoom in">
          +
        </Btn>
        <Btn onClick={() => p.onZoom(1.6)} disabled={p.disabled} title="Zoom out">
          −
        </Btn>
        <Btn onClick={p.onFit} disabled={p.disabled} title="Fit whole file">
          Fit
        </Btn>
        <Btn className={p.follow ? 'on' : ''} onClick={() => p.onFollow(!p.follow)} title="Scroll the view to follow the playhead" aria-pressed={p.follow}>
          Follow
        </Btn>
      </div>
      <label className="volume" title="Master volume">
        <VolumeIcon />
        <Slider min={0} max={1.5} step={0.01} value={p.volume} onChange={(e) => p.onVolume(+e.target.value)} />
        <span className="value">{Math.round(p.volume * 100)}%</span>
      </label>
      <Btn onClick={p.onShortcuts} title="Keyboard, global hotkey and MIDI pedal shortcuts (Ctrl+,)">
        ⌨
      </Btn>
      <Btn className={p.sidebarOpen ? 'on' : ''} onClick={() => p.onSidebar(!p.sidebarOpen)} title="Show / hide the side panel">
        ☰
      </Btn>
    </header>
  )
}
