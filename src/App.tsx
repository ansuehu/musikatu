import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AudioEngine, type Timbre } from './audio/AudioEngine'
import { FLAT_EQ, type EqState } from './audio/eq'
import { TRANSPOSITIONS, type Spelling } from './analysis/notes'
import type { ChannelMode } from './dsp/ChannelMixer'
import { buildPeaks, type Peaks } from './waveform/peaks'
import { WaveformView } from './components/WaveformView'
import { Overview } from './components/Overview'
import { TopBar } from './components/TopBar'
import { MAX_SPEED, MIN_SPEED, Transport } from './components/Transport'
import { ChordGuessPanel, KeyboardPanel } from './components/KeyboardPanel'
import { LiveGuitarPanel } from './components/GuitarPanel'
import { EqTab, isEqActive, LoopsTab, MarkersTab, MixTab, type ToolProps } from './components/ToolPanels'
import { MetronomeEditor } from './components/MetronomeEditor'
import { useLiveAnalysis } from './analysis/live'
import { cellWidth, DEFAULT_LAYOUT, loadLayout, movePanel, openTools, panelsIn, saveLayout, setCellWidth, setSize, SIZE_LIMITS, type Layout, type PanelId, type Place } from './layout/layout'
import { BottomDock, DragLayer, SidebarHost, ToolsButton, ToolsWindow } from './layout/LayoutUI'
import { ShortcutsDialog, type Capture } from './components/ShortcutsDialog'
import { Btn } from './components/Controls'
import { loadProject, projectKey, saveProject, uid, type Marker, type MarkerKind, type ProjectData, type SavedLoop } from './project'
import { comboFromEvent, loadBindings, loadGlobalEnabled, saveBindings, saveGlobalEnabled, toAccelerator, type Bindings } from './shortcuts'
import { useMidi } from './midi'
import { useStems } from './stems/useStems'
import { StemsTab } from './components/StemsTab'
import { analysisGains, analysisLabel, DEFAULT_STEM_MIX, STEM_NAMES, soloStem, stemGains, type StemMix } from './stems/types'
import { ChordsTab } from './components/ChordsTab'
import { useChordTrack, type ChordTrack } from './analysis/useChordTrack'
import { mergeShort, segmentAt, type Chord } from './analysis/chordTimeline'
import { chordName, parseChordName } from './analysis/notes'
import type { ChordLane } from './components/WaveformView'
import { GridPanel } from './components/GridPanel'
import type { MetronomePrefs } from './components/MetronomeEditor'
import { DEFAULT_METRONOME } from './dsp/Metronome'
import { useBeatGrid } from './rhythm/useBeatGrid'
import { barRange, positionInfo, snapToBeat, type BeatGrid } from './rhythm/grid'
import { PianoRoll, type NoteKey } from './components/PianoRoll'
import { NotesTab, type SynthPrefs } from './components/NotesTab'
import { useTranscription } from './transcription/useTranscription'
import { GM_PROGRAM, writeMidi } from './transcription/midi'
import { SOURCE_LABEL, type NoteTrack } from './transcription/types'
import { midiToFreq } from './analysis/notes'
import { PracticePanel, type CountInPrefs } from './components/PracticePanel'
import { DEFAULT_TRAINER, onLoopPass, startTrainer, type TrainerSettings, type TrainerState } from './practice/trainer'
import { medianBeatSpacing } from './rhythm/grid'
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
  sidebarOpen: boolean
  follow: boolean
  volume: number
  capo: number
  metronome: MetronomePrefs
  snapToBeats: boolean
  showPianoRoll: boolean
  noteSynth: SynthPrefs
  countIn: CountInPrefs
  trainer: TrainerSettings
}

