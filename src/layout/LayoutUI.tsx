import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Btn } from '../components/Controls'
import { metaOf, PLACE_LABEL, SIZE_LIMITS, type Layout, type PanelId, type Place, type Rect } from './layout'

// ======================= drag and drop =======================

export interface DropTarget {
  place: Place
  /** Insert before this panel; null = at the end of the place. */
  before: PanelId | null
}

interface DragState {
  id: PanelId
  x: number
  y: number
  target: DropTarget | null
}

let dragState: DragState | null = null
const dragListeners = new Set<() => void>()
const setDrag = (s: DragState | null) => {
  dragState = s
  for (const l of dragListeners) l()
}
const subscribeDrag = (l: () => void) => {
  dragListeners.add(l)
  return () => dragListeners.delete(l)
}
export const useDragState = () => useSyncExternalStore(subscribeDrag, () => dragState)

let dropHandler: ((id: PanelId, t: DropTarget) => void) | null = null

/**
 * Where a drop at (x, y) would land: the nearest element marked `data-drop` (a place), refined by
 * `data-drop-item` children (insert before or after them depending on which half is under the pointer).
 */
function targetAt(x: number, y: number): DropTarget | null {
  for (const el of document.elementsFromPoint(x, y)) {
    const h = el as HTMLElement
    const item = h.closest<HTMLElement>('[data-drop-item]')
    if (item) {
      const place = item.dataset.dropPlace as Place
      const r = item.getBoundingClientRect()
      const vertical = item.dataset.dropAxis === 'y'
      const after = vertical ? y > r.top + r.height / 2 : x > r.left + r.width / 2
      return { place, before: after ? ((item.dataset.dropNext as PanelId) || null) : (item.dataset.dropItem as PanelId) }
    }
    const zone = h.closest<HTMLElement>('[data-drop]')
    if (zone) return { place: zone.dataset.drop as Place, before: null }
  }
  return null
}

/**
 * Pointer handlers for anything that can be dragged as panel `id`. A press that doesn't move more than
 * a few pixels is a click (`onClick`); otherwise the panel follows the pointer until it's dropped.
 */
export function dragHandle(id: PanelId, onClick?: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return
      if ((e.target as HTMLElement).closest('.place-menu, .float-close, input, select')) return
      const x0 = e.clientX
      const y0 = e.clientY
      let dragging = false
      const stop = () => {
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', up, true)
        window.removeEventListener('keydown', esc, true)
      }
      const move = (ev: PointerEvent) => {
        if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return
        dragging = true
        ev.preventDefault()
        setDrag({ id, x: ev.clientX, y: ev.clientY, target: targetAt(ev.clientX, ev.clientY) })
      }
      const up = (ev: PointerEvent) => {
        stop()
        if (!dragging) return onClick?.()
        const t = targetAt(ev.clientX, ev.clientY)
        setDrag(null)
        if (t) dropHandler?.(id, t)
      }
      const esc = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        ev.stopPropagation()
        stop()
        setDrag(null)
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', up, true)
      window.addEventListener('keydown', esc, true)
    },
  }
}

/** Drop-target attributes for one item of a place (a tab or a bottom-strip panel). */
const dropItem = (place: Place, id: PanelId, next: PanelId | undefined) => ({
  'data-drop-item': id,
  'data-drop-place': place,
  'data-drop-next': next ?? '',
})

/** Is the current drop target "before `id` in `place`" (or the end of `place` when id is null)? */
function useInsertMarker(place: Place, id: PanelId | null): boolean {
  const d = useDragState()
  return !!d?.target && d.target.place === place && d.target.before === id && d.id !== id
}

/**
 * The drag preview, the drop handler, and temporary drop zones for places that aren't on screen right
 * now (sidebar closed or empty, empty bottom strip).
 */
