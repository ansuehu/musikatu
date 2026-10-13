import { useEffect, useRef, useState } from 'react'
import { rangeOf, type Peaks } from '../waveform/peaks'
import { DEFAULT_STEM_MIX, STEM_COLORS, STEM_LABELS, STEM_NAMES, type Device, type StemMix, type StemName } from '../stems/types'
import type { StemsController } from '../stems/useStems'
import { Btn, Slider } from './Controls'
import type { CacheEntry } from '../stems/types'

interface Props {
  ctl: StemsController
  hasFile: boolean
  fileName: string | null
  /** Seconds of audio in the current file, for time estimates. */
  duration: number
  mix: StemMix
  onMix: (m: StemMix) => void
  /** Project key of the open song, to mark it in the cache list. */
  projectId: string | null
}

const SEGMENT_S = 7.8
const STRIDE_S = SEGMENT_S * 0.75

const fmtBytes = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)
const fmtSecs = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : `${Math.max(1, Math.round(s))} s`)

const DEVICE_LABEL: Record<Device, string> = { auto: 'Auto', gpu: 'GPU', cpu: 'CPU' }

function MiniWave({ peaks, color, dim }: { peaks: Peaks; color: string; dim: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(c.clientWidth * dpr)
    c.height = Math.round(c.clientHeight * dpr)
    const g = c.getContext('2d')!
    const W = c.width
    const H = c.height
    const spp = peaks.length / W
    const r = { min: 0, max: 0, rms: 0 }
    g.clearRect(0, 0, W, H)
    g.fillStyle = color
    for (let x = 0; x < W; x++) {
      // channel 0 only: plenty for a thumbnail
      rangeOf(peaks, 0, x * spp, (x + 1) * spp, r)
      const top = H / 2 - Math.max(r.max, 0) * (H / 2)
      const bottom = H / 2 - Math.min(r.min, 0) * (H / 2)
      g.fillRect(x, top, 1, Math.max(1, bottom - top))
    }
  }, [peaks, color])
  return <canvas ref={ref} className={`mini-wave ${dim ? 'dim' : ''}`} />
}

