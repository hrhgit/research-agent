import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_START_PROMPT, RESEARCH_PRESET, startResearch } from '../src/dsh/client/start.ts'

test('the start button opens a research-mode session with a preset draft and sends nothing itself', () => {
  const calls: unknown[][] = []
  const starter = { startSession: (...args: unknown[]) => { calls.push(args) } }

  assert.equal(startResearch(starter), true)
  assert.deepEqual(calls[0], [undefined, { agentPreset: 'research', prompt: DEFAULT_START_PROMPT, whenDraftExists: 'replace' }])
  assert.match(DEFAULT_START_PROMPT, /research_state/)
  assert.match(DEFAULT_START_PROMPT, /孵化/)

  startResearch(starter, '  继续 DQI 方向  ')
  startResearch(starter, '   ')
  assert.deepEqual(calls.slice(1).map(call => (call[1] as { prompt: string }).prompt), ['继续 DQI 方向', DEFAULT_START_PROMPT], 'A configured prompt replaces the default; a blank one does not')
  assert.equal(RESEARCH_PRESET, 'research')

  assert.equal(startResearch(undefined), false, 'A DSH build without session navigation reports that it cannot start')
  assert.equal(calls.length, 3)
})
