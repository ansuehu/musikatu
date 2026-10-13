/** Action registry, key-combo normalisation and user binding storage. */

export interface ActionDef {
  id: string
  label: string
  group: 'Transport' | 'Loops' | 'Speed & pitch' | 'Markers' | 'View'
  key?: string
  global?: string
}

const loopRecall: ActionDef[] = Array.from({ length: 9 }, (_, i) => ({
  id: `recallLoop${i + 1}`,
  label: `Recall saved loop ${i + 1}`,
  group: 'Loops',
  key: String(i + 1),
}))

export const ACTIONS: ActionDef[] = [
  { id: 'playPause', label: 'Play / pause', group: 'Transport', key: 'Space', global: 'Ctrl+Alt+Space' },
  { id: 'stop', label: 'Stop and return', group: 'Transport', key: 'S' },
  { id: 'back1', label: 'Jump back 1 s', group: 'Transport', key: 'ArrowLeft', global: 'Ctrl+Alt+ArrowLeft' },
  { id: 'fwd1', label: 'Jump forward 1 s', group: 'Transport', key: 'ArrowRight', global: 'Ctrl+Alt+ArrowRight' },
  { id: 'back5', label: 'Jump back 5 s', group: 'Transport', key: 'Shift+ArrowLeft' },
  { id: 'fwd5', label: 'Jump forward 5 s', group: 'Transport', key: 'Shift+ArrowRight' },
  { id: 'toStart', label: 'To start / loop start', group: 'Transport', key: 'Home', global: 'Ctrl+Alt+Home' },
  { id: 'prevMarker', label: 'Previous marker', group: 'Transport', key: ',' },
  { id: 'nextMarker', label: 'Next marker', group: 'Transport', key: '.' },
  { id: 'loop', label: 'Cycle loop on / off', group: 'Loops', key: 'L', global: 'Ctrl+Alt+L' },
  { id: 'saveLoop', label: 'Save selection as loop', group: 'Loops', key: 'Shift+L' },
  { id: 'clearSelection', label: 'Clear selection', group: 'Loops', key: 'Escape' },
  ...loopRecall,
  { id: 'halfSpeed', label: 'Toggle half speed', group: 'Speed & pitch', key: 'H', global: 'Ctrl+Alt+H' },
  { id: 'speedDown', label: 'Speed −5%', group: 'Speed & pitch', key: '[', global: 'Ctrl+Alt+[' },
  { id: 'speedUp', label: 'Speed +5%', group: 'Speed & pitch', key: ']', global: 'Ctrl+Alt+]' },
  { id: 'pitchDown', label: 'Pitch −1 semitone', group: 'Speed & pitch', key: 'Shift+ArrowDown' },
  { id: 'pitchUp', label: 'Pitch +1 semitone', group: 'Speed & pitch', key: 'Shift+ArrowUp' },
  { id: 'tapTempo', label: 'Tap tempo', group: 'Speed & pitch', key: 'T' },
  { id: 'addSection', label: 'Add section marker', group: 'Markers', key: 'N' },
  { id: 'addMeasure', label: 'Add measure marker', group: 'Markers', key: 'M' },
  { id: 'addBeat', label: 'Add beat marker', group: 'Markers', key: 'B' },
  { id: 'deleteMarker', label: 'Delete selected marker', group: 'Markers', key: 'Delete' },
  { id: 'zoomIn', label: 'Zoom in', group: 'View', key: '=' },
  { id: 'zoomOut', label: 'Zoom out', group: 'View', key: '-' },
  { id: 'zoomFit', label: 'Zoom to fit', group: 'View', key: '0' },
  { id: 'follow', label: 'Follow playhead', group: 'View', key: 'F' },
]

export interface Binding {
  key: string | null
  global: string | null
  midi: string | null
}
export type Bindings = Record<string, Binding>

export function defaultBindings(): Bindings {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, { key: a.key ?? null, global: a.global ?? null, midi: null }]))
}

const STORAGE_KEY = 'earwork.bindings.v1'
const GLOBAL_KEY = 'earwork.globalHotkeys.v1'

export function loadBindings(): Bindings {
  const b = defaultBindings()
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<Bindings>
    for (const [id, v] of Object.entries(stored)) if (b[id] && v) b[id] = { ...b[id], ...v }
  } catch {
    /* corrupt storage: defaults */
  }
  return b
}

export function saveBindings(b: Bindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(b))
  } catch {
    /* private mode etc. */
  }
}

export function loadGlobalEnabled(): boolean {
  try {
    return localStorage.getItem(GLOBAL_KEY) === '1'
  } catch {
    return false
  }
}

export function saveGlobalEnabled(on: boolean): void {
  try {
    localStorage.setItem(GLOBAL_KEY, on ? '1' : '0')
  } catch {
    /* ignore */
  }
}

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock', 'Fn'])

/** Canonical combo such as "Ctrl+Shift+L", "Space", "[" — or null for a bare modifier press. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  let key = e.key
  if (MODIFIERS.has(key) || key === 'Dead' || key === 'Unidentified') return null
  // Alt (Option on macOS) rewrites the character; fall back to the physical key.
  if (e.altKey && /^Key[A-Z]$|^Digit\d$/.test(e.code)) key = e.code.slice(-1)
  if (key === ' ') key = 'Space'
  const single = key.length === 1
  const isSymbol = single && !/[a-z0-9]/i.test(key)
  if (single) key = key.toUpperCase()
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  // For symbols Shift is already baked into the character ("{" rather than Shift+[).
  if (e.shiftKey && !isSymbol) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

const PRETTY: Record<string, string> = {
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  Escape: 'Esc',
  Delete: 'Del',
  MediaPlayPause: 'Media ⏯',
  MediaTrackNext: 'Media ⏭',
  MediaTrackPrevious: 'Media ⏮',
}

export function formatCombo(combo: string | null): string {
  if (!combo) return ''
  // split on "+" separators but keep a literal "+" key
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  return parts.map((p) => PRETTY[p] ?? p).join(' + ')
}

const ACCEL_KEYS: Record<string, string> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Enter: 'Return',
  '+': 'Plus',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
}

/** Electron accelerator for a combo. */
export function toAccelerator(combo: string): string {
  const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+')
  return parts
    .map((p) => (p === 'Ctrl' ? 'CommandOrControl' : p === 'Meta' ? 'Super' : (ACCEL_KEYS[p] ?? p)))
    .join('+')
}

/** A global hotkey without a modifier would swallow that key in every other app. */
export function isRiskyGlobal(combo: string): boolean {
  return !/(Ctrl|Alt|Meta)\+/.test(combo) && !/^(F\d+|Media)/.test(combo)
}

export function formatMidi(binding: string | null): string {
  if (!binding) return ''
  const [kind, num] = binding.split(':')
  return kind === 'cc' ? `CC ${num}` : `Note ${num}`
}