export function StemsTab({ ctl, hasFile, fileName, duration, mix, onMix, projectId }: Props) {
  const { info, status, stems } = ctl
  const [exported, setExported] = useState<string | null>(null)

  if (!ctl.available) {
    return (
      <div className="stems-tab">
        <p className="empty-hint">Stem separation runs in the desktop app (it needs the local inference engine).</p>
      </div>
    )
  }
  if (!info) return <div className="stems-tab muted">Loading…</div>

  const busy = ['preparing', 'benchmark', 'loading', 'running', 'decoding'].includes(status.kind)
  const bench = info.benchmark
  const autoPick = bench ? (bench.gpu !== null && bench.cpu !== null && bench.gpu < bench.cpu * 0.95 ? 'gpu' : 'cpu') : null
  const perChunk = bench ? Math.min(bench.cpu ?? Infinity, info.preference === 'cpu' ? Infinity : (bench.gpu ?? Infinity)) : null
  const chunks = Math.max(1, Math.ceil(duration / STRIDE_S))
  const estimate = perChunk && Number.isFinite(perChunk) ? chunks * perChunk : null

  const setStem = (name: StemName, patch: Partial<StemMix['stems'][StemName]>) =>
    onMix({ ...mix, stems: { ...mix.stems, [name]: { ...mix.stems[name], ...patch } } })

  // ---------- model not installed ----------
  if (!info.model.installed) {
    const dl = status.kind === 'downloading' ? status : null
    return (
      <div className="stems-tab">
        <h3 className="stems-title">AI instrument splitter</h3>
        <p className="empty-hint">
          Splits a recording into <b>vocals, drums, bass, guitar, piano</b> and <b>other</b>, entirely on this computer. Nothing is uploaded. The model (
          {info.model.name}, {fmtBytes(info.model.size)}) is downloaded once.
        </p>
        {dl ? (
          <div className="progress-block">
            <div className="progress">
              <div style={{ width: `${(100 * dl.received) / Math.max(1, dl.total)}%` }} />
            </div>
            <div className="progress-row">
              <span className="muted small-text">
                {fmtBytes(dl.received)} / {fmtBytes(dl.total)}
              </span>
              <Btn className="small" onClick={ctl.cancelDownload}>
                Cancel
              </Btn>
            </div>
          </div>
        ) : (
          <div className="button-row">
            <Btn className="primary small-primary" onClick={() => void ctl.download()}>
              Download model ({fmtBytes(info.model.size)})
            </Btn>
            <Btn className="small" onClick={() => void ctl.importModel()} title="Use a copy you already have (checked by checksum)">
              Import file…
            </Btn>
          </div>
        )}
        {status.kind === 'error' && <p className="warning">{status.message}</p>}
        <p className="muted small-text">{info.model.credit}</p>
      </div>
    )
  }

  return (
    <div className="stems-tab">
      <h3 className="stems-title">AI instrument splitter</h3>

      {/* ---------- device ---------- */}
      <div className="device-row">
        <span className="label">Run on</span>
        <div className="segmented">
          {(['auto', 'gpu', 'cpu'] as Device[]).map((d) => (
            <Btn key={d} className={`small ${info.preference === d ? 'on' : ''}`} disabled={busy} onClick={() => void ctl.setPreference(d)}>
              {DEVICE_LABEL[d]}
            </Btn>
          ))}
        </div>
      </div>
      <div className="muted small-text device-note">
        {bench ? (
          <>
            Per 7.8 s chunk: CPU {bench.cpu?.toFixed(1)} s · {bench.gpu !== null ? `GPU (${gpuName(bench.gpuEp)}) ${bench.gpu.toFixed(1)} s` : 'GPU unavailable'}
            {info.preference === 'auto' && autoPick && <> → Auto uses {autoPick.toUpperCase()}</>}
            {bench.gpu === null && bench.gpuError && <span title={bench.gpuError}> ⓘ</span>}{' '}
            <button type="button" className="link small-link" disabled={busy || ctl.benchmarking} onClick={() => void ctl.rebenchmark()}>
              {ctl.benchmarking ? 'testing…' : 're-test'}
            </button>
          </>
        ) : (
          <>Auto times CPU and GPU once on first use and keeps the faster.</>
        )}
      </div>

      {/* ---------- separate / progress ---------- */}
      {!stems && !busy && (
        <>
          <Btn className="primary small-primary" disabled={!hasFile} onClick={() => void ctl.separate()}>
            Separate instruments
          </Btn>
          <span className="muted small-text">
            {hasFile ? (estimate ? `About ${fmtSecs(estimate)} for this ${fmtSecs(duration)} song.` : `${chunks} chunks to process.`) : 'Open a song first.'}
          </span>
        </>
      )}
      {busy && <Progress status={status} onCancel={() => void ctl.cancel()} />}
      {ctl.notice && <p className="notice-box">{ctl.notice}</p>}
      {status.kind === 'error' && <p className="warning">{status.message}</p>}

      {/* ---------- mixer ---------- */}
      {stems && (
        <>
          <div className="segmented wide">
            <Btn className={`small ${mix.enabled ? 'on' : ''}`} onClick={() => onMix({ ...mix, enabled: true })} title="Play the stem mix below">
              Stems
            </Btn>
            <Btn className={`small ${!mix.enabled ? 'on' : ''}`} onClick={() => onMix({ ...mix, enabled: false })} title="Play the untouched recording">
              Original
            </Btn>
          </div>
          <ul className={`stem-list ${mix.enabled ? '' : 'disabled'}`}>
            {STEM_NAMES.map((name) => {
              const s = mix.stems[name]
              const stem = stems.find((x) => x.name === name)!
              const anySolo = STEM_NAMES.some((n) => mix.stems[n].solo)
              const audible = anySolo ? s.solo : !s.mute
              return (
                <li key={name}>
                  <div className="stem-head">
                    <span className="swatch" style={{ background: STEM_COLORS[name] }} />
                    <span className="stem-name">{STEM_LABELS[name]}</span>
                    <Btn className={`small ms ${s.mute ? 'mute-on' : ''}`} onClick={() => setStem(name, { mute: !s.mute })} title="Mute">
                      M
                    </Btn>
                    <Btn className={`small ms ${s.solo ? 'solo-on' : ''}`} onClick={(e) =>
                        e.ctrlKey || e.metaKey
                          ? onMix({ ...mix, stems: Object.fromEntries(STEM_NAMES.map((n) => [n, { ...mix.stems[n], solo: n === name }])) as StemMix['stems'] })
                          : setStem(name, { solo: !s.solo })
                      } title="Solo (Ctrl/⌘-click: exclusive)">
                      S
                    </Btn>
                  </div>
                  <MiniWave peaks={stem.peaks} color={STEM_COLORS[name]} dim={!audible || !mix.enabled} />
                  <div className="stem-vol">
                    <Slider
                      min={0}
                      max={1.5}
                      step={0.01}
                      value={s.volume}
                      onChange={(e) => setStem(name, { volume: +e.target.value })}
                      onDoubleClick={() => setStem(name, { volume: 1 })}
                      aria-label={`${STEM_LABELS[name]} volume`}
                    />
                    <span className="value">{Math.round(s.volume * 100)}%</span>
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="button-row">
            <Btn className="small" onClick={() => onMix({ ...DEFAULT_STEM_MIX, enabled: mix.enabled })}>
              Reset mixer
            </Btn>
            <Btn
              className="small"
              onClick={async () => {
                try {
                  setExported(await ctl.exportStems(fileName?.replace(/\.[^.]+$/, '') ?? 'stems'))
                } catch (err) {
                  setExported(null)
                  alert(String(err))
                }
              }}
            >
              Export WAVs…
            </Btn>
          </div>
          {exported && <p className="notice">Exported to {exported}</p>}
          {status.kind === 'ready' && (
            <p className="muted small-text">
              Separated on {status.meta.backend} in {fmtSecs(status.meta.seconds)}. Soloing one stem also shows its waveform and drives the chord
              detection.
            </p>
          )}
        </>
      )}

      <CacheSection ctl={ctl} projectId={projectId} busy={busy} />
      <p className="muted small-text">{info.model.credit}</p>
    </div>
  )
}

function gpuName(ep: string | null): string {
  return { dml: 'DirectML', webgpu: 'WebGPU', cuda: 'CUDA', coreml: 'Core ML' }[ep ?? ''] ?? ep ?? 'GPU'
}

function Progress({ status, onCancel }: { status: StemsController['status']; onCancel: () => void }) {
  let text = ''
  let frac: number | null = null
  switch (status.kind) {
    case 'preparing':
      text = 'Preparing audio…'
      break
    case 'benchmark':
      text = 'Timing CPU vs GPU (first run only)…'
      break
    case 'loading':
      text = `Loading model on ${status.device.toUpperCase()}…`
      break
    case 'running': {
      frac = status.done / status.total
      const left = status.done > 0 ? (status.elapsed / status.done) * (status.total - status.done) : null
      text = `Chunk ${status.done}/${status.total} on ${status.label} · ${fmtSecs(status.elapsed)}${left !== null ? ` · ~${fmtSecs(left)} left` : ''}`
      break
    }
    case 'decoding':
      text = 'Loading stems…'
      frac = 1
      break
  }
  return (
    <div className="progress-block">
      <div className={`progress ${frac === null ? 'indeterminate' : ''}`}>
        <div style={{ width: `${(frac ?? 0.3) * 100}%` }} />
      </div>
      <div className="progress-row">
        <span className="muted small-text">{text}</span>
        {status.kind !== 'decoding' && (
          <Btn className="small" onClick={onCancel}>
            Cancel
          </Btn>
        )}
      </div>
    </div>
  )
}

const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '')

/** Cached songs (with per-song delete) and the cache folder, which can be moved. */
function CacheSection({ ctl, projectId, busy }: { ctl: StemsController; projectId: string | null; busy: boolean }) {
  const { cache, cacheDirInfo: dir, cacheMove } = ctl
  const total = (cache ?? []).reduce((s, e) => s + e.bytes, 0)
  const moving = !!cacheMove
  return (
    <div className="cache-section">
      <div className="section-title">
        <span className="label">Stem cache</span>
        <Btn className="small" onClick={ctl.openCacheDir} title="Open the cache folder in your file manager">
          Open folder
        </Btn>
      </div>

      {dir && (
        <div className="cache-dir">
          <code className="cache-path" title={dir.dir}>
            {/* the container is right-to-left so a long path keeps its end visible; the text itself stays left-to-right */}
            <span dir="ltr">{dir.dir}</span>
          </code>
          <div className="button-row">
            <Btn className="small" disabled={busy || moving} onClick={() => void ctl.moveCache('choose')} title="Pick another folder (e.g. a bigger disk); cached stems are moved there">
              Change…
            </Btn>
            {!dir.isDefault && (
              <Btn className="small" disabled={busy || moving} onClick={() => void ctl.moveCache('default')} title={`Move back to ${dir.defaultDir}`}>
                Use default
              </Btn>
            )}
          </div>
        </div>
      )}
      {moving && (
        <div className="progress-block">
          <div className="progress">
            <div style={{ width: `${(cacheMove!.done / Math.max(1, cacheMove!.total)) * 100}%` }} />
          </div>
          <span className="muted small-text">
            Moving cached songs… {cacheMove!.done}/{cacheMove!.total}
          </span>
        </div>
      )}

      {cache && cache.length === 0 && <p className="muted small-text">Nothing cached yet. Separated songs are kept here so they reopen instantly.</p>}
      {cache && cache.length > 0 && (
        <ul className="cache-list">
          {cache.map((e) => (
            <CacheRow key={e.id} entry={e} current={!!projectId && e.key === projectId} disabled={busy || moving} onDelete={() => void ctl.deleteCached(e)} />
          ))}
        </ul>
      )}

      <div className="stems-foot">
        <span className="muted small-text">
          {cache?.length ?? 0} song{cache?.length === 1 ? '' : 's'} · {fmtBytes(total)}
        </span>
        <Btn
          className="small"
          disabled={busy || moving || !cache?.length}
          onClick={() => {
            if (window.confirm(`Delete the separated stems of all ${cache?.length} songs (${fmtBytes(total)})? You can separate them again later.`)) void ctl.clearCache()
          }}
        >
          Clear all
        </Btn>
      </div>
    </div>
  )
}

function CacheRow({ entry: e, current, disabled, onDelete }: { entry: CacheEntry; current: boolean; disabled: boolean; onDelete: () => void }) {
  const details = [fmtBytes(e.bytes), e.duration ? fmtSecs(e.duration) : null, fmtDate(e.createdAt), e.backend].filter(Boolean).join(' · ')
  return (
    <li className={current ? 'current' : ''} title={e.sourcePath ?? undefined}>
      <div className="cache-main">
        <span className="cache-name">{e.name}</span>
        <span className="muted small-text">
          {current && <span className="badge">this song</span>}
          {details}
        </span>
        {e.sourceExists === false && <span className="warning-text small-text">Original file not found at its old location</span>}
        {!e.complete && <span className="warning-text small-text">Incomplete or from an older model — safe to delete</span>}
      </div>
      <Btn className="small icon" disabled={disabled} onClick={onDelete} title={current ? 'Delete these stems (the song goes back to the original recording)' : 'Delete these stems'}>
        ×
      </Btn>
    </li>
  )
}
