/**
 * Modular layout. Every tool is a panel shown either in the main window (sidebar tabs or the bottom strip)
 * or as a tab of the Tools window, a single movable, tabbed window like a settings dialog.
 */

export type PanelId = 'stems' | 'chords' | 'notes' | 'beats' | 'practice' | 'metronome' | 'eq' | 'mix' | 'keyboard' | 'chordGuess' | 'guitar'
export type Place = 'sidebar' | 'bottom' | 'tools'

export interface PanelMeta {
  id: PanelId
  title: string
  /** Width in the bottom strip: px, or 'flex' to take the remaining space. */
  bottomWidth: number | 'flex'
}

export const PANELS: PanelMeta[] = [
  { id: 'stems', title: 'Stems', bottomWidth: 330 },
  { id: 'chords', title: 'Chords', bottomWidth: 340 },
  { id: 'notes', title: 'Notes', bottomWidth: 330 },
  { id: 'beats', title: 'Beats', bottomWidth: 330 },
  { id: 'practice', title: 'Practice', bottomWidth: 330 },
  { id: 'metronome', title: 'Metronome', bottomWidth: 320 },
  { id: 'eq', title: 'EQ', bottomWidth: 340 },
  { id: 'mix', title: 'Mix', bottomWidth: 300 },
  { id: 'keyboard', title: 'Keyboard & spectrum', bottomWidth: 'flex' },
  { id: 'chordGuess', title: 'Chord guess', bottomWidth: 210 },
  { id: 'guitar', title: 'Guitar', bottomWidth: 200 },
]

export const PLACE_LABEL: Record<Place, string> = {
  sidebar: 'Sidebar',
  bottom: 'Bottom strip',
  tools: 'Tools window',
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  place: Record<PanelId, Place>
  /** Display order, shared by the sidebar, the bottom strip and the Tools window. */
  order: PanelId[]
  /** Active sidebar tab. */
  tab: PanelId | null
  /** Active Tools-window tab. */
  toolsTab: PanelId | null
  toolsOpen: boolean
  toolsRect: Rect | null
}

export const DEFAULT_LAYOUT: Layout = {
  place: {
    stems: 'sidebar',
    chords: 'sidebar',
    notes: 'sidebar',
    beats: 'sidebar',
    practice: 'tools',
    metronome: 'tools',
    eq: 'tools',
    mix: 'tools',
    keyboard: 'bottom',
    chordGuess: 'bottom',
    guitar: 'bottom',
  },
  order: PANELS.map((p) => p.id),
  tab: 'stems',
  toolsTab: 'practice',
  toolsOpen: false,
  toolsRect: null,
}

export const metaOf = (id: PanelId) => PANELS.find((p) => p.id === id)!
export const panelsIn = (l: Layout, place: Place) => l.order.filter((id) => l.place[id] === place)

const KEY = 'musikatu.layout.v2'
const OLD_KEY = 'musikatu.layout.v1'

/** Saved layout merged over the defaults (panels added later still get a place); v1 layouts are migrated. */
export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return normalise(JSON.parse(raw) as Partial<Layout>)
    const old = JSON.parse(localStorage.getItem(OLD_KEY) ?? 'null') as { place?: Record<string, string>; order?: PanelId[]; tab?: PanelId } | null
    if (old?.place) {
      // v1 had floating windows and "hidden": both now live in the Tools window
      const place = Object.fromEntries(Object.entries(old.place).map(([id, p]) => [id, p === 'sidebar' || p === 'bottom' ? p : 'tools'])) as Record<PanelId, Place>
      return normalise({ place, order: old.order, tab: old.tab ?? null })
    }
  } catch {
    /* corrupt storage: defaults */
  }
  return DEFAULT_LAYOUT
}

function normalise(saved: Partial<Layout>): Layout {
  const known = PANELS.map((p) => p.id)
  const order = [...(saved.order ?? []).filter((id) => known.includes(id)), ...known.filter((id) => !(saved.order ?? []).includes(id))]
  const place = { ...DEFAULT_LAYOUT.place }
  for (const id of known) {
    const p = saved.place?.[id]
    if (p === 'sidebar' || p === 'bottom' || p === 'tools') place[id] = p
  }
  const l: Layout = { ...DEFAULT_LAYOUT, ...saved, place, order }
  return fixTabs(l)
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* ignore */
  }
}

/** Keeps the active sidebar / Tools tabs pointing at panels that are actually there. */
function fixTabs(l: Layout): Layout {
  const side = panelsIn(l, 'sidebar')
  const tools = panelsIn(l, 'tools')
  return {
    ...l,
    tab: l.tab && side.includes(l.tab) ? l.tab : (side[0] ?? null),
    toolsTab: l.toolsTab && tools.includes(l.toolsTab) ? l.toolsTab : (tools[0] ?? null),
  }
}

/**
 * Puts panel `id` in `place`, before panel `before` (or at the end of that place), and makes it the
 * active tab there. Used by drag-and-drop, the Show buttons and the ⋯ menus.
 */
export function movePanel(l: Layout, id: PanelId, place: Place, before: PanelId | null = null): Layout {
  const rest = l.order.filter((x) => x !== id)
  let i: number
  if (before && before !== id && rest.includes(before)) i = rest.indexOf(before)
  else {
    // after the last panel already in that place, so it lands at the end of that group
    const last = rest.map((x, k) => (l.place[x] === place ? k : -1)).filter((k) => k >= 0).pop()
    i = last === undefined ? rest.length : last + 1
  }
  rest.splice(i, 0, id)
  const next: Layout = { ...l, order: rest, place: { ...l.place, [id]: place } }
  if (place === 'sidebar') next.tab = id
  if (place === 'tools') next.toolsTab = id
  return fixTabs(next)
}

export function openTools(l: Layout, tab?: PanelId): Layout {
  return fixTabs({ ...l, toolsOpen: true, toolsTab: tab ?? l.toolsTab })
}
