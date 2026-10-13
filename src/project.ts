import type { ChannelMode } from './dsp/ChannelMixer'
import type { EqState } from './audio/eq'

export type MarkerKind = 'section' | 'measure' | 'beat'

export interface Marker {
  id: string
  kind: MarkerKind
  /** Source sample. */
  pos: number
  name: string
}

export interface SavedLoop {
  id: string
  name: string
  start: number
  end: number
}

/** Everything remembered per audio file, autosaved next to the app's user data. */
export interface ProjectData {
  version: 1
  markers: Marker[]
  loops: SavedLoop[]
  eq: EqState
  channelMode: ChannelMode
  speed: number
  semitones: number
  cents: number
  /** Stem mixer settings, when the file has been separated. */
  stemMix?: import('./stems/types').StemMix
}

export const SECTION_NAMES = ['Intro', 'Verse', 'Pre-chorus', 'Chorus', 'Bridge', 'Solo', 'Breakdown', 'Outro']

export const uid = (): string => crypto.randomUUID()

/** Stable identity for a file: its path when we know it, else name + decoded length. */
export function projectKey(name: string, path: string | null, length: number): string {
  return path ? `path:${path}` : `name:${name}:${length}`
}

const LOCAL_PREFIX = 'earwork.project.'

export async function loadProject(key: string): Promise<Partial<ProjectData> | null> {
  try {
    const json = window.api ? await window.api.loadProject(key) : localStorage.getItem(LOCAL_PREFIX + key)
    if (!json) return null
    const data = JSON.parse(json) as Partial<ProjectData>
    return data.version === 1 ? data : null
  } catch {
    return null
  }
}

export async function saveProject(key: string, data: ProjectData): Promise<void> {
  const json = JSON.stringify(data)
  try {
    if (window.api) await window.api.saveProject(key, json)
    else localStorage.setItem(LOCAL_PREFIX + key, json)
  } catch (err) {
    console.warn('Could not save project', err)
  }
}

/** Measure numbers by marker id (1-based, in time order). */
export function measureNumbers(markers: Marker[]): Map<string, number> {
  const out = new Map<string, number>()
  let n = 0
  for (const m of [...markers].sort((a, b) => a.pos - b.pos)) if (m.kind === 'measure') out.set(m.id, ++n)
  return out
}
