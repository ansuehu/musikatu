/**
 * Guitar Pro (.gp3/.gp4/.gp5/.gpx/.gp), MusicXML and alphaTex import through alphaTab (MPL-2.0). Only
 * this module loads alphaTab, and it runs in the tab worker, so the library stays out of the main bundle.
 */
import * as alphaTab from '@coderline/alphatab'
import type { TabBar, TabBeat, TabDirection, TabScore, TabTrack } from './model.ts'

type Score = alphaTab.model.Score

/** Reads a tab file. Throws with a readable message when the format isn't recognised. */
export function loadTab(bytes: Uint8Array): TabScore {
  const settings = new alphaTab.Settings()
  let score: Score
  try {
    score = alphaTab.importer.ScoreLoader.loadScoreFromBytes(bytes, settings)
  } catch (err) {
    // alphaTex is plain text, which the binary loader doesn't try
    const text = new TextDecoder().decode(bytes.subarray(0, 4096))
    if (!/\\(title|track|tempo|ts)\b|^\s*[\\.:]/m.test(text)) throw new Error(`Not a tab file this app can read (${err instanceof Error ? err.message : String(err)})`)
    score = alphaTab.importer.ScoreLoader.loadAlphaTex(new TextDecoder().decode(bytes), settings)
  }
  return fromAlphaTab(score)
}

export function fromAlphaTab(score: Score): TabScore {
  const Direction = alphaTab.model.Direction
  const bars: TabBar[] = score.masterBars.map((mb) => ({
    num: mb.timeSignatureNumerator,
    den: mb.timeSignatureDenominator,
    ticks: mb.calculateDuration(),
    repeatStart: mb.isRepeatStart,
    repeatEnd: mb.isRepeatEnd ? Math.max(2, mb.repeatCount) : 0,
    endings: mb.alternateEndings,
    section: mb.section ? mb.section.text || mb.section.marker || 'Section' : null,
    directions: [...(mb.directions ?? [])].map((d) => Direction[d].replace(/^Target|^Jump/, '') as TabDirection),
  }))
  const tracks: TabTrack[] = score.tracks.map((t) => {
    const staff = t.staves[0]
    const percussion = t.staves.some((s) => s.isPercussion) || t.playbackInfo.primaryChannel === 9
    const merged: TabBeat[][] = score.masterBars.map((_, i) => {
      const beats: TabBeat[] = []
      for (const s of t.staves)
        for (const v of s.bars[i]?.voices ?? [])
          for (const b of v.beats) {
            if (b.isRest && !b.notes.length) continue
            beats.push({
              start: b.playbackStart,
              duration: b.playbackDuration,
              notes: percussion
                ? []
                : b.notes.map((n) => ({ string: n.string, fret: n.fret, midi: n.realValue, tie: n.isTieDestination, dead: n.isDead })),
            })
          }
      return beats.sort((a, b) => a.start - b.start)
    })
    return { name: t.name || `Track ${t.index + 1}`, tuning: [...staff.tuning].reverse(), capo: staff.capo, percussion, bars: merged }
  })
  return { title: score.title, artist: score.artist, tempo: score.tempo, bars, tracks }
}
