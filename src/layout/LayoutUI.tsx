import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Btn } from '../components/Controls'
import { metaOf, PANELS, PLACE_LABEL, type FloatRect, type Layout, type PanelId, type Place } from './layout'

const PLACES: Place[] = ['sidebar', 'bottom', 'float', 'hidden']

/** Closes a popover when clicking outside it or pressing Escape. */
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

/** "⋯" button with a menu to choose where a panel lives. */
export function PlaceMenu({ id, place, onMove, align = 'right' }: { id: PanelId; place: Place; onMove: (id: PanelId, p: Place) => void; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  return (
    <div className="place-menu" ref={ref}>
      <button type="button" className="place-trigger" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)} title={`Where to show “${metaOf(id).title}”`} aria-haspopup="menu" aria-expanded={open}>
        ⋯
      </button>
      {open && (
        <div className={`menu-pop ${align}`} role="menu">
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

// ---------- sidebar ----------

export function SidebarHost({
  ids,
  tab,
  onTab,
  dots,
  render,
  onMove,
}: {
  ids: PanelId[]
  tab: PanelId | null
  onTab: (id: PanelId) => void
  dots: Set<PanelId>
  render: (id: PanelId) => ReactNode
  onMove: (id: PanelId, p: Place) => void
}) {
  const active = tab && ids.includes(tab) ? tab : ids[0]
  return (
    <aside className="sidebar">
      <nav className="tabs" role="tablist">
        {ids.map((id) => (
          <Btn key={id} role="tab" aria-selected={active === id} className={`tab ${active === id ? 'on' : ''} ${dots.has(id) ? 'dot' : ''}`} onClick={() => onTab(id)}>
            {metaOf(id).title}
          </Btn>
        ))}
        {active && <PlaceMenu id={active} place="sidebar" onMove={onMove} />}
      </nav>
      <div className="tab-body">{active && render(active)}</div>
    </aside>
  )
}

// ---------- bottom strip ----------

export function BottomDock({ ids, render, onMove }: { ids: PanelId[]; render: (id: PanelId) => ReactNode; onMove: (id: PanelId, p: Place) => void }) {
  if (ids.length === 0) return null
  return (
    <section className="bottom-dock">
      {ids.map((id) => {
        const w = metaOf(id).bottomWidth
        // the analysis panels bring their own card styling; everything else gets a scrolling card
        const bare = id === 'keyboard' || id === 'chordGuess' || id === 'guitar'
        return (
          <div key={id} className={`dock-cell ${w === 'flex' ? 'flex' : ''}`} style={w === 'flex' ? undefined : { width: w }}>
            <div className={bare ? 'dock-bare' : 'dock-card'}>{render(id)}</div>
            <div className="dock-menu">
              <PlaceMenu id={id} place="bottom" onMove={onMove} />
            </div>
          </div>
        )
      })}
    </section>
  )
}

// ---------- floating windows ----------

const MIN_W = 200
const MIN_H = 120

function clampRect(r: FloatRect): FloatRect {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const w = Math.max(MIN_W, Math.min(r.w, vw - 16))
  const h = Math.max(MIN_H, Math.min(r.h, vh - 16))
  // keep the title bar reachable
  return { w, h, x: Math.max(8 - w + 80, Math.min(r.x, vw - 80)), y: Math.max(8, Math.min(r.y, vh - 40)) }
}

function FloatingWindow({
  id,
  rect,
  z,
  onRect,
  onClose,
  onRaise,
  onMove,
  children,
}: {
  id: PanelId
  rect: FloatRect
  z: number
  onRect: (r: FloatRect) => void
  onClose: () => void
  onRaise: () => void
  onMove: (id: PanelId, p: Place) => void
  children: ReactNode
}) {
  // live geometry while dragging; committed to the layout on release
  const [live, setLive] = useState<FloatRect | null>(null)
  // the latest geometry, readable from the release handler before React re-renders
  const liveRef = useRef<FloatRect | null>(null)
  const drag = useRef<{ mode: 'move' | 'size'; x: number; y: number; start: FloatRect } | null>(null)
  const r = clampRect(live ?? rect)

  // re-clamp when the app window shrinks
  useEffect(() => {
    const onResize = () => setLive((l) => (l ? clampRect(l) : null))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const begin = (mode: 'move' | 'size') => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    if ((e.target as HTMLElement).closest('button, select, input')) return
    e.preventDefault()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety (keeps tracking outside the bar); dragging works without it */
    }
    drag.current = { mode, x: e.clientX, y: e.clientY, start: r }
    onRaise()
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
    if (liveRef.current) onRect(clampRect(liveRef.current))
    liveRef.current = null
    setLive(null)
  }

  return (
    <div className="float-win" style={{ left: r.x, top: r.y, width: r.w, height: r.h, zIndex: 100 + z }} onPointerDownCapture={onRaise} role="dialog" aria-label={metaOf(id).title}>
      <div className="float-head" onPointerDown={begin('move')} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <span className="float-title">{metaOf(id).title}</span>
        <PlaceMenu id={id} place="float" onMove={onMove} />
        <button type="button" className="float-close" onMouseDown={(e) => e.preventDefault()} onClick={onClose} title="Close (reopen from the top bar)">
          ×
        </button>
      </div>
      <div className="float-body">{children}</div>
      <div className="float-resize" onPointerDown={begin('size')} onPointerMove={move} onPointerUp={end} onPointerCancel={end} title="Resize" />
    </div>
  )
}

export function FloatingLayer({
  layout,
  render,
  onLayout,
  onMove,
}: {
  layout: Layout
  render: (id: PanelId) => ReactNode
  onLayout: (fn: (l: Layout) => Layout) => void
  onMove: (id: PanelId, p: Place) => void
}) {
  const ids = layout.order.filter((id) => layout.place[id] === 'float' && layout.open[id])
  return (
    <>
      {ids.map((id) => (
        <FloatingWindow
          key={id}
          id={id}
          rect={layout.rects[id] ?? { x: 200, y: 80, ...metaOf(id).floatSize }}
          z={Math.max(0, layout.zOrder.indexOf(id))}
          onRect={(rect) => onLayout((l) => ({ ...l, rects: { ...l.rects, [id]: rect } }))}
          onClose={() => onLayout((l) => ({ ...l, open: { ...l.open, [id]: false } }))}
          onRaise={() => onLayout((l) => (l.zOrder[l.zOrder.length - 1] === id ? l : { ...l, zOrder: [...l.zOrder.filter((x) => x !== id), id] }))}
          onMove={onMove}
        >
          {render(id)}
        </FloatingWindow>
      ))}
    </>
  )
}

// ---------- top bar: floating-panel buttons and the Panels menu ----------

export function PanelsBar({
  layout,
  dots,
  onToggle,
  onMove,
  onReset,
}: {
  layout: Layout
  dots: Set<PanelId>
  onToggle: (id: PanelId) => void
  onMove: (id: PanelId, p: Place) => void
  onReset: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useDismiss(open, () => setOpen(false))
  const floating = layout.order.filter((id) => layout.place[id] === 'float')
  return (
    <div className="panels-bar">
      {floating.map((id) => (
        <Btn key={id} className={`small panel-toggle ${layout.open[id] ? 'on' : ''} ${dots.has(id) ? 'dot' : ''}`} onClick={() => onToggle(id)} title={`Show / hide the ${metaOf(id).title} window`} aria-pressed={!!layout.open[id]}>
          {metaOf(id).title}
        </Btn>
      ))}
      <div className="place-menu" ref={ref}>
        <Btn className={`small ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} title="Choose where each panel lives" aria-haspopup="dialog" aria-expanded={open}>
          Panels ▾
        </Btn>
        {open && (
          <div className="menu-pop right panels-pop" role="dialog" aria-label="Panel layout">
            <div className="menu-title">Where each panel lives</div>
            <div className="panels-grid">
              <span />
              {PLACES.map((pl) => (
                <span key={pl} className="panels-col">
                  {pl === 'sidebar' ? 'Side' : pl === 'bottom' ? 'Bottom' : pl === 'float' ? 'Window' : 'Hidden'}
                </span>
              ))}
              {PANELS.map((p) => (
                <PanelRow key={p.id} id={p.id} place={layout.place[p.id]} onMove={onMove} />
              ))}
            </div>
            <div className="button-row panels-foot">
              <span className="muted small-text">Also from each panel’s ⋯ menu.</span>
              <Btn className="small" onClick={onReset}>
                Reset layout
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PanelRow({ id, place, onMove }: { id: PanelId; place: Place; onMove: (id: PanelId, p: Place) => void }) {
  return (
    <>
      <span className="panels-name">{metaOf(id).title}</span>
      {PLACES.map((pl) => (
        <label key={pl} className="panels-cell" title={`${metaOf(id).title}: ${PLACE_LABEL[pl]}`}>
          <input type="radio" name={`place-${id}`} checked={place === pl} onChange={() => onMove(id, pl)} />
        </label>
      ))}
    </>
  )
}
