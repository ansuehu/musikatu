import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioEngine } from '../audio/AudioEngine'
import { buildPeaks, type Peaks } from '../waveform/peaks'
import { STEM_NAMES, type Benchmark, type CacheDirInfo, type CacheEntry, type Device, type StemName, type StemsInfo, type StemsMeta } from './types'

export interface LoadedStem {
  name: StemName
  buffer: AudioBuffer
  peaks: Peaks
}

export type StemsStatus =
  | { kind: 'idle' }
  | { kind: 'downloading'; received: number; total: number }
  | { kind: 'preparing' }
  | { kind: 'benchmark' }
  | { kind: 'loading'; device: string }
  | { kind: 'running'; done: number; total: number; label: string; elapsed: number }
  | { kind: 'decoding' }
  | { kind: 'ready'; meta: StemsMeta }
  | { kind: 'error'; message: string }

interface Args {
  engine: AudioEngine | null
  buffer: AudioBuffer | null
  projectId: string | null
}

/** Renders `buffer` to 44.1 kHz stereo, the model's input format. */
async function toModelInput(buffer: AudioBuffer, sampleRate: number): Promise<[Float32Array, Float32Array]> {
  const length = Math.ceil(buffer.duration * sampleRate)
  const ctx = new OfflineAudioContext(2, length, sampleRate)
  const src = new AudioBufferSourceNode(ctx, { buffer })
  src.connect(ctx.destination)
  src.start()
  const out = await ctx.startRendering()
  return [out.getChannelData(0), out.getChannelData(1)]
}

/** Decoded stems can differ from the mix by a sample after resampling; pad or trim to match exactly. */
function fitLength(buffer: AudioBuffer, length: number): AudioBuffer {
  if (buffer.length === length) return buffer
  const out = new AudioBuffer({ length, numberOfChannels: buffer.numberOfChannels, sampleRate: buffer.sampleRate })
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(0, length), c)
  return out
}

