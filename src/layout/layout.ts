/** Modular layout: every tool is a panel that lives in the sidebar, the bottom strip, a floating window, or nowhere. */

export type PanelId = 'stems' | 'chords' | 'notes' | 'beats' | 'practice' | 'metronome' | 'eq' | 'mix' | 'keyboard' | 'chordGuess' | 'guitar'
export type Place = 'sidebar' | 'bottom' | 'float' | 'hidden'

export interface PanelMeta {
  id: PanelId
  title: string
  /** Width in the bottom strip: a fixed number of px, or 'flex' to take the remaining space. */
  bottomWidth: number | 'flex'
  /** Default floating window size. */
  floatSize: { w: number; h: number }
}

export const PANELS: PanelMeta[] = [
  { id: 'stems', title: 'Stems', bottomWidth: 330, floatSize: { w: 340, h: 560 } },
  { id: 'chords', title: 'Chords', bottomWidth: 340, floatSize: { w: 360, h: 560 } },
  { id: 'notes', title: 'Notes', bottomWidth: 330, floatSize: { w: 340, h: 520 } },
  { id: 'beats', title: 'Beats', bottomWidth: 330, floatSize: { w: 340, h: 520 } },
  { id: 'practice', title: 'Practice', bottomWidth: 330, floatSize: { w: 340, h: 520 } },
  { id: 'metronome', title: 'Metronome', bottomWidth: 320, floatSize: { w: 330, h: 440 } },
  { id: 'eq', title: 'EQ', bottomWidth: 340, floatSize: { w: 340, h: 470 } },
  { id: 'mix', title: 'Mix', bottomWidth: 300, floatSize: { w: 310, h: 450 } },
  { id: 'keyboard', title: 'Keyboard & spectrum', bottomWidth: 'flex', floatSize: { w: 820, h: 240 } },
  { id: 'chordGuess', title: 'Chord guess', bottomWidth: 210, floatSize: { w: 230, h: 230 } },
  { id: 'guitar', title: 'Guitar', bottomWidth: 200, floatSize: { w: 220, h: 250 } },
]

export const PLACE_LABEL: Record<Place, string> = {
  sidebar: 'Sidebar',
  bottom: 'Bottom strip',
  float: 'Floating window',
  hidden: 'Hidden',
}

export interface FloatRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Layout {
  place: Record<PanelId, Place>
  /** Display order within the sidebar and the bottom strip. */
  order: PanelId[]
  /** Floating window geometry, remembered even while docked. */
  rects: Partial<Record<PanelId, FloatRect>>
  /** Which floating windows are open. */
  open: Partial<Record<PanelId, boolean>>
  /** Active sidebar tab. */
  tab: PanelId | null
  /** Stacking order of floating windows, last on top. */
  zOrder: PanelId[]
}

export const DEFAULT_LAYOUT: Layout = {
  place: {
    stems: 'sidebar',
    chords: 'sidebar',
    notes: 'sidebar',
    beats: 'sidebar',
    practice: 'sidebar',
    metronome: 'float',
    eq: 'float',
    mix: 'float',
    keyboard: 'bottom',
    chordGuess: 'bottom',
    guitar: 'bottom',
  },
  order: PANELS.map((p) => p.id),
  rects: {},
  open: {},
  tab: 'stems',
  zOrder: [],
}

export const metaOf = (id: PanelId) => PANELS.find((p) => p.id === id)!

const KEY = 'musikatu.layout.v1'

/** Saved layout merged over the defaults, so panels added in later versions still get a place. */
export function loadLayout(): Layout {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Layout> | null
    if (!saved) return DEFAULT_LAYOUT
    const known = new Set(PANELS.map((p) => p.id))
    const order = [...(saved.order ?? []).filter((id) => known.has(id)), ...PANELS.map((p) => p.id).filter((id) => !(saved.order ?? []).includes(id))]
    return {
      ...DEFAULT_LAYOUT,
      ...saved,
      place: { ...DEFAULT_LAYOUT.place, ...(saved.place ?? {}) },
      order,
      zOrder: (saved.zOrder ?? []).filter((id) => known.has(id)),
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(l))
  } catch {
    /* ignore */
  }
}

export const panelsIn = (l: Layout, place: Place) => l.order.filter((id) => l.place[id] === place)

/** Where a new floating window appears: cascading from the top-right of the workspace, clear of the sidebar. */
const SIDEBAR_W = 330
function defaultRect(l: Layout, id: PanelId): FloatRect {
  const { w, h } = metaOf(id).floatSize
  const n = Object.values(l.open).filter(Boolean).length
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1400
  return { x: Math.max(20, vw - SIDEBAR_W - w - 24 - n * 28), y: 110 + n * 28, w, h }
}

export function movePanel(l: Layout, id: PanelId, place: Place): Layout {
  const next: Layout = { ...l, place: { ...l.place, [id]: place } }
  if (place === 'float') {
    next.open = { ...l.open, [id]: true }
    next.rects = { ...l.rects, [id]: l.rects[id] ?? defaultRect(l, id) }
    next.zOrder = [...l.zOrder.filter((x) => x !== id), id]
  }
  if (place === 'sidebar') next.tab = id
  else if (l.tab === id) next.tab = panelsIn(next, 'sidebar')[0] ?? null
  return next
}

export function toggleFloat(l: Layout, id: PanelId): Layout {
  const open = !l.open[id]
  return {
    ...l,
    open: { ...l.open, [id]: open },
    rects: { ...l.rects, [id]: l.rects[id] ?? defaultRect(l, id) },
    zOrder: open ? [...l.zOrder.filter((x) => x !== id), id] : l.zOrder,
  }
}

export function raise(l: Layout, id: PanelId): Layout {
  if (l.zOrder[l.zOrder.length - 1] === id) return l
  return { ...l, zOrder: [...l.zOrder.filter((x) => x !== id), id] }
}

/** Moves `id` before `before` (or to the end) in the shared order. */
export function reorder(l: Layout, id: PanelId, before: PanelId | null): Layout {
  const rest = l.order.filter((x) => x !== id)
  const i = before ? rest.indexOf(before) : rest.length
  rest.splice(i < 0 ? rest.length : i, 0, id)
  return { ...l, order: rest }
}
