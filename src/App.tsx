import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type Timbre } from './audio/AudioEngine'
import { FLAT_EQ, type EqState } from './audio/eq'
import { TRANSPOSITIONS, type Spelling } from './analysis/notes'
import type { ChannelMode } from './dsp/ChannelMixer'
import { buildPeaks, type Peaks } from './waveform/peaks'
import { WaveformView } from './components/WaveformView'
import { Overview } from './components/Overview'
import { TopBar } from './components/TopBar'
import { MAX_SPEED, MIN_SPEED, Transport } from './components/Transport'
import { AnalysisPanel } from './components/AnalysisPanel'
import { Sidebar, type SidebarTab } from './components/Sidebar'
import { ShortcutsDialog, type Capture } from './components/ShortcutsDialog'
import { Btn } from './components/Controls'
import { loadProject, projectKey, saveProject, uid, type Marker, type MarkerKind, type ProjectData, type SavedLoop } from './project'
import { comboFromEvent, loadBindings, loadGlobalEnabled, saveBindings, saveGlobalEnabled, toAccelerator, type Bindings } from './shortcuts'
import { useMidi } from './midi'
import type { AudioFilePayload, Selection, View } from './types'

interface LoadedFile {
  name: string
  buffer: AudioBuffer
  peaks: Peaks
}

type Status = { kind: 'loading' | 'error' | 'info'; text: string } | null

const MIN_SPP = 1 / 50 // max zoom: 50 CSS px per sample
const ANALYSIS_SIZE = 16384 // must match AnalysisPanel's analyser

interface Prefs {
  transposition: string
  spelling: Spelling
  a4: number
  timbre: Timbre
  sidebarTab: SidebarTab
  sidebarOpen: boolean
  follow: boolean
  volume: number
  showGuitar: boolean
  capo: number
}

