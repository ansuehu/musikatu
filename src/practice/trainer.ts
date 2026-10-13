/** Speed trainer: a loop that gets faster as you master it. Pure state machine (unit-tested). */

export type AtTarget = 'hold' | 'restart' | 'stop'

export interface TrainerSettings {
  /** Speeds as fractions (0.6 = 60%). */
  from: number
  to: number
  step: number
  /** Loop passes per speed step. */
  every: number
  atTarget: AtTarget
}

export const DEFAULT_TRAINER: TrainerSettings = { from: 0.6, to: 1, step: 0.05, every: 2, atTarget: 'hold' }

export interface TrainerState {
  active: boolean
  /** Completed loop passes since the trainer started. */
  pass: number
  /** Passes completed at the current speed. */
  passesAtSpeed: number
  speed: number
  /** Set when the trainer wants playback stopped (atTarget = 'stop'). */
  stop: boolean
}

export function startTrainer(s: TrainerSettings): TrainerState {
  return { active: true, pass: 0, passesAtSpeed: 0, speed: round(s.from), stop: false }
}

const round = (x: number) => Math.round(x * 100) / 100

/** One loop pass finished: maybe step the speed up, and decide what happens at the target. */
export function onLoopPass(st: TrainerState, s: TrainerSettings): TrainerState {
  if (!st.active) return st
  const pass = st.pass + 1
  const passesAtSpeed = st.passesAtSpeed + 1
  if (passesAtSpeed < s.every) return { ...st, pass, passesAtSpeed }
  const goingUp = s.to >= s.from
  const atTarget = goingUp ? st.speed >= s.to - 1e-9 : st.speed <= s.to + 1e-9
  if (!atTarget) {
    const next = goingUp ? Math.min(s.to, st.speed + s.step) : Math.max(s.to, st.speed - s.step)
    return { ...st, pass, passesAtSpeed: 0, speed: round(next) }
  }
  switch (s.atTarget) {
    case 'restart':
      return { ...st, pass, passesAtSpeed: 0, speed: round(s.from) }
    case 'stop':
      return { ...st, pass, passesAtSpeed: 0, active: false, stop: true }
    default:
      return { ...st, pass, passesAtSpeed: 0 }
  }
}

/** Progress from the start speed to the target, 0..1. */
export function trainerProgress(st: TrainerState, s: TrainerSettings): number {
  if (s.to === s.from) return 1
  return Math.max(0, Math.min(1, (st.speed - s.from) / (s.to - s.from)))
}
