import test from 'node:test'
import assert from 'node:assert/strict'
import { ago, chartGeometry, elapsed, groupAgents, HUB_CHARACTER, MAX_DESKS, officeDesks, times } from '../src/dsh/client/board-view.ts'
import type { BoardAgent, BoardIncubationRound } from '../src/dsh/board.ts'

const round = (ratio: number | undefined, index: number): BoardIncubationRound => ({ index, valid: ratio !== undefined, ratio, cost_units: 1, bottleneck: 'x' })

test('board times read as running time and as age', () => {
  const now = Date.parse('2026-11-17T12:00:00Z')
  assert.deepEqual([elapsed('2026-11-17T11:56:55Z', now), elapsed('2026-11-17T10:58:05Z', now), elapsed(undefined, now), elapsed('2026-11-17T12:00:09Z', now)], ['3:05', '1:01:55', '', '0:00'])
  assert.deepEqual(['2026-11-17T11:59:40Z', '2026-11-17T11:18:00Z', '2026-11-17T07:00:00Z', '2026-11-14T12:00:00Z', 'not a date'].map(value => ago(value, now)),
    ['刚刚', '42 分钟前', '5 小时前', '3 天前', ''])
  assert.deepEqual([times(1), times(3.168), times(12.44), times(250.6)], ['×1.00', '×3.17', '×12.4', '×251'])
})

test('agents stay grouped under the request that dispatched them', () => {
  const agent = (assignment_id: string, request_id: string) => ({ assignment_id, request_id, request_title: `Title ${request_id}` }) as BoardAgent
  assert.deepEqual(groupAgents([agent('a', 'r1'), agent('b', 'r2'), agent('c', 'r1')]).map(group => [group.title, group.agents.map(item => item.assignment_id)]),
    [['Title r1', ['a', 'c']], ['Title r2', ['b']]])
})

test('the incubation chart uses a log scale and keeps failed and unused rounds visible', () => {
  const chart = chartGeometry({ rounds: [round(100, 1), round(10, 2), round(undefined, 3), round(1, 4)], graduate_ratio: 1, max_rounds: 6 })
  assert.deepEqual(chart.slots.map(slot => slot.state), ['measured', 'measured', 'failed', 'measured', 'open', 'open'])
  const [first, second, , fourth] = chart.slots
  assert.ok(Math.abs((second!.y! - first!.y!) - (fourth!.y! - second!.y!)) < 0.2, 'Each tenfold step toward the control moves the same distance')
  assert.equal(fourth!.y, chart.graduateY, 'A round at the graduation ratio sits on the graduation line')
  assert.ok(first!.y! < second!.y! && fourth!.y! < chart.baseline, 'Closer to the control is lower, and stays above the axis')
  assert.equal(chart.path.split('L').length, 3, 'The line joins measured rounds and skips the failed one')
  assert.deepEqual([chart.slots[0]!.x, chart.slots[5]!.x], [chart.left, chart.right])

  const early = chartGeometry({ rounds: [round(3.17, 1)], graduate_ratio: 1, max_rounds: 5 })
  assert.deepEqual([early.path, early.slots.length, early.slots[0]!.ratio], ['', 5, 3.17], 'One measured round is a point, not a line')
  const none = chartGeometry({ rounds: [], graduate_ratio: 1, max_rounds: 3 })
  assert.ok(Number.isFinite(none.graduateY) && none.graduateY < none.baseline)
  const beyond = chartGeometry({ rounds: [round(2, 1), round(0.8, 2)], graduate_ratio: 1, max_rounds: 2 })
  assert.ok(beyond.slots[1]!.y! > beyond.graduateY && beyond.slots[1]!.y! < beyond.baseline, 'A round past the graduation line is drawn below it')
})

test('the pixel office gives each open agent a desk that shows its role and what it is doing', () => {
  const agent = (assignment_id: string, role: string, status: string, extra: object = {}) => ({ assignment_id, role, status, instruction: `Do ${assignment_id}`, request_title: 'Survey the lanes', ...extra }) as BoardAgent
  const { desks, hidden } = officeDesks([
    agent('a', 'runner', 'running', { candidate: { id: 'c', title: 'Swap the solver' }, direction: 'Cut total cost' }), agent('b', 'scout', 'running'), agent('c', 'auditor', 'waiting'),
    agent('d', 'synthesizer', 'queued'), agent('e', 'tool-engineer', 'running'), agent('f', 'scout', 'waiting'),
  ])
  assert.equal(hidden, 0)
  assert.deepEqual(desks.map(desk => [desk.id, desk.state, desk.pose]), [
    ['a', 'running', 'type'], ['b', 'running', 'read'], ['c', 'waiting', 'idle'], ['d', 'queued', 'idle'], ['e', 'running', 'type'], ['f', 'waiting', 'idle'],
  ], 'Only a running agent is shown working; scouts and auditors read')
  assert.equal(new Set([HUB_CHARACTER, ...desks.slice(0, 5).map(desk => desk.character)]).size, 6, 'The controller and the five roles each look different')
  assert.equal(desks[1]!.character, desks[5]!.character, 'Two agents in the same role look the same')
  assert.deepEqual([desks[0]!.work, desks[0]!.direction, desks[3]!.work, desks[3]!.direction], ['Swap the solver', 'Cut total cost', 'Do d', 'Survey the lanes'],
    'The bubble says the candidate or the instruction; the desk names the direction, or the request when there is none')
  assert.deepEqual([desks[0]!.title, desks[3]!.title], ['执行 · 进行中\n在做：Swap the solver\n方向：Cut total cost', '汇总 · 待安排\n在做：Do d\n请求：Survey the lanes'])
  const long = officeDesks([agent('g', 'scout', 'running', { instruction: `Look\n  into ${'x'.repeat(200)}` })]).desks[0]!
  assert.ok(long.work.startsWith('Look into x') && long.work.length === 60 && long.work.endsWith('…'), 'Bubble text is one flattened, clipped line')

  const many = officeDesks(Array.from({ length: 40 }, (_, index) => agent(`m${index}`, 'runner', 'queued')))
  assert.deepEqual([many.desks.length, many.hidden], [MAX_DESKS, 28])
  assert.deepEqual(officeDesks([]), { desks: [], hidden: 0 })
})