const DEFAULT_PREFS: Prefs = {
  transposition: 'C',
  spelling: 'auto',
  a4: 440,
  timbre: 'piano',
  sidebarTab: 'markers',
  sidebarOpen: true,
  follow: true,
  volume: 0.8,
  showGuitar: true,
  capo: 0,
}

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem('earwork.prefs.v1') ?? '{}') as Partial<Prefs>) }
  } catch {
    return DEFAULT_PREFS
  }
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export default function App() {
  const initialPrefs = useMemo(loadPrefs, [])
  const [engine, setEngine] = useState<AudioEngine | null>(null)
  const [file, setFile] = useState<LoadedFile | null>(null)
  const [status, setStatus] = useState<Status>(null)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [semitones, setSemitones] = useState(0)
  const [cents, setCents] = useState(0)
  const [volume, setVolume] = useState(initialPrefs.volume)
  const [view, setViewRaw] = useState<View>({ start: 0, spp: Number.MAX_VALUE })
  const [detailWidth, setDetailWidth] = useState(0)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [loopOn, setLoopOn] = useState(false)
  const [follow, setFollow] = useState(initialPrefs.follow)
  const [dragOver, setDragOver] = useState(false)
  // project data
  const [projectId, setProjectId] = useState<string | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [loops, setLoops] = useState<SavedLoop[]>([])
  const [eq, setEq] = useState<EqState>(FLAT_EQ)
  const [channelMode, setChannelMode] = useState<ChannelMode>('stereo')
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null)
  const [editMarkerRequest, setEditMarkerRequest] = useState<{ id: string; n: number } | null>(null)
  const [activeLoop, setActiveLoop] = useState<string | null>(null)
  const [tempo, setTempo] = useState<{ tapped: number; original: number } | null>(null)
  // display prefs
  const [transposition, setTransposition] = useState(initialPrefs.transposition)
  const [spelling, setSpelling] = useState(initialPrefs.spelling)
  const [a4, setA4] = useState(initialPrefs.a4)
  const [timbre, setTimbre] = useState<Timbre>(initialPrefs.timbre)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>(initialPrefs.sidebarTab)
  const [sidebarOpen, setSidebarOpen] = useState(initialPrefs.sidebarOpen)
  const [showGuitar, setShowGuitar] = useState(initialPrefs.showGuitar)
  const [capo, setCapo] = useState(initialPrefs.capo)
  // shortcuts
  const [bindings, setBindingsRaw] = useState<Bindings>(loadBindings)
  const [globalEnabled, setGlobalEnabledRaw] = useState(loadGlobalEnabled)
  const [globalFailures, setGlobalFailures] = useState<string[]>([])
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [capture, setCapture] = useState<Capture>(null)

  const fileInput = useRef<HTMLInputElement>(null)
  const taps = useRef<number[]>([])
  const speedBeforeHalf = useRef(1)

  const length = file?.buffer.length ?? 0
  const sampleRate = file?.buffer.sampleRate ?? engine?.sampleRate ?? 44100
  const pitchRatio = 2 ** ((semitones + cents / 100) / 12)
  const transpose = TRANSPOSITIONS.find((t) => t.id === transposition)?.semitones ?? 0

  // ---- audio engine lifecycle ----
  useEffect(() => {
    let cancelled = false
    let created: AudioEngine | null = null
    AudioEngine.create()
      .then((e) => {
        if (cancelled) return e.dispose()
        created = e
        setEngine(e)
      })
      .catch((err: unknown) => setStatus({ kind: 'error', text: `Audio engine failed to start: ${String(err)}` }))
    return () => {
      cancelled = true
      created?.dispose()
    }
  }, [])

  useEffect(() => engine?.subscribe((e) => setPlaying(e.playing)), [engine])
  useEffect(() => engine?.setSpeed(speed), [engine, speed])
  useEffect(() => engine?.setPitch(semitones, cents), [engine, semitones, cents])
  useEffect(() => engine?.setVolume(volume), [engine, volume])
  useEffect(() => engine?.setEq(eq), [engine, eq])
  useEffect(() => engine?.setChannelMode(channelMode), [engine, channelMode])
  useEffect(() => {
    if (!engine || !length) return
    const region = selection ?? { start: 0, end: length }
    engine.setLoop(loopOn, region.start, region.end)
  }, [engine, loopOn, selection, length])

  const getPosition = useCallback(() => engine?.position ?? 0, [engine])

  // ---- persistence ----
  useEffect(() => {
    const prefs: Prefs = { transposition, spelling, a4, timbre, sidebarTab, sidebarOpen, follow, volume, showGuitar, capo }
    try {
      localStorage.setItem('earwork.prefs.v1', JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [transposition, spelling, a4, timbre, sidebarTab, sidebarOpen, follow, volume, showGuitar, capo])

  useEffect(() => {
    if (!projectId) return
    const data: ProjectData = { version: 1, markers, loops, eq, channelMode, speed, semitones, cents }
    const t = setTimeout(() => void saveProject(projectId, data), 400)
    return () => clearTimeout(t)
  }, [projectId, markers, loops, eq, channelMode, speed, semitones, cents])

  // ---- view (zoom / scroll) ----
  const clampView = useCallback(
    (v: View): View => {
      if (!length || !detailWidth) return v
      const spp = clamp(v.spp, MIN_SPP, Math.max(MIN_SPP, length / detailWidth))
      return { spp, start: clamp(v.start, 0, Math.max(0, length - detailWidth * spp)) }
    },
    [length, detailWidth],
  )
  const setView = useCallback((v: View) => setViewRaw(clampView(v)), [clampView])
  useEffect(() => setViewRaw((v) => clampView(v)), [clampView])

  const zoom = useCallback(
    (factor: number) => {
      const span = detailWidth * view.spp
      const pos = getPosition()
      const anchor = pos >= view.start && pos <= view.start + span ? pos : view.start + span / 2
      const x = (anchor - view.start) / view.spp
      const spp = view.spp * factor
      setView({ start: anchor - x * spp, spp })
    },
    [detailWidth, view, getPosition, setView],
  )
  const fit = useCallback(() => setView({ start: 0, spp: Number.MAX_VALUE }), [setView])

  // ---- file loading ----
  const loadFile = useCallback(
    async (name: string, data: ArrayBuffer, path: string | null) => {
      if (!engine) return
      engine.pause()
      setStatus({ kind: 'loading', text: `Decoding ${name}…` })
      try {
        const buffer = await engine.decode(data)
        const peaks = buildPeaks(buffer)
        const key = projectKey(name, path, buffer.length)
        const saved = await loadProject(key)
        engine.load(buffer)
        setFile({ name, buffer, peaks })
        setSelection(null)
        setLoopOn(false)
        setSelectedMarker(null)
        setActiveLoop(null)
        setTempo(null)
        setViewRaw({ start: 0, spp: Number.MAX_VALUE })
        setMarkers(saved?.markers ?? [])
        setLoops(saved?.loops ?? [])
        setEq(saved?.eq ?? FLAT_EQ)
        setChannelMode(saved?.channelMode ?? 'stereo')
        setSpeed(saved?.speed ?? 1)
        setSemitones(saved?.semitones ?? 0)
        setCents(saved?.cents ?? 0)
        setProjectId(key)
        const restored = (saved?.markers?.length ?? 0) + (saved?.loops?.length ?? 0)
        setStatus(restored ? { kind: 'info', text: `Restored ${saved?.markers?.length ?? 0} markers and ${saved?.loops?.length ?? 0} loops` } : null)
        document.title = `${name} — Earwork`
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        setStatus({ kind: 'error', text: `Couldn't decode “${name}”. ${detail}` })
      }
    },
    [engine],
  )

  useEffect(() => {
    if (status?.kind !== 'info') return
    const t = setTimeout(() => setStatus(null), 3000)
    return () => clearTimeout(t)
  }, [status])

  const loadPayload = useCallback(
    (p: AudioFilePayload | null) => {
      if (p) void loadFile(p.name, toArrayBuffer(p.data), p.path)
    },
    [loadFile],
  )

  const loadDomFile = useCallback(
    async (f: File) => void loadFile(f.name, await f.arrayBuffer(), window.api?.pathForFile(f) ?? null),
    [loadFile],
  )

  const openFile = useCallback(async () => {
    if (window.api) loadPayload(await window.api.openFile())
    else fileInput.current?.click()
  }, [loadPayload])

  useEffect(() => {
    const api = window.api
    if (!engine || !api) return
    void api.initialFile().then(loadPayload)
    const offMenu = api.onMenu((cmd) => (cmd === 'open' ? void openFile() : setShortcutsOpen(true)))
    const offFile = api.onFileOpened(loadPayload)
    return () => {
      offMenu()
      offFile()
    }
  }, [engine, loadPayload, openFile])

  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDragOver(true)
    }
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragOver(false)
    }
    const drop = (e: DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      const f = e.dataTransfer?.files[0]
      if (f) void loadDomFile(f)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [loadDomFile])

  // ---- transport ----
  const region = selection ?? (length ? { start: 0, end: length } : null)

  const togglePlay = useCallback(() => {
    if (!engine || !length) return
    if (engine.isPlaying) return engine.pause()
    if (!loopOn && engine.position >= length - 1) engine.seek(0)
    engine.play()
  }, [engine, length, loopOn])

  const seek = useCallback((s: number) => engine?.seek(s), [engine])
  const jump = useCallback((seconds: number) => engine?.seek(engine.position + seconds * sampleRate), [engine, sampleRate])
  const toStart = useCallback(() => engine?.seek(loopOn && region ? region.start : 0), [engine, loopOn, region])
  const stop = useCallback(() => {
    engine?.pause()
    engine?.seek(selection ? selection.start : 0)
  }, [engine, selection])

  const toggleLoop = useCallback(() => {
    if (!engine || !region) return
    const next = !loopOn
    const pos = engine.position
    if (next && (pos < region.start || pos >= region.end)) engine.seek(region.start)
    setLoopOn(next)
  }, [engine, region, loopOn])

  const onSelect = useCallback(
    (sel: Selection, final: boolean) => {
      setSelection(sel)
      setActiveLoop(null)
      if (final) engine?.seek(sel.start)
    },
    [engine],
  )

  const changeSpeed = useCallback((s: number) => setSpeed(clamp(Math.round(s * 100) / 100, MIN_SPEED, MAX_SPEED)), [])

  // ---- markers ----
  const addMarker = useCallback(
    (kind: MarkerKind) => {
      if (!engine || !length) return
      const pos = Math.round(engine.position)
      const tooClose = markers.some((m) => m.kind === kind && Math.abs(m.pos - pos) < sampleRate * 0.03)
      if (tooClose) return
      const sections = markers.filter((m) => m.kind === 'section').length
      const marker: Marker = { id: uid(), kind, pos, name: kind === 'section' ? `Section ${sections + 1}` : '' }
      setMarkers((ms) => [...ms, marker])
      setSelectedMarker(marker.id)
      // Naming a section steals the keyboard, so only offer it when stopped.
      if (kind === 'section' && !engine.isPlaying) {
        setSidebarOpen(true)
        setSidebarTab('markers')
        setEditMarkerRequest({ id: marker.id, n: Date.now() })
      }
    },
    [engine, length, markers, sampleRate],
  )

  const deleteMarker = useCallback((id: string | null) => {
    if (!id) return
    setMarkers((ms) => ms.filter((m) => m.id !== id))
    setSelectedMarker((s) => (s === id ? null : s))
  }, [])

  const jumpMarker = useCallback(
    (dir: -1 | 1) => {
      if (!engine) return
      const pos = engine.position
      // While playing, give a little slack so repeated "previous" presses keep stepping back.
      const slack = engine.isPlaying ? sampleRate * 0.4 : 1
      const sorted = markers.map((m) => m.pos).sort((a, b) => a - b)
      const target = dir < 0 ? [...sorted].reverse().find((p) => p < pos - slack) : sorted.find((p) => p > pos + 1)
      engine.seek(target ?? (dir < 0 ? 0 : pos))
    },
    [engine, markers, sampleRate],
  )

  const selectBetweenMarkers = useCallback(
    (sample: number) => {
      if (!length) return
      const sorted = markers.map((m) => m.pos).sort((a, b) => a - b)
      const start = [...sorted].reverse().find((p) => p <= sample) ?? 0
      const end = sorted.find((p) => p > sample) ?? length
      onSelect({ start, end }, true)
    },
    [markers, length, onSelect],
  )

  const tap = useCallback(() => {
    const now = performance.now()
    const t = taps.current
    if (t.length && now - t[t.length - 1] > 2000) t.length = 0
    t.push(now)
    if (t.length > 9) t.shift()
    if (t.length >= 3) {
      const tapped = (60000 * (t.length - 1)) / (t[t.length - 1] - t[0])
      setTempo({ tapped, original: tapped / speed })
    }
  }, [speed])

  // ---- loops ----
  const saveLoop = useCallback(() => {
    if (!selection) return
    const loop: SavedLoop = { id: uid(), name: `Loop ${loops.length + 1}`, ...selection }
    setLoops((ls) => [...ls, loop])
    setActiveLoop(loop.id)
    setStatus({ kind: 'info', text: loops.length < 9 ? `Saved “${loop.name}” — press ${loops.length + 1} to recall` : `Saved “${loop.name}”` })
  }, [selection, loops.length])

  const recallLoop = useCallback(
    (id: string) => {
      const l = loops.find((x) => x.id === id)
      if (!l || !engine) return
      setSelection({ start: l.start, end: l.end })
      setActiveLoop(l.id)
      setLoopOn(true)
      engine.seek(l.start)
      const span = detailWidth * view.spp
      if (l.start < view.start || l.end > view.start + span) setView({ start: l.start - span * 0.05, spp: view.spp })
    },
    [loops, engine, detailWidth, view, setView],
  )

  // ---- spectrum weighting by the EQ ----
  const eqWeights = useMemo(() => {
    const active = eq.enabled && (eq.gains.some((g) => g !== 0) || eq.highpass.on || eq.lowpass.on)
    if (!engine || !active) return null
    const freqs = new Float32Array(ANALYSIS_SIZE / 2)
    for (let k = 0; k < freqs.length; k++) freqs[k] = ((k * engine.sampleRate) / ANALYSIS_SIZE) * pitchRatio
    return engine.eqResponse(eq, freqs)
  }, [engine, eq, pitchRatio])

  // ---- actions (shared by keys, global hotkeys and MIDI) ----
  const runAction = useCallback(
    (id: string) => {
      const recall = /^recallLoop(\d)$/.exec(id)
      if (recall) {
        const l = loops[+recall[1] - 1]
        if (l) recallLoop(l.id)
        return
      }
      switch (id) {
        case 'playPause': return togglePlay()
        case 'stop': return stop()
        case 'back1': return jump(-1)
        case 'fwd1': return jump(1)
        case 'back5': return jump(-5)
        case 'fwd5': return jump(5)
        case 'toStart': return toStart()
        case 'prevMarker': return jumpMarker(-1)
        case 'nextMarker': return jumpMarker(1)
        case 'loop': return toggleLoop()
        case 'saveLoop': return saveLoop()
        case 'clearSelection':
          setSelection(null)
          setActiveLoop(null)
          return
        case 'halfSpeed':
          if (speed !== 0.5) {
            speedBeforeHalf.current = speed
            setSpeed(0.5)
          } else setSpeed(speedBeforeHalf.current === 0.5 ? 1 : speedBeforeHalf.current)
          return
        case 'speedDown': return changeSpeed(speed - 0.05)
        case 'speedUp': return changeSpeed(speed + 0.05)
        case 'pitchDown': return setSemitones((s) => Math.max(-12, s - 1))
        case 'pitchUp': return setSemitones((s) => Math.min(12, s + 1))
        case 'tapTempo': return tap()
        case 'addSection': return addMarker('section')
        case 'addMeasure': return addMarker('measure')
        case 'addBeat': return addMarker('beat')
        case 'deleteMarker': return deleteMarker(selectedMarker)
        case 'zoomIn': return zoom(1 / 1.6)
        case 'zoomOut': return zoom(1.6)
        case 'zoomFit': return fit()
        case 'follow': return setFollow((f) => !f)
      }
    },
    [loops, recallLoop, togglePlay, stop, jump, toStart, jumpMarker, toggleLoop, saveLoop, speed, changeSpeed, tap, addMarker, deleteMarker, selectedMarker, zoom, fit],
  )
  const runActionRef = useRef(runAction)
  runActionRef.current = runAction

  const keyMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const [id, b] of Object.entries(bindings)) if (b.key) m.set(b.key, id)
    return m
  }, [bindings])
  const keyState = useRef({ keyMap, shortcutsOpen })
  keyState.current = { keyMap, shortcutsOpen }

  useEffect(() => {
    const REPEATABLE = new Set(['back1', 'fwd1', 'back5', 'fwd5', 'speedDown', 'speedUp', 'zoomIn', 'zoomOut', 'prevMarker', 'nextMarker'])
    const onKey = (e: KeyboardEvent) => {
      const { keyMap, shortcutsOpen } = keyState.current
      if (shortcutsOpen) return
      const t = e.target as HTMLElement
      if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio'].includes((t as HTMLInputElement).type)) return
      const combo = comboFromEvent(e)
      const id = combo && keyMap.get(combo)
      if (!id) return
      e.preventDefault()
      if (e.repeat && !REPEATABLE.has(id)) return
      runActionRef.current(id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- global hotkeys ----
  useEffect(() => {
    const api = window.api
    if (!api) return
    const list = globalEnabled
      ? Object.entries(bindings).flatMap(([action, b]) => (b.global ? [{ accelerator: toAccelerator(b.global), action }] : []))
      : []
    void api.setGlobalShortcuts(list).then(setGlobalFailures)
  }, [bindings, globalEnabled])
  useEffect(() => window.api?.onGlobalShortcut((action) => runActionRef.current(action)), [])

  // ---- MIDI pedals / pads ----
  const captureRef = useRef(capture)
  captureRef.current = capture
  const bindingsRef = useRef(bindings)
  bindingsRef.current = bindings
  const setBindings = useCallback((b: Bindings) => {
    setBindingsRaw(b)
    saveBindings(b)
  }, [])
  const midi = useMidi((binding) => {
    const c = captureRef.current
    const b = bindingsRef.current
    if (c?.field === 'midi') {
      const next: Bindings = {}
      for (const [id, v] of Object.entries(b)) next[id] = v.midi === binding ? { ...v, midi: null } : v
      next[c.id] = { ...next[c.id], midi: binding }
      setBindings(next)
      setCapture(null)
      return
    }
    const action = Object.entries(b).find(([, v]) => v.midi === binding)?.[0]
    if (action) runActionRef.current(action)
  })

  const disabled = !engine || !file

  return (
    <div className="app">
      <TopBar
        fileName={file?.name ?? null}
        info={file ? { sampleRate: file.buffer.sampleRate, channels: file.buffer.numberOfChannels, duration: file.buffer.duration } : null}
        volume={volume}
        onVolume={setVolume}
        onOpen={() => void openFile()}
        onZoom={zoom}
        onFit={fit}
        follow={follow}
        onFollow={setFollow}
        transposition={transposition}
        onTransposition={setTransposition}
        spelling={spelling}
        onSpelling={setSpelling}
        onShortcuts={() => setShortcutsOpen(true)}
        sidebarOpen={sidebarOpen}
        onSidebar={setSidebarOpen}
        disabled={disabled}
      />

      <div className={`body ${sidebarOpen ? 'with-sidebar' : ''}`}>
        <main className="workspace">
          {file ? (
            <>
              <Overview
                peaks={file.peaks}
                view={view}
                viewSpan={detailWidth * view.spp}
                selection={selection}
                loopOn={loopOn}
                markers={markers}
                getPosition={getPosition}
                onSeek={seek}
                onView={setView}
              />
              <WaveformView
                peaks={file.peaks}
                view={view}
                selection={selection}
                loopOn={loopOn}
                playing={playing}
                follow={follow}
                markers={markers}
                selectedMarker={selectedMarker}
                getPosition={getPosition}
                onView={setView}
                onSeek={seek}
                onSelect={onSelect}
                onSelectBetweenMarkers={selectBetweenMarkers}
                onMarkerClick={(id) => {
                  setSelectedMarker(id)
                  const m = markers.find((x) => x.id === id)
                  if (m) engine?.seek(m.pos)
                }}
                onMarkerMove={(id, pos) => setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, pos: Math.round(pos) } : m)))}
                onMarkerEdit={(id) => {
                  setSelectedMarker(id)
                  if (markers.find((m) => m.id === id)?.kind !== 'section') return
                  setSidebarOpen(true)
                  setSidebarTab('markers')
                  setEditMarkerRequest({ id, n: Date.now() })
                }}
                onWidth={setDetailWidth}
              />
            </>
          ) : (
            <div className="empty">
              <div className="empty-title">Drop an audio file here</div>
              <div className="empty-sub">WAV · MP3 · FLAC · AAC/M4A · OGG/Opus</div>
              <Btn className="primary" onClick={() => void openFile()} disabled={!engine}>
                Open audio file…
              </Btn>
              <div className="shortcuts">
                <kbd>Space</kbd> play/pause <kbd>←</kbd>
                <kbd>→</kbd> ±1 s <kbd>L</kbd> loop <kbd>H</kbd> half speed <kbd>N</kbd>
                <kbd>M</kbd>
                <kbd>B</kbd> markers <kbd>wheel</kbd> zoom <kbd>drag</kbd> select — all keys can be changed with ⌨
              </div>
            </div>
          )}
          <AnalysisPanel
            engine={engine}
            peaks={file?.peaks ?? null}
            getPosition={getPosition}
            pitchRatio={pitchRatio}
            channelMode={channelMode}
            eqWeights={eqWeights}
            transpose={transpose}
            spelling={spelling}
            a4={a4}
            onA4={setA4}
            timbre={timbre}
            onTimbre={setTimbre}
            showGuitar={showGuitar}
            onShowGuitar={setShowGuitar}
            capo={capo}
            onCapo={setCapo}
          />
          {status && (
            <div className={`toast ${status.kind}`} role={status.kind === 'error' ? 'alert' : 'status'}>
              {status.text}
              {status.kind === 'error' && (
                <Btn className="small" onClick={() => setStatus(null)}>
                  Dismiss
                </Btn>
              )}
            </div>
          )}
          {dragOver && <div className="drop-overlay">Drop to open</div>}
        </main>

        {sidebarOpen && (
          <Sidebar
            tab={sidebarTab}
            onTab={setSidebarTab}
            sampleRate={sampleRate}
            disabled={disabled}
            markers={markers}
            selectedMarker={selectedMarker}
            editMarkerRequest={editMarkerRequest}
            onMarkerSeek={(id) => {
              setSelectedMarker(id)
              const m = markers.find((x) => x.id === id)
              if (m) engine?.seek(m.pos)
            }}
            onMarkerRename={(id, name) => setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m)))}
            onMarkerDelete={deleteMarker}
            onMarkerAdd={addMarker}
            onMarkersClear={(kind) => setMarkers((ms) => ms.filter((m) => m.kind !== kind))}
            tempo={tempo}
            onTap={tap}
            loops={loops}
            selection={selection}
            activeLoop={activeLoop}
            onLoopSave={saveLoop}
            onLoopRecall={recallLoop}
            onLoopRename={(id, name) => setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, name } : l)))}
            onLoopDelete={(id) => setLoops((ls) => ls.filter((l) => l.id !== id))}
            onLoopUpdate={(id) => selection && setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, ...selection } : l)))}
            engine={engine}
            eq={eq}
            onEq={setEq}
            channelMode={channelMode}
            onChannelMode={setChannelMode}
            channels={file?.buffer.numberOfChannels ?? 2}
          />
        )}
      </div>

      <Transport
        disabled={disabled}
        getPosition={getPosition}
        sampleRate={sampleRate}
        length={length}
        playing={playing}
        onTogglePlay={togglePlay}
        onStop={stop}
        onToStart={toStart}
        onJump={jump}
        loopOn={loopOn}
        onToggleLoop={toggleLoop}
        selection={selection}
        speed={speed}
        onSpeed={changeSpeed}
        semitones={semitones}
        onSemitones={setSemitones}
        cents={cents}
        onCents={setCents}
      />

      {shortcutsOpen && (
        <ShortcutsDialog
          bindings={bindings}
          onBindings={setBindings}
          globalEnabled={globalEnabled}
          onGlobalEnabled={(on) => {
            setGlobalEnabledRaw(on)
            saveGlobalEnabled(on)
          }}
          globalFailures={globalFailures}
          hasElectron={!!window.api}
          midi={midi}
          capture={capture}
          onCapture={setCapture}
          onClose={() => {
            setCapture(null)
            setShortcutsOpen(false)
          }}
        />
      )}

      <input
        ref={fileInput}
        type="file"
        accept="audio/*,.flac,.m4a,.opus,.ogg"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) void loadDomFile(f)
          e.target.value = ''
        }}
      />
    </div>
  )
}