export function DragLayer({ onDrop, sidebarVisible, bottomVisible }: { onDrop: (id: PanelId, t: DropTarget) => void; sidebarVisible: boolean; bottomVisible: boolean }) {
  dropHandler = onDrop
  const d = useDragState()
  useEffect(() => {
    document.body.classList.toggle('panel-dragging', !!d)
  }, [d])
  if (!d) return null
  const hover = (p: Place) => d.target?.place === p
  return (
    <>
      {!sidebarVisible && (
        <div className={`drop-zone side ${hover('sidebar') ? 'hover' : ''}`} data-drop="sidebar">
          Sidebar
        </div>
      )}
      {!bottomVisible && (
        <div className={`drop-zone bottom ${hover('bottom') ? 'hover' : ''}`} data-drop="bottom">
          Bottom strip
        </div>
      )}
      <div className="drag-ghost" style={{ left: d.x + 14, top: d.y + 10 }}>
        {metaOf(d.id).title}
        <span className="drag-ghost-target">{d.target ? `→ ${PLACE_LABEL[d.target.place]}` : 'drop on a highlighted area'}</span>
      </div>
    </>
  )
}

// ======================= ⋯ menu =======================

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])
  return ref
}

const PLACES: Place[] = ['sidebar', 'bottom', 'tools']

