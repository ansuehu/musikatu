import { useEffect, useRef, useState } from 'react'

export type MidiStatus = 'unsupported' | 'pending' | 'denied' | 'ready'

/**
 * Listens to every MIDI input and reports presses as "note:<n>" (note-on) or
 * "cc:<n>" (controller crossing 64 upwards, i.e. a sustain/foot pedal going down).
 */
export function useMidi(onPress: (binding: string) => void): { status: MidiStatus; inputs: string[] } {
  const [status, setStatus] = useState<MidiStatus>(() => ('requestMIDIAccess' in navigator ? 'pending' : 'unsupported'))
  const [inputs, setInputs] = useState<string[]>([])
  const handler = useRef(onPress)
  handler.current = onPress

  useEffect(() => {
    if (!('requestMIDIAccess' in navigator)) return
    let access: MIDIAccess | null = null
    let cancelled = false
    const ccState = new Map<string, number>()

    const onMessage = (e: MIDIMessageEvent) => {
      const data = e.data
      if (!data || data.length < 3) return
      const type = data[0] & 0xf0
      if (type === 0x90 && data[2] > 0) handler.current(`note:${data[1]}`)
      else if (type === 0xb0) {
        const key = `${data[0] & 0x0f}:${data[1]}`
        const prev = ccState.get(key) ?? 0
        ccState.set(key, data[2])
        if (prev < 64 && data[2] >= 64) handler.current(`cc:${data[1]}`)
      }
    }
    const attach = () => {
      if (!access) return
      const names: string[] = []
      access.inputs.forEach((input) => {
        input.onmidimessage = onMessage
        names.push(input.name ?? 'MIDI input')
      })
      setInputs(names)
    }

    navigator
      .requestMIDIAccess()
      .then((a) => {
        if (cancelled) return
        access = a
        a.onstatechange = attach
        attach()
        setStatus('ready')
      })
      .catch(() => !cancelled && setStatus('denied'))

    return () => {
      cancelled = true
      access?.inputs.forEach((input) => (input.onmidimessage = null))
      if (access) access.onstatechange = null
    }
  }, [])

  return { status, inputs }
}
