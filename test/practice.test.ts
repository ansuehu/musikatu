import { test } from 'node:test'
import assert from 'node:assert/strict'
import { onLoopPass, startTrainer, trainerProgress, type TrainerSettings } from '../src/practice/trainer.ts'

const run = (s: TrainerSettings, passes: number) => {
  let st = startTrainer(s)
  const speeds = [st.speed]
  for (let i = 0; i < passes; i++) {
    st = onLoopPass(st, s)
    speeds.push(st.speed)
  }
  return { st, speeds }
}

test('steps up every N passes and holds at the target', () => {
  const s: TrainerSettings = { from: 0.6, to: 0.75, step: 0.05, every: 2, atTarget: 'hold' }
  const { st, speeds } = run(s, 8)
  assert.deepEqual(speeds, [0.6, 0.6, 0.65, 0.65, 0.7, 0.7, 0.75, 0.75, 0.75])
  assert.equal(st.active, true)
  assert.equal(st.pass, 8)
  assert.equal(trainerProgress(st, s), 1)
})

test('restart goes back to the start speed after the target passes', () => {
  const s: TrainerSettings = { from: 0.5, to: 0.6, step: 0.1, every: 1, atTarget: 'restart' }
  assert.deepEqual(run(s, 4).speeds, [0.5, 0.6, 0.5, 0.6, 0.5])
})

test('stop ends the session after the passes at the target', () => {
  const s: TrainerSettings = { from: 0.9, to: 1, step: 0.1, every: 2, atTarget: 'stop' }
  const { st, speeds } = run(s, 4)
  assert.deepEqual(speeds, [0.9, 0.9, 1, 1, 1])
  assert.equal(st.stop, true)
  assert.equal(st.active, false)
})

test('the last step never overshoots, and a downward ramp works', () => {
  assert.deepEqual(run({ from: 0.6, to: 0.72, step: 0.05, every: 1, atTarget: 'hold' }, 4).speeds, [0.6, 0.65, 0.7, 0.72, 0.72])
  assert.deepEqual(run({ from: 1, to: 0.8, step: 0.1, every: 1, atTarget: 'hold' }, 3).speeds, [1, 0.9, 0.8, 0.8])
})
