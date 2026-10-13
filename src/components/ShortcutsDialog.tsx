import { useEffect, useRef, useState } from 'react'
import { ACTIONS, comboFromEvent, defaultBindings, formatCombo, formatMidi, isRiskyGlobal, type Bindings } from '../shortcuts'
import type { MidiStatus } from '../midi'
import { Btn } from './Controls'

export type Capture = { id: string; field: 'key' | 'global' | 'midi' } | null

interface Props {
  bindings: Bindings
  onBindings: (b: Bindings) => void
  globalEnabled: boolean
  onGlobalEnabled: (on: boolean) => void
  globalFailures: string[]
  hasElectron: boolean
  midi: { status: MidiStatus; inputs: string[] }
  /** The parent routes the next MIDI press here while learning. */
  capture: Capture
  onCapture: (c: Capture) => void
  onClose: () => void
}

const GROUPS = [...new Set(ACTIONS.map((a) => a.group))]

export function ShortcutsDialog(p: Props) {
  const [conflict, setConflict] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const latest = useRef(p)
  latest.current = p

  // Capture key presses (in the capture phase, ahead of the global handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { capture, bindings, onBindings, onCapture, onClose } = latest.current
      if (!capture || capture.field === 'midi') {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          if (capture) onCapture(null)
          else onClose()
        }
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey) return onCapture(null)
      if (e.key === 'Backspace' && !e.ctrlKey && !e.altKey) {
        onBindings({ ...bindings, [capture.id]: { ...bindings[capture.id], [capture.field]: null } })
        return onCapture(null)
      }
      const combo = comboFromEvent(e)
      if (!combo) return
      const next = { ...bindings }
      // a combo can only drive one action per column
      let stolen: string | null = null
      for (const [id, b] of Object.entries(next)) {
        if (id !== capture.id && b[capture.field] === combo) {
          next[id] = { ...b, [capture.field]: null }
          stolen = ACTIONS.find((a) => a.id === id)?.label ?? id
        }
      }
      next[capture.id] = { ...next[capture.id], [capture.field]: combo }
      setConflict(stolen ? `${formatCombo(combo)} was removed from “${stolen}”.` : null)
      onBindings(next)
      onCapture(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  useEffect(() => dialogRef.current?.focus(), [])

  const cell = (id: string, field: 'key' | 'global' | 'midi') => {
    const b = p.bindings[id]
    const active = p.capture?.id === id && p.capture.field === field
    const value = field === 'midi' ? formatMidi(b.midi) : formatCombo(b[field])
    const risky = field === 'global' && b.global && isRiskyGlobal(b.global)
    return (
      <Btn
        className={`bind ${active ? 'capturing' : ''} ${value ? '' : 'unset'} ${risky ? 'risky' : ''}`}
        disabled={field === 'global' && !p.globalEnabled}
        onClick={() => p.onCapture(active ? null : { id, field })}
        title={risky ? 'Without Ctrl/Alt this key stops working in every other app while Musikatu runs' : undefined}
      >
        {active ? (field === 'midi' ? 'Press pedal / pad…' : 'Press keys…') : value || '—'}
      </Btn>
    )
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && p.onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Keyboard and pedal shortcuts" tabIndex={-1} ref={dialogRef}>
        <header className="modal-head">
          <h2>Keyboard &amp; pedal shortcuts</h2>
          <Btn className="small" onClick={p.onClose}>
            Done
          </Btn>
        </header>
        <div className="modal-options">
          <label className={`check ${p.hasElectron ? '' : 'disabled'}`}>
            <input type="checkbox" checked={p.globalEnabled} disabled={!p.hasElectron} onChange={(e) => p.onGlobalEnabled(e.target.checked)} />
            Global hotkeys — work while another app (notation software, DAW) has focus
          </label>
          <span className="muted">
            MIDI:{' '}
            {p.midi.status === 'ready'
              ? p.midi.inputs.length
                ? p.midi.inputs.join(', ')
                : 'no devices connected'
              : p.midi.status === 'pending'
                ? 'connecting…'
                : 'unavailable'}
          </span>
        </div>
        {p.globalFailures.length > 0 && p.globalEnabled && (
          <p className="warning">
            Couldn’t register: {p.globalFailures.join(', ')}. Another app may own them, or your desktop blocks global shortcuts.
          </p>
        )}
        {conflict && <p className="notice">{conflict}</p>}
        <p className="muted small-text">
          Click a cell, then press the keys. <kbd>Backspace</kbd> clears, <kbd>Esc</kbd> cancels. USB foot pedals that type a key work in the Key column
          (or Global, to keep working in other apps); MIDI pedals and pads can be learned in the MIDI column.
        </p>
        <div className="shortcut-table">
          <div className="row head">
            <span>Action</span>
            <span>Key</span>
            <span>Global</span>
            <span>MIDI</span>
          </div>
          {GROUPS.map((group) => (
            <div key={group}>
              <div className="group-title">{group}</div>
              {ACTIONS.filter((a) => a.group === group).map((a) => (
                <div className="row" key={a.id}>
                  <span>{a.label}</span>
                  {cell(a.id, 'key')}
                  {cell(a.id, 'global')}
                  {cell(a.id, 'midi')}
                </div>
              ))}
            </div>
          ))}
        </div>
        <footer className="modal-foot">
          <Btn className="small" onClick={() => p.onBindings(defaultBindings())}>
            Reset all to defaults
          </Btn>
        </footer>
      </div>
    </div>
  )
}
