import type { TabScore } from './model.ts'
import type { TabAnchor, TabSync } from './sync.ts'

/**
 * Tag on every job. alphaTab, loaded in the worker, sees it is in a worker and listens to its messages
 * too, reading `cmd` as a string; with this one its handlers ignore our jobs.
 */
export const TAB_CMD = 'musikatu.tab'

export type TabJob =
  | { id: number; cmd: typeof TAB_CMD; type: 'parse'; bytes: Uint8Array }
  | {
      id: number
      cmd: typeof TAB_CMD
      type: 'sync'
      score: TabScore
      /** What to match against: the guitar and bass stems, or the mix. */
      mono: Float32Array
      sampleRate: number
      a4: number
      beats: number[]
      downbeats: number[]
      anchors: TabAnchor[]
    }

export type TabJobMessage =
  | { id: number; type: 'progress'; fraction: number }
  | { id: number; type: 'parsed'; score: TabScore }
  | { id: number; type: 'synced'; sync: TabSync }
  | { id: number; type: 'error'; message: string }