/** "⋯" menu to move a panel elsewhere (dragging does the same). */
export function PlaceMenu({ id, place, onMove }: { id: PanelId; place: Place; onMove: (id: PanelId, p: Place) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="place-menu" ref={ref}>
      <button type="button" className="place-trigger" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} title={`Move “${metaOf(id).title}” (or drag it)`} aria-haspopup="menu" aria-expanded={open}>
        ⋯
      </button>
      {open && (
        <div className="menu-pop right" role="menu">
          <div className="menu-title">Show {metaOf(id).title} in</div>
          {PLACES.map((pl) => (
            <button
              key={pl}
              type="button"
              role="menuitemradio"
              aria-checked={place === pl}
              className={`menu-item ${place === pl ? 'on' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setOpen(false)
                if (pl !== place) onMove(id, pl)
              }}
            >
              <span className="check-mark">{place === pl ? '✓' : ''}</span>
              {PLACE_LABEL[pl]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ======================= resizing =======================

/** One resizable dimension: how to read it, its limits (read when a drag starts) and how to set it. */
interface Axis {
  size: () => number
  limits: () => [number, number]
  /** Live update while dragging: change the DOM directly, no React render per pointer move. */
  apply: (v: number) => void
  /** The final size, or null to reset it (double-click). */
  commit: (v: number | null) => void
}

type HandleSide = 'left' | 'right' | 'top' | 'top-left' | 'top-right'

/**
 * A thin edge, or a corner, you drag to resize the element it sits on. Edges change one dimension; corners
 * change both (`x` and `y`). Pointer travel towards the outside of the element makes it bigger.
 */
function ResizeHandle({ side, x, y, title }: { side: HandleSide; x?: Axis; y?: Axis; title: string }) {
  const xSign = side.endsWith('left') ? -1 : 1
  return (
    <div
      className={`resize-edge ${side}`}
      title={`${title} (double-click to reset)`}
      onDoubleClick={() => {
        x?.commit(null)
        y?.commit(null)
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        const axes = [
          x && { axis: x, start: x.size(), lim: x.limits(), delta: (ev: PointerEvent) => xSign * (ev.clientX - e.clientX) },
          y && { axis: y, start: y.size(), lim: y.limits(), delta: (ev: PointerEvent) => e.clientY - ev.clientY },
        ].filter((a) => !!a)
        const values = axes.map((a) => a.start)
        const cls = x && y ? (side === 'top-left' ? 'resizing-nw' : 'resizing-ne') : x ? 'resizing-x' : 'resizing-y'
        document.body.classList.add(cls)
        const move = (ev: PointerEvent) =>
          axes.forEach((a, i) => {
            values[i] = Math.round(Math.max(a.lim[0], Math.min(a.lim[1], a.start + a.delta(ev))))
            a.axis.apply(values[i])
          })
        const up = () => {
          window.removeEventListener('pointermove', move, true)
          window.removeEventListener('pointerup', up, true)
          document.body.classList.remove(cls)
          axes.forEach((a, i) => values[i] !== a.start && a.axis.commit(values[i]))
        }
        window.addEventListener('pointermove', move, true)
        window.addEventListener('pointerup', up, true)
      }}
    />
  )
}

// ======================= tabs (sidebar and Tools window) =======================

function PanelTab({ place, id, next, active, dot, onTab }: { place: Place; id: PanelId; next: PanelId | undefined; active: boolean; dot: boolean; onTab: (id: PanelId) => void }) {
  const marker = useInsertMarker(place, id)
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`btn tab ${active ? 'on' : ''} ${dot ? 'dot' : ''} ${marker ? 'insert-before' : ''}`}
      onMouseDown={(e) => e.preventDefault()}
      {...dropItem(place, id, next)}
      {...dragHandle(id, () => onTab(id))}
      title={place === 'tools' ? 'Click to open · drag onto the main window to show it there' : 'Click to open · drag to move'}
    >
      {metaOf(id).title}
    </button>
  )
}

// ======================= sidebar =======================

export function SidebarHost({ ids, tab, onTab, dots, render, onMove, onResize }: { ids: PanelId[]; tab: PanelId | null; onTab: (id: PanelId) => void; dots: Set<PanelId>; render: (id: PanelId) => ReactNode; onMove: (id: PanelId, p: Place) => void; onResize: (w: number | null) => void }) {
  const active = tab && ids.includes(tab) ? tab : ids[0]
  const endMarker = useInsertMarker('sidebar', null)
  const ref = useRef<HTMLElement>(null)
  const { min, max } = SIZE_LIMITS.sidebarW
  return (
    <aside className="sidebar" data-drop="sidebar" ref={ref}>
      <ResizeHandle
        side="left"
        title="Drag to resize the sidebar"
        x={{
          size: () => ref.current!.getBoundingClientRect().width,
          limits: () => [min, Math.max(min, Math.min(max, window.innerWidth - 480))],
          apply: (v) => ref.current!.parentElement!.style.setProperty('--sidebar-w', `${v}px`),
          commit: onResize,
        }}
      />
      <nav className={`tabs ${endMarker ? 'insert-end' : ''}`} role="tablist">
        {ids.map((id, i) => (
          <PanelTab key={id} place="sidebar" id={id} next={ids[i + 1]} active={active === id} dot={dots.has(id)} onTab={onTab} />
        ))}
        {active && <PlaceMenu id={active} place="sidebar" onMove={onMove} />}
      </nav>
      <div className="tab-body">{active && render(active)}</div>
    </aside>
  )
}

// ======================= bottom strip =======================

function DockCell({ id, next, width, edge, heightAxis, render, onMove, onResize }: {
  id: PanelId
  next: PanelId | undefined
  width: number | 'flex'
  edge: 'left' | 'right' | null
  heightAxis: Axis
  render: (id: PanelId) => ReactNode
  onMove: (id: PanelId, p: Place) => void
  onResize: (id: PanelId, w: number | null) => void
}) {
  const marker = useInsertMarker('bottom', id)
  const ref = useRef<HTMLDivElement>(null)
  const widthAxis: Axis | null = edge && {
    size: () => ref.current!.getBoundingClientRect().width,
    limits: () => {
      // grow only into the space the flexible panel can give up (or the strip's free space)
      const cell = ref.current!
      const strip = cell.parentElement!
      const cells = [...strip.querySelectorAll<HTMLElement>(':scope > .dock-cell')]
      const flex = cells.find((c) => c.classList.contains('flex'))
      const used = cells.reduce((sum, c) => sum + c.getBoundingClientRect().width, 0) + 8 * (cells.length - 1)
      const slack = flex ? flex.getBoundingClientRect().width - 260 : strip.getBoundingClientRect().width - used
      const w = cell.getBoundingClientRect().width
      return [SIZE_LIMITS.cellW.min, Math.max(w, Math.min(SIZE_LIMITS.cellW.max, w + slack))]
    },
    apply: (v) => (ref.current!.style.width = `${v}px`),
    commit: (v) => onResize(id, v),
  }
  // the analysis panels bring their own card styling; everything else gets a scrolling card
  const bare = id === 'keyboard' || id === 'chordGuess' || id === 'guitar'
  return (
    <div ref={ref} className={`dock-cell ${width === 'flex' ? 'flex' : ''} ${marker ? 'insert-before' : ''}`} style={width === 'flex' ? undefined : { width }} {...dropItem('bottom', id, next)}>
      {edge && widthAxis && (
        <>
          <ResizeHandle side={edge} title={`Drag to resize ${metaOf(id).title}`} x={widthAxis} />
          <ResizeHandle side={`top-${edge}`} title={`Drag to resize ${metaOf(id).title} and the bottom strip`} x={widthAxis} y={heightAxis} />
        </>
      )}
      <div className={bare ? 'dock-bare' : 'dock-card'}>{render(id)}</div>
      <div className="dock-grip" {...dragHandle(id)} title="Drag to move this panel">
        <span className="dock-grip-title">⠿ {metaOf(id).title}</span>
        <PlaceMenu id={id} place="bottom" onMove={onMove} />
      </div>
    </div>
  )
}

export function BottomDock({ ids, widthOf, height, render, onMove, onResizeCell, onResizeHeight }: {
  ids: PanelId[]
  widthOf: (id: PanelId) => number | 'flex'
  height: number | null
  render: (id: PanelId) => ReactNode
  onMove: (id: PanelId, p: Place) => void
  onResizeCell: (id: PanelId, w: number | null) => void
  onResizeHeight: (h: number | null) => void
}) {
  const endMarker = useInsertMarker('bottom', null)
  const ref = useRef<HTMLElement>(null)
  if (ids.length === 0) return null
  const flexAt = ids.findIndex((id) => widthOf(id) === 'flex')
  const { min, max } = SIZE_LIMITS.bottomH
  const heightAxis: Axis = {
    size: () => ref.current!.getBoundingClientRect().height,
    limits: () => [min, Math.max(min, Math.min(max, window.innerHeight - 380))],
    apply: (v) => (ref.current!.style.height = `${v}px`),
    commit: onResizeHeight,
  }
  return (
    <section ref={ref} className={`bottom-dock ${endMarker ? 'insert-end' : ''}`} style={height ? { height } : undefined} data-drop="bottom">
      <ResizeHandle side="top" title="Drag to resize the bottom strip" y={heightAxis} />
      {ids.map((id, i) => (
        <DockCell
          key={id}
          id={id}
          next={ids[i + 1]}
          width={widthOf(id)}
          // the edge that faces the flexible panel, so resizing trades space with it
          edge={widthOf(id) === 'flex' ? null : flexAt >= 0 && i > flexAt ? 'left' : 'right'}
          heightAxis={heightAxis}
          render={render}
          onMove={onMove}
          onResize={onResizeCell}
        />
      ))}
    </section>
  )
}

// ======================= Tools window =======================

const MIN_W = 300
const MIN_H = 220

function clampRect(r: Rect): Rect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(MIN_W, Math.min(r.w, vw - 16))
  const h = Math.max(MIN_H, Math.min(r.h, vh - 16))
  // keep the title bar reachable
  return { w, h, x: Math.max(80 - w, Math.min(r.x, vw - 80)), y: Math.max(8, Math.min(r.y, vh - 40)) }
}

const defaultToolsRect = (): Rect => ({ x: Math.max(20, window.innerWidth - 330 - 400 - 24), y: 110, w: 400, h: 560 })

/** One movable, resizable, tabbed window holding every panel that isn't shown in the main window. */
export function ToolsWindow({
  layout,
  dots,
  render,
  onLayout,
  onMove,
  onReset,
}: {
  layout: Layout
  dots: Set<PanelId>
  render: (id: PanelId) => ReactNode
  onLayout: (fn: (l: Layout) => Layout) => void
  onMove: (id: PanelId, p: Place) => void
  onReset: () => void
}) {
  const [live, setLive] = useState<Rect | null>(null)
  // the latest geometry, readable from the release handler before React re-renders
  const liveRef = useRef<Rect | null>(null)
  const drag = useRef<{ mode: 'move' | 'size'; x: number; y: number; start: Rect } | null>(null)
  const endMarker = useInsertMarker('tools', null)

  useEffect(() => {
    const onResize = () => setLive((l) => (l ? clampRect(l) : null))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  if (!layout.toolsOpen) return null
  const rect = clampRect(live ?? layout.toolsRect ?? defaultToolsRect())
  const ids = layout.order.filter((id) => layout.place[id] === 'tools')
  const active = layout.toolsTab && ids.includes(layout.toolsTab) ? layout.toolsTab : ids[0]

  const begin = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button, select, input')) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety; dragging works without it */
    }
    drag.current = { mode, x: e.clientX, y: e.clientY, start: rect }
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    const next = d.mode === 'move' ? { ...d.start, x: d.start.x + dx, y: d.start.y + dy } : { ...d.start, w: d.start.w + dx, h: d.start.h + dy }
    liveRef.current = next
    setLive(next)
  }
  const end = () => {
    if (!drag.current) return
    drag.current = null
    const r = liveRef.current
    liveRef.current = null
    setLive(null)
    if (r) onLayout((l) => ({ ...l, toolsRect: clampRect(r) }))
  }

  return (
    <div className="float-win tools-win" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} role="dialog" aria-label="Tools">
      <div className="float-head" onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <span className="float-title">Tools</span>
        <button type="button" className="link small-link" onMouseDown={(e) => e.preventDefault()} onClick={onReset} title="Put every panel back where it started">
          Reset layout
        </button>
        <button type="button" className="float-close" onMouseDown={(e) => e.preventDefault()} onClick={() => onLayout((l) => ({ ...l, toolsOpen: false }))} title="Close (the Tools button reopens it)">
          ×
        </button>
      </div>
      <nav className={`tabs tools-tabs ${endMarker ? 'insert-end' : ''}`} role="tablist" data-drop="tools">
        {ids.map((id, i) => (
          <PanelTab key={id} place="tools" id={id} next={ids[i + 1]} active={active === id} dot={dots.has(id)} onTab={(t) => onLayout((l) => ({ ...l, toolsTab: t }))} />
        ))}
      </nav>
      <div className="float-body" data-drop="tools">
        {active ? (
          <>
            <div className="show-row">
              <span className="muted small-text">Show in main window:</span>
              <Btn className="small" onClick={() => onMove(active, 'sidebar')} title="Move this panel to the sidebar">
                Sidebar
              </Btn>
              <Btn className="small" onClick={() => onMove(active, 'bottom')} title="Move this panel to the bottom strip">
                Bottom strip
              </Btn>
            </div>
            <div className="tools-content">{render(active)}</div>
          </>
        ) : (
          <p className="empty-hint">Every panel is in the main window. Drag a tab or panel here (or use its ⋯ menu) to keep it in this window instead.</p>
        )}
      </div>
      <div className="float-resize" onPointerDown={begin('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Resize" />
    </div>
  )
}

/** Top-bar button that opens the Tools window; also a drop target for sending panels there. */
export function ToolsButton({ layout, dots, onToggle }: { layout: Layout; dots: Set<PanelId>; onToggle: () => void }) {
  const d = useDragState()
  const hover = d?.target?.place === 'tools'
  const anyDot = layout.order.some((id) => layout.place[id] === 'tools' && dots.has(id))
  const count = layout.order.filter((id) => layout.place[id] === 'tools').length
  return (
    <Btn
      className={`tools-btn ${layout.toolsOpen ? 'on' : ''} ${anyDot ? 'dot' : ''} ${hover ? 'drop-hover' : ''}`}
      onClick={onToggle}
      title={`Tools window (${count} panel${count === 1 ? '' : 's'}) — drop a panel here to move it there`}
      aria-pressed={layout.toolsOpen}
      data-drop="tools"
    >
      ⚙ Tools
    </Btn>
  )
}