const DEFAULT_PREFS: Prefs = {
  transposition: 'C',
  spelling: 'auto',
  a4: 440,
  timbre: 'piano',
  sidebarOpen: true,
  follow: true,
  volume: 0.8,
  capo: 0,
  metronome: { ...DEFAULT_METRONOME, on: false },
  snapToBeats: true,
  showPianoRoll: true,
  noteSynth: { volume: 0.7, muteSource: false },
  countIn: { enabled: false, bars: 1, eachLoop: false },
  trainer: DEFAULT_TRAINER,
}

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(localStorage.getItem('musikatu.prefs.v1') ?? '{}') as Partial<Prefs>) }
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
  const [stemMix, setStemMix] = useState<StemMix>(DEFAULT_STEM_MIX)
  const [chordTrack, setChordTrack] = useState<ChordTrack | null>(null)
  const [beatGrid, setBeatGrid] = useState<BeatGrid | null>(null)
  const [noteTracks, setNoteTracks] = useState<NoteTrack[]>([])
  const [selectedNotes, setSelectedNotes] = useState<Set<NoteKey>>(new Set())
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null)
  const [editMarkerRequest, setEditMarkerRequest] = useState<{ id: string; n: number } | null>(null)
  const [activeLoop, setActiveLoop] = useState<string | null>(null)
  const [tempo, setTempo] = useState<{ tapped: number; original: number } | null>(null)
  // display prefs
  const [transposition, setTransposition] = useState(initialPrefs.transposition)
  const [spelling, setSpelling] = useState(initialPrefs.spelling)
  const [a4, setA4] = useState(initialPrefs.a4)
  const [timbre, setTimbre] = useState<Timbre>(initialPrefs.timbre)
  const [sidebarOpen, setSidebarOpen] = useState(initialPrefs.sidebarOpen)
  const [layout, setLayout] = useState<Layout>(loadLayout)
  const [capo, setCapo] = useState(initialPrefs.capo)
  // Older saved prefs only had { on, volume }; fill in the sound settings.
  const [metronome, setMetronome] = useState<MetronomePrefs>(() => ({ ...DEFAULT_METRONOME, ...initialPrefs.metronome }))
  const [snapToBeats, setSnapToBeats] = useState(initialPrefs.snapToBeats)
  const [showPianoRoll, setShowPianoRoll] = useState(initialPrefs.showPianoRoll)
  const [noteSynth, setNoteSynth] = useState<SynthPrefs>(initialPrefs.noteSynth)
  const [countIn, setCountIn] = useState<CountInPrefs>(initialPrefs.countIn)
  const [trainerSettings, setTrainerSettings] = useState<TrainerSettings>(initialPrefs.trainer)
  const [trainer, setTrainer] = useState<TrainerState | null>(null)
  const [countInBeat, setCountInBeat] = useState<{ beat: number; of: number } | null>(null)
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

  // wrap events drive the speed trainer; handled through a ref so the subscription stays put
  const onWrapRef = useRef<() => void>(() => {})
  useEffect(
    () =>
      engine?.subscribe((e) => {
        if (e.type === 'playing') setPlaying(e.playing)
        else if (e.type === 'countin') setCountInBeat(e.beat === null ? null : { beat: e.beat, of: e.of })
        else if (e.type === 'wrap') onWrapRef.current()
      }),
    [engine],
  )
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

  // ---- layout ----
  useEffect(() => saveLayout(layout), [layout])
  const movePanelTo = useCallback((id: PanelId, place: Place, before: PanelId | null = null) => {
    setLayout((l) => movePanel(l, id, place, before))
    if (place === 'sidebar') setSidebarOpen(true)
  }, [])
  /** Brings a panel into view wherever it lives (a hidden one goes to the sidebar). */
  const focusPanel = useCallback((id: PanelId) => {
    setLayout((l) => {
      const place = l.place[id]
      if (place === 'sidebar') return { ...l, tab: id }
      if (place === 'tools') return openTools(l, id)
      return l
    })
    setSidebarOpen(true)
  }, [])

  // ---- persistence ----
  useEffect(() => {
    const prefs: Prefs = { transposition, spelling, a4, timbre, sidebarOpen, follow, volume, capo, metronome, snapToBeats, showPianoRoll, noteSynth, countIn, trainer: trainerSettings }
    try {
      localStorage.setItem('musikatu.prefs.v1', JSON.stringify(prefs))
    } catch {
      /* ignore */
    }
  }, [transposition, spelling, a4, timbre, sidebarOpen, follow, volume, capo, metronome, snapToBeats, showPianoRoll, noteSynth, countIn, trainerSettings])

  useEffect(() => {
    if (!projectId) return
    const data: ProjectData = { version: 1, markers, loops, eq, channelMode, speed, semitones, cents, stemMix, chordTrack: chordTrack ?? undefined, beatGrid: beatGrid ?? undefined, noteTracks }
    const t = setTimeout(() => void saveProject(projectId, data), 400)
    return () => clearTimeout(t)
  }, [projectId, markers, loops, eq, channelMode, speed, semitones, cents, stemMix, chordTrack, beatGrid, noteTracks])

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
        setStemMix(saved?.stemMix ?? DEFAULT_STEM_MIX)
        setChordTrack(saved?.chordTrack ?? null)
        setBeatGrid(saved?.beatGrid ?? null)
        setNoteTracks(saved?.noteTracks ?? [])
        setSelectedNotes(new Set())
        setProjectId(key)
        const restored = (saved?.markers?.length ?? 0) + (saved?.loops?.length ?? 0)
        setStatus(restored ? { kind: 'info', text: `Restored ${saved?.markers?.length ?? 0} markers and ${saved?.loops?.length ?? 0} loops` } : null)
        document.title = `${name} — Musikatu`
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

  const gridRef = useRef<BeatGrid | null>(null)
  const snapRef = useRef(snapToBeats)
  snapRef.current = snapToBeats
  const onSelect = useCallback(
    (raw: Selection, final: boolean) => {
      const g = gridRef.current
      let sel = raw
      if (g && snapRef.current) {
        const a = snapToBeat(g, raw.start)
        const b = snapToBeat(g, raw.end)
        if (b > a) sel = { start: a, end: b }
      }
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
        focusPanel('beats')
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
  // ---- AI stems ----
  const stemsCtl = useStems({ engine, buffer: file?.buffer ?? null, projectId })
  const stems = stemsCtl.stems
  const stemsActive = !!stems && stemMix.enabled
  useEffect(() => {
    if (!engine) return
    // no stems (or they were just deleted): play the original recording
    if (!stems) return engine.setGains([1, ...STEM_NAMES.map(() => 0)])
    const g = stemGains(stemMix)
    engine.setGains(stemMix.enabled ? [0, ...STEM_NAMES.map((n) => g[n])] : [1, ...STEM_NAMES.map(() => 0)])
  }, [engine, stems, stemMix])
  const soloed = stemsActive ? soloStem(stemMix) : null
  const displayPeaks = (soloed && stems?.find((s) => s.name === soloed)?.peaks) || file?.peaks || null
  // the live analysis listens to what you hear, or to the stems chosen for it in the Stems panel
  const analysisLayers = useMemo(() => {
    const g = analysisGains(stemMix, !!stems)
    if (!stems || !g) return null
    return stems
      .filter((s) => (g[s.name] ?? 0) > 0)
      .map((s) => ({ id: s.name, channels: Array.from({ length: s.buffer.numberOfChannels }, (_, c) => s.buffer.getChannelData(c)), gain: g[s.name]! }))
  }, [stems, stemMix])
  const listeningTo = analysisLabel(stemMix, !!stems)

  // ---- beats and bars ----
  gridRef.current = beatGrid
  const beats = useBeatGrid({ buffer: file?.buffer ?? null, grid: beatGrid, onGrid: setBeatGrid })
  useEffect(() => {
    if (!engine) return
    const down = new Set(beatGrid?.downbeats ?? [])
    engine.setClicks(beatGrid?.beats ?? [], (beatGrid?.beats ?? []).map((_, i) => down.has(i)))
  }, [engine, beatGrid])
  const metronomeRef = useRef(metronome)
  metronomeRef.current = metronome
  useEffect(() => {
    const { on, ...settings } = metronome
    engine?.setMetronome(on && !!beatGrid, settings)
  }, [engine, metronome, beatGrid])
  const loopBars = useCallback(
    (from: number, to: number) => {
      if (!beatGrid || !engine) return
      const a = barRange(beatGrid, from, length)
      const b = barRange(beatGrid, to, length)
      if (!a || !b) return setStatus({ kind: 'error', text: `This song has bars ${beatGrid.firstBar}–${beatGrid.firstBar + beatGrid.downbeats.length - 1}.` })
      setSelection({ start: a.start, end: b.end })
      setActiveLoop(null)
      setLoopOn(true)
      engine.seek(a.start)
      const span = detailWidth * view.spp
      if (a.start < view.start || a.start > view.start + span) setView({ start: a.start - span * 0.05, spp: view.spp })
    },
    [beatGrid, engine, length, detailWidth, view, setView],
  )
  const jumpBar = useCallback(
    (dir: -1 | 1) => {
      if (!beatGrid || !engine) return
      const info = positionInfo(beatGrid, engine.position)
      const here = barRange(beatGrid, info.bar, length)
      // like "previous track": first back to the start of this bar, then to the bar before
      const slack = engine.isPlaying ? sampleRate * 0.3 : 1
      const target = dir > 0 ? info.bar + 1 : here && engine.position - here.start > slack ? info.bar : info.bar - 1
      const r = barRange(beatGrid, target, length)
      if (r) engine.seek(r.start)
    },
    [beatGrid, engine, length, sampleRate],
  )

  // ---- practice: count-in and speed trainer ----
  const meter = beatGrid?.meter ?? 4
  useEffect(() => {
    engine?.setCountIn({
      enabled: countIn.enabled,
      beats: countIn.bars * meter,
      accentEvery: meter,
      sourceInterval: beatGrid ? medianBeatSpacing(beatGrid) : 0,
      eachLoop: countIn.eachLoop,
    })
  }, [engine, countIn, meter, beatGrid])
  useEffect(() => {
    if (!playing) setCountInBeat(null)
  }, [playing])

  const trainerRef = useRef({ trainer, trainerSettings })
  trainerRef.current = { trainer, trainerSettings }
  onWrapRef.current = () => {
    const { trainer: st, trainerSettings: s } = trainerRef.current
    if (!st?.active) return
    const next = onLoopPass(st, s)
    setTrainer(next)
    if (next.speed !== st.speed) setSpeed(next.speed)
    if (next.stop) engine?.pause()
  }
  const startTrainerSession = useCallback(() => {
    if (!engine || !length) return
    const region = selection ?? { start: 0, end: length }
    if (!selection) setSelection(region)
    setLoopOn(true)
    setSpeed(trainerSettings.from)
    setTrainer(startTrainer(trainerSettings))
    engine.seek(region.start)
    if (!engine.isPlaying) engine.play()
  }, [engine, length, selection, trainerSettings])
  const stopTrainerSession = useCallback(() => setTrainer((t) => (t ? { ...t, active: false } : t)), [])
  // a new song ends any session
  useEffect(() => setTrainer(null), [file])

  // ---- audio → notes ----
  // Re-detected notes get new indices, so a selection by index no longer means anything.
  const replaceNoteTracks = useCallback((fn: (t: NoteTrack[]) => NoteTrack[]) => {
    setNoteTracks(fn)
    setSelectedNotes(new Set())
  }, [])
  const transcription = useTranscription({ buffer: file?.buffer ?? null, stems, tracks: noteTracks, onTracks: replaceNoteTracks })
  useEffect(() => engine?.setSynthNotes(noteTracks.filter((t) => t.play).flatMap((t) => t.notes)), [engine, noteTracks])
  useEffect(() => {
    const any = noteTracks.some((t) => t.play && t.notes.length)
    engine?.setNoteSynth(any, noteSynth.volume, any && noteSynth.muteSource)
  }, [engine, noteTracks, noteSynth])
  /** Applies `fn` to every selected note (by track and index) and marks those tracks as edited. */
  const editSelectedNotes = useCallback(
    (fn: (n: NoteTrack['notes'][number]) => NoteTrack['notes'][number] | null) => {
      if (selectedNotes.size === 0) return false
      setNoteTracks((ts) =>
        ts.map((t) => {
          const mine = t.notes.some((_, i) => selectedNotes.has(`${t.source}:${i}`))
          if (!mine) return t
          const notes = t.notes.flatMap((n, i) => {
            if (!selectedNotes.has(`${t.source}:${i}`)) return [n]
            const r = fn(n)
            return r ? [r] : []
          })
          return { ...t, notes, edited: true }
        }),
      )
      return true
    },
    [selectedNotes],
  )
  const exportMidi = useCallback(() => {
    const tracks = noteTracks
      .filter((t) => t.visible && t.notes.length)
      .map((t) => ({ name: SOURCE_LABEL(t.source), program: GM_PROGRAM[t.source] ?? 0, notes: t.notes }))
    const bytes = writeMidi(tracks, beatGrid, sampleRate, file?.name ?? 'Musikatu')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'audio/midi' }))
    a.download = `${(file?.name ?? 'song').replace(/\.[^.]+$/, '')} - notes.mid`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }, [noteTracks, beatGrid, sampleRate, file])
  const showRoll = showPianoRoll && noteTracks.some((t) => t.visible && t.notes.length)

  // ---- whole-song chord chart ----
  const chords = useChordTrack({ buffer: file?.buffer ?? null, stems, track: chordTrack, onTrack: setChordTrack, a4, grid: beatGrid })
  // Names follow what you hear: the pitch shift (rounded) plus the instrument transposition.
  const pitchShift = Math.round(semitones + cents / 100)
  const chordLabel = useCallback(
    (c: Chord) => chordName({ ...c, root: c.root + pitchShift, bass: c.bass === null ? null : c.bass + pitchShift, score: 0 }, transpose, spelling),
    [pitchShift, transpose, spelling],
  )
  const parseChord = useCallback(
    (text: string): Chord | null | undefined => {
      const c = parseChordName(text)
      if (!c) return c
      const back = (pc: number) => (((pc - pitchShift - transpose) % 12) + 12) % 12
      return { root: back(c.root), suffix: c.suffix, bass: c.bass === null ? null : back(c.bass) }
    },
    [pitchShift, transpose],
  )
  const chordLane = useMemo((): ChordLane | null => {
    if (!file) return null
    const segs = chordTrack?.segments ?? []
    const labels = segs.map((s) => (s.chord ? chordLabel(s.chord) : ''))
    const placeholder = chords.status.kind === 'running' ? `Analysing chords… ${Math.round(chords.status.fraction * 100)}%` : undefined
    return { segments: segs, labels, version: `${segs.length}|${segs[segs.length - 1]?.end}|${labels.join(',')}`, placeholder: segs.length ? undefined : placeholder }
  }, [file, chordTrack, chordLabel, chords.status])

  const editChords = useCallback((fn: (segs: ChordTrack['segments']) => ChordTrack['segments']) => {
    setChordTrack((t) => (t ? { ...t, segments: mergeShort(fn(t.segments.map((s) => ({ ...s }))), 0), edited: true } : t))
  }, [])
  const selectChordSpan = useCallback(
    (i: number) => {
      const seg = chordTrack?.segments[i]
      if (seg) onSelect({ start: seg.start, end: seg.end }, true)
    },
    [chordTrack, onSelect],
  )
  const jumpChord = useCallback(
    (dir: -1 | 1) => {
      const segs = chordTrack?.segments
      if (!engine || !segs?.length) return
      const pos = engine.position
      const i = segmentAt(segs, pos)
      // "previous" from inside a chord first returns to its start, like a CD player
      const target = dir > 0 ? segs[Math.min(segs.length - 1, i + 1)] : pos - (segs[i]?.start ?? 0) > sampleRate * 0.5 ? segs[i] : segs[Math.max(0, i - 1)]
      if (target) engine.seek(target.start)
    },
    [chordTrack, engine, sampleRate],
  )

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
          setSelectedNotes(new Set())
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
        case 'deleteMarker':
          if (editSelectedNotes(() => null)) return setSelectedNotes(new Set())
          return deleteMarker(selectedMarker)
        case 'noteUp': return void editSelectedNotes((n) => ({ ...n, midi: Math.min(108, n.midi + 1) }))
        case 'noteDown': return void editSelectedNotes((n) => ({ ...n, midi: Math.max(21, n.midi - 1) }))
        case 'zoomIn': return zoom(1 / 1.6)
        case 'zoomOut': return zoom(1.6)
        case 'zoomFit': return fit()
        case 'follow': return setFollow((f) => !f)
        case 'toggleStems': return setStemMix((m) => ({ ...m, enabled: !m.enabled }))
        case 'prevChord': return jumpChord(-1)
        case 'prevBar': return jumpBar(-1)
        case 'nextBar': return jumpBar(1)
        case 'metronome': return setMetronome((m) => ({ ...m, on: !m.on }))
        case 'countIn': return setCountIn((c) => ({ ...c, enabled: !c.enabled }))
        case 'trainer': return trainer?.active ? stopTrainerSession() : startTrainerSession()
        case 'selectBar': {
          if (!beatGrid || !engine) return
          const r = barRange(beatGrid, positionInfo(beatGrid, engine.position).bar, length)
          if (r) onSelect(r, true)
          return
        }
        case 'nextChord': return jumpChord(1)
        case 'selectChord': {
          const i = chordTrack && engine ? segmentAt(chordTrack.segments, engine.position) : -1
          if (i >= 0) selectChordSpan(i)
          return
        }
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

  // ---- live analysis: runs once for the keyboard, chord guess and guitar panels, wherever they are ----
  const shown = (id: PanelId) => layout.place[id] === 'bottom' || (layout.place[id] === 'tools' && layout.toolsOpen && layout.toolsTab === id) || (layout.place[id] === 'sidebar' && sidebarOpen && layout.tab === id)
  useLiveAnalysis({
    enabled: shown('keyboard') || shown('chordGuess') || shown('guitar'),
    peaks: file?.peaks ?? null,
    sampleRate,
    getPosition,
    pitchRatio,
    channelMode,
    eqWeights,
    layers: analysisLayers,
    a4,
  })
  /** Panels with something switched on get a dot on their tab / button. */
  const panelDots = new Set<PanelId>([
    ...(stemsActive ? (['stems'] as const) : []),
    ...(isEqActive(eq) ? (['eq'] as const) : []),
    ...(channelMode !== 'stereo' ? (['mix'] as const) : []),
    ...(metronome.on ? (['metronome'] as const) : []),
  ])

  // ---- panels (placed by the layout: sidebar, bottom strip, floating windows) ----
  const toolProps: ToolProps = {
    sampleRate: sampleRate,
    disabled: disabled,
    markers: markers,
    selectedMarker: selectedMarker,
    editMarkerRequest: editMarkerRequest,
    onMarkerSeek: (id) => {
setSelectedMarker(id)
const m = markers.find((x) => x.id === id)
if (m) engine?.seek(m.pos)
},
    onMarkerRename: (id, name) => setMarkers((ms) => ms.map((m) => (m.id === id ? { ...m, name } : m))),
    onMarkerDelete: deleteMarker,
    onMarkerAdd: addMarker,
    onMarkersClear: (kind) => setMarkers((ms) => ms.filter((m) => m.kind !== kind)),
    tempo: tempo,
    onTap: tap,
    loops: loops,
    selection: selection,
    activeLoop: activeLoop,
    onLoopSave: saveLoop,
    onLoopRecall: recallLoop,
    onLoopRename: (id, name) => setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, name } : l))),
    onLoopDelete: (id) => setLoops((ls) => ls.filter((l) => l.id !== id)),
    onLoopUpdate: (id) => selection && setLoops((ls) => ls.map((l) => (l.id === id ? { ...l, ...selection } : l))),
    engine: engine,
    eq: eq,
    onEq: setEq,
    channelMode: channelMode,
    onChannelMode: setChannelMode,
    channels: file?.buffer.numberOfChannels ?? 2,
    gridPanel: (
        <GridPanel
          grid={beatGrid}
          status={beats.status}
          hasFile={!!file}
          sampleRate={sampleRate}
          speed={speed}
          getPosition={getPosition}
          onRerun={() => void beats.run()}
          onGrid={setBeatGrid}
          snap={snapToBeats}
          onSnap={setSnapToBeats}
          onLoopBars={loopBars}
        />
    ),
    practicePanel: (
        <PracticePanel
          countIn={countIn}
          onCountIn={setCountIn}
          hasGrid={!!beatGrid}
          meter={meter}
          trainer={trainerSettings}
          onTrainer={setTrainerSettings}
          state={trainer}
          onStart={startTrainerSession}
          onStop={stopTrainerSession}
          hasFile={!!file}
          loopReady={!!selection}
        />
    ),
  }
  const renderPanel = (id: PanelId): ReactNode => {
    switch (id) {
      case 'stems':
        return (
            <StemsTab
              ctl={stemsCtl}
              hasFile={!!file}
              fileName={file?.name ?? null}
              duration={file?.buffer.duration ?? 0}
              mix={stemMix}
              onMix={setStemMix}
              projectId={projectId}
            />
        )
      case 'chords':
        return (
            <ChordsTab
              track={chordTrack}
              status={chords.status}
              hasFile={!!file}
              hasStems={!!stems}
              sampleRate={sampleRate}
              fileName={file?.name ?? null}
              getPosition={getPosition}
              label={chordLabel}
              parse={parseChord}
              pitchShift={pitchShift}
              spelling={spelling}
              capo={capo}
              a4={a4}
              engine={engine}
              onRun={(source, vocabulary) => chords.run(source, vocabulary)}
              onEdit={(i, chord) => editChords((segs) => ((segs[i].chord = chord), segs))}
              onDelete={(i) =>
                editChords((segs) => {
                  if (segs.length < 2) return segs
                  if (i > 0) segs[i - 1].end = segs[i].end
                  else segs[1].start = segs[0].start
                  segs.splice(i, 1)
                  return segs
                })
              }
              onSplit={() =>
                editChords((segs) => {
                  const pos = Math.round(engine?.position ?? 0)
                  const i = segmentAt(segs, pos)
                  if (i < 0 || pos - segs[i].start < sampleRate * 0.1 || segs[i].end - pos < sampleRate * 0.1) return segs
                  // mergeShort would re-join two identical halves, so mark the new half as "no chord" for the user to name
                  segs.splice(i + 1, 0, { ...segs[i], start: pos, chord: null })
                  segs[i].end = pos
                  return segs
                })
              }
              onSeek={(i) => {
                const seg = chordTrack?.segments[i]
                if (seg) engine?.seek(seg.start)
              }}
              onLoop={(i) => {
                selectChordSpan(i)
                setLoopOn(true)
              }}
              grid={beatGrid}
              songLength={length}
            />
        )
      case 'notes':
        return (
            <NotesTab
              ctl={transcription}
              tracks={noteTracks}
              onTracks={replaceNoteTracks}
              hasFile={!!file}
              hasStems={!!stems}
              hasGrid={!!beatGrid}
              synth={noteSynth}
              onSynth={setNoteSynth}
              showRoll={showPianoRoll}
              onShowRoll={setShowPianoRoll}
              selectedCount={selectedNotes.size}
              onExport={exportMidi}
              spelling={spelling}
            />
        )
      case 'beats':
        return <MarkersTab {...toolProps} />
      case 'practice':
        return <LoopsTab {...toolProps} />
      case 'eq':
        return <EqTab {...toolProps} />
      case 'mix':
        return <MixTab {...toolProps} />
      case 'metronome':
        return (
          <MetronomeEditor
            value={metronome}
            onChange={setMetronome}
            hasGrid={!!beatGrid}
            onPreview={(accent) => {
              // send the newest settings first (a preset click and its preview happen in the same tick)
              const { on, ...settings } = metronomeRef.current
              engine?.setMetronome(on && !!beatGrid, settings)
              engine?.previewClick(accent)
            }}
            standalone
          />
        )
      case 'keyboard':
        return <KeyboardPanel engine={engine} transpose={transpose} spelling={spelling} a4={a4} timbre={timbre} source={listeningTo} onSource={() => focusPanel('stems')} />
      case 'chordGuess':
        return <ChordGuessPanel transpose={transpose} spelling={spelling} a4={a4} onA4={setA4} timbre={timbre} onTimbre={setTimbre} source={listeningTo} onSource={() => focusPanel('stems')} />
      case 'guitar':
        return <LiveGuitarPanel engine={engine} spelling={spelling} transpose={transpose} capo={capo} onCapo={setCapo} a4={a4} />
    }
  }

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
        tools={
          <ToolsButton layout={layout} dots={panelDots} onToggle={() => setLayout((l) => (l.toolsOpen ? { ...l, toolsOpen: false } : openTools(l)))} />
        }
        sidebarOpen={sidebarOpen}
        onSidebar={setSidebarOpen}
        disabled={disabled}
      />

      <div
        className={`body ${sidebarOpen && panelsIn(layout, 'sidebar').length > 0 ? 'with-sidebar' : ''}`}
        style={{ '--sidebar-w': `${layout.sidebarW ?? SIZE_LIMITS.sidebarW.def}px` } as CSSProperties}
      >
        <main className="workspace">
          {file ? (
            <>
              <Overview
                peaks={displayPeaks ?? file.peaks}
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
                peaks={displayPeaks ?? file.peaks}
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
                  focusPanel('beats')
                  setEditMarkerRequest({ id, n: Date.now() })
                }}
                onWidth={setDetailWidth}
                chordLane={chordLane}
                grid={beatGrid}
                onChordClick={(i) => {
                  const seg = chordTrack?.segments[i]
                  if (seg) engine?.seek(seg.start)
                }}
                onChordDoubleClick={selectChordSpan}
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
          {file && showRoll && (
            <PianoRoll
              tracks={noteTracks}
              view={view}
              grid={beatGrid}
              getPosition={getPosition}
              selected={selectedNotes}
              transpose={transpose}
              spelling={spelling}
              onView={setView}
              onSeek={seek}
              onSelect={setSelectedNotes}
              onPlayNote={(midi) => {
                if (!engine) return
                const release = engine.playTone(midiToFreq(midi, a4) * pitchRatio, 'piano')
                setTimeout(release, 600)
              }}
            />
          )}
          <BottomDock
            ids={panelsIn(layout, 'bottom')}
            widthOf={(id) => cellWidth(layout, id)}
            height={layout.bottomH}
            render={renderPanel}
            onMove={movePanelTo}
            onResizeCell={(id, w) => setLayout((l) => setCellWidth(l, id, w))}
            onResizeHeight={(h) => setLayout((l) => setSize(l, 'bottomH', h))}
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
          {countInBeat && countInBeat.beat > 0 && (
            <div className="countin-overlay" aria-live="assertive">
              <span key={countInBeat.beat}>{((countInBeat.beat - 1) % meter) + 1}</span>
            </div>
          )}
        </main>

        {sidebarOpen && panelsIn(layout, 'sidebar').length > 0 && (
          <SidebarHost ids={panelsIn(layout, 'sidebar')} tab={layout.tab} onTab={(id) => setLayout((l) => ({ ...l, tab: id }))} dots={panelDots} render={renderPanel} onMove={movePanelTo} onResize={(w) => setLayout((l) => setSize(l, 'sidebarW', w))} />
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
        grid={beatGrid}
        metronomeOn={metronome.on}
        countInOn={countIn.enabled}
        onCountIn={() => setCountIn((c) => ({ ...c, enabled: !c.enabled }))}
        trainer={trainer?.active ? { speed: trainer.speed, to: trainerSettings.to } : null}
        onTrainerStop={stopTrainerSession}
        onMetronome={() => setMetronome((m) => ({ ...m, on: !m.on }))}
      />

      <ToolsWindow layout={layout} dots={panelDots} render={renderPanel} onLayout={setLayout} onMove={movePanelTo} onReset={() => setLayout(DEFAULT_LAYOUT)} />
      <DragLayer
        onDrop={(id, t) => movePanelTo(id, t.place, t.before)}
        sidebarVisible={sidebarOpen && panelsIn(layout, 'sidebar').length > 0}
        bottomVisible={panelsIn(layout, 'bottom').length > 0}
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