export function useStems({ engine, buffer, projectId }: Args) {
  const api = typeof window !== 'undefined' ? window.api?.stems : undefined
  const [info, setInfo] = useState<StemsInfo | null>(null)
  const [status, setStatus] = useState<StemsStatus>({ kind: 'idle' })
  const [stems, setStems] = useState<LoadedStem[] | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [cache, setCache] = useState<CacheEntry[] | null>(null)
  const [cacheDirInfo, setCacheDirInfo] = useState<CacheDirInfo | null>(null)
  const [cacheMove, setCacheMove] = useState<{ done: number; total: number } | null>(null)
  // Guards async work against the user switching files mid-way.
  const token = useRef(0)

  const refreshInfo = useCallback(async () => {
    if (api) setInfo(await api.info())
  }, [api])

  useEffect(() => {
    void refreshInfo()
  }, [refreshInfo])

  const refreshCache = useCallback(async () => {
    if (!api) return
    const [list, dir] = await Promise.all([api.cacheList(), api.cacheDir()])
    setCache(list)
    setCacheDirInfo(dir)
  }, [api])

  useEffect(() => {
    void refreshCache()
  }, [refreshCache])

  useEffect(() => {
    if (!api) return
    return api.onEvent((e) => {
      if (e.type === 'download') setStatus({ kind: 'downloading', received: e.received, total: e.total })
      else if (e.type === 'phase') setStatus(e.phase === 'benchmark' ? { kind: 'benchmark' } : { kind: 'loading', device: e.device ?? '' })
      else if (e.type === 'progress') setStatus({ kind: 'running', done: e.done, total: e.total, label: e.label, elapsed: e.elapsed })
      else if (e.type === 'notice') setNotice(e.text)
      else if (e.type === 'cacheMove') setCacheMove(e.done < e.total ? { done: e.done, total: e.total } : null)
    })
  }, [api])

  const attach = useCallback(
    async (key: string, my: number) => {
      if (!api || !engine || !buffer) return false
      const cached = await api.load(key)
      if (!cached || my !== token.current) return false
      setStatus({ kind: 'decoding' })
      const byName = new Map(cached.stems.map((s) => [s.name, s.data]))
      const loaded: LoadedStem[] = []
      for (const name of STEM_NAMES) {
        const data = byName.get(name)
        if (!data) return false
        const decoded = await engine.decode(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer)
        if (my !== token.current) return false
        const fitted = fitLength(decoded, buffer.length)
        loaded.push({ name, buffer: fitted, peaks: buildPeaks(fitted) })
      }
      engine.addLayers(loaded.map((s) => s.buffer))
      setStems(loaded)
      setStatus({ kind: 'ready', meta: cached.meta })
      return true
    },
    [api, engine, buffer],
  )

  // New file: drop the old stems and pick up cached ones if this file was separated before.
  useEffect(() => {
    const my = ++token.current
    setStems(null)
    setNotice(null)
    setStatus({ kind: 'idle' })
    if (projectId) void attach(projectId, my)
  }, [projectId, attach])

  const separate = useCallback(async () => {
    if (!api || !buffer || !projectId || !info) return
    const my = ++token.current
    setNotice(null)
    setStatus({ kind: 'preparing' })
    try {
      const [left, right] = await toModelInput(buffer, info.sampleRate)
      await api.separate(projectId, left, right)
      if (my !== token.current) return
      if (!(await attach(projectId, my))) throw new Error('The separated stems could not be loaded.')
      void refreshInfo()
      void refreshCache()
    } catch (err) {
      if (my !== token.current) return
      const message = String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setStatus(/Cancelled/.test(message) ? { kind: 'idle' } : { kind: 'error', message })
    }
  }, [api, buffer, projectId, info, attach, refreshInfo, refreshCache])

  const cancel = useCallback(async () => {
    await api?.cancel()
  }, [api])

  const download = useCallback(async () => {
    if (!api) return
    setStatus({ kind: 'downloading', received: 0, total: info?.model.size ?? 0 })
    try {
      await api.downloadModel()
      setStatus({ kind: 'idle' })
    } catch (err) {
      const message = String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setStatus(/abort/i.test(message) ? { kind: 'idle' } : { kind: 'error', message })
    }
    void refreshInfo()
  }, [api, info, refreshInfo])

  const importModel = useCallback(async () => {
    if (!api) return
    try {
      await api.importModel()
    } catch (err) {
      setStatus({ kind: 'error', message: String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    }
    void refreshInfo()
  }, [api, refreshInfo])

  const setPreference = useCallback(
    async (p: Device) => {
      await api?.setPreference(p)
      void refreshInfo()
    },
    [api, refreshInfo],
  )

  const [benchmarking, setBenchmarking] = useState(false)
  const rebenchmark = useCallback(async (): Promise<Benchmark | null> => {
    if (!api) return null
    setBenchmarking(true)
    try {
      return await api.benchmark()
    } finally {
      setBenchmarking(false)
      void refreshInfo()
    }
  }, [api, refreshInfo])


  /** The open song's stems were deleted from disk: unload them so nothing points at missing files. */
  const unloadCurrent = useCallback(() => {
    token.current++
    setStems(null)
    setStatus({ kind: 'idle' })
  }, [])

  const clearCache = useCallback(async () => {
    if (!api) return
    await api.clearCache()
    unloadCurrent()
    void refreshInfo()
    void refreshCache()
  }, [api, refreshInfo, refreshCache, unloadCurrent])

  const deleteCached = useCallback(
    async (entry: CacheEntry) => {
      if (!api) return
      try {
        await api.cacheDelete(entry.id)
      } catch (err) {
        setNotice(String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
        return
      }
      if (entry.key && entry.key === projectId) unloadCurrent()
      void refreshInfo()
      void refreshCache()
    },
    [api, projectId, refreshInfo, refreshCache, unloadCurrent],
  )

  const moveCache = useCallback(
    async (to: 'choose' | 'default') => {
      if (!api) return
      try {
        const r = to === 'choose' ? await api.chooseCacheDir() : await api.resetCacheDir()
        if (r) setCacheDirInfo(r)
      } catch (err) {
        setNotice(`Couldn’t move the cache: ${String(err instanceof Error ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`)
      } finally {
        setCacheMove(null)
        void refreshInfo()
        void refreshCache()
      }
    },
    [api, refreshInfo, refreshCache],
  )

  return {
    available: !!api,
    info,
    status,
    stems,
    notice,
    benchmarking,
    separate,
    cancel,
    download,
    cancelDownload: () => void api?.cancelDownload(),
    importModel,
    setPreference,
    rebenchmark,
    clearCache,
    cache,
    cacheDirInfo,
    cacheMove,
    refreshCache,
    deleteCached,
    moveCache,
    openCacheDir: () => void api?.openCacheDir(),
    exportStems: (baseName: string) => (projectId && api ? api.exportStems(projectId, baseName) : Promise.resolve(null)),
  }
}

export type StemsController = ReturnType<typeof useStems>
