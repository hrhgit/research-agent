import type { BoardAgent, BoardIncubation, BoardOutcome } from '../board.ts'

export const statusLabels: Record<string, string> = { queued: '待安排', assessing: '评估中', accepted: '待派工', running: '进行中', waiting: '等待继续', blocked: '需处理', completed: '已完成', failed: '失败', stopped: '已停止', cancelled: '已取消' }
export const roleLabels: Record<string, string> = { scout: '侦察', runner: '执行', auditor: '复核', synthesizer: '汇总', 'tool-engineer': '工具维护' }
export const outcomeLabels: Record<BoardOutcome, string> = { active: '进行中', adopted: '已采纳', undecided: '未定', pending: '待做', abandoned: '已放弃' }
export const incubationLabels: Record<BoardIncubation['status'], string> = { incubating: '孵化中', paused: '暂停', graduated: '已毕业', stopped: '已停止' }
export const runLabels: Record<string, string> = { queued: '排队', running: '在跑', succeeded: '成功', failed: '失败', cancelled: '取消', timed_out: '超时' }
export const reasonSources = { record: '正式记录', report: '执行报告', incubation: '孵化判定' } as const
export const decisionLabels: Record<BoardIncubation['reason_code'], string> = {
  no_round: '还没有测量过，先做出第一版', invalid_round: '最近一轮没有有效测量，先修复再改设计', too_many_failures: '失败轮次达到上限',
  graduated: '达到毕业线，转入放大和完整验证', entry_gap: '首轮差距超过入场上限', cost_limit: '累计成本用完', round_limit: '轮数用完，仍未追平对照',
  stalled: '差距不再缩小', closing: '差距在缩小，继续',
}

/** Running time as m:ss, or h:mm:ss past an hour. */
export function elapsed(from: string | undefined, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(from ?? '')) / 1000))
  if (!Number.isFinite(seconds)) return ''
  const pad = (value: number) => String(value).padStart(2, '0')
  const hours = Math.floor(seconds / 3600); const minutes = Math.floor(seconds % 3600 / 60)
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`
}

export function ago(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60000)
  if (!Number.isFinite(minutes)) return ''
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return `${Math.floor(minutes / 1440)} 天前`
}

/** Ratios read as multiples of the control: 2.35 is "2.35 times the control". */
export function times(ratio: number): string {
  return `×${ratio >= 100 ? ratio.toFixed(0) : ratio >= 10 ? ratio.toFixed(1) : ratio.toFixed(2)}`
}

/** Agents grouped under the request that dispatched them, in the order the board lists them. */
export function groupAgents(agents: BoardAgent[]): Array<{ request_id: string; title: string; agents: BoardAgent[] }> {
  const groups = new Map<string, { request_id: string; title: string; agents: BoardAgent[] }>()
  for (const agent of agents) {
    const group = groups.get(agent.request_id) ?? { request_id: agent.request_id, title: agent.request_title, agents: [] }
    group.agents.push(agent); groups.set(agent.request_id, group)
  }
  return [...groups.values()]
}

export interface OfficeDesk {
  id: string; role: string
  /** How the desk is drawn: anything that is neither running nor waiting has not started. */
  state: 'running' | 'waiting' | 'queued'
  /** Row of the character in the sprite image. */
  character: number
  /** A running agent types, or reads when its work is reading; everyone else sits still. */
  pose: 'type' | 'read' | 'idle'
  /** What the agent is working on, for the speech bubble. */
  work: string
  /** The direction this work advances, written on the desk; the request title when it has no direction. */
  direction: string
  title: string
}

/** The controller's character; each role below has its own, so a role is recognisable at a glance. */
export const HUB_CHARACTER = 0
const ROLE_CHARACTERS: Record<string, number> = { scout: 1, runner: 2, auditor: 3, synthesizer: 4, 'tool-engineer': 5 }
const READING_ROLES = new Set(['scout', 'auditor'])
export const MAX_DESKS = 12

/** One desk per open agent for the pixel office, up to `max`; `hidden` counts the rest. */
export function officeDesks(agents: BoardAgent[], max = MAX_DESKS): { desks: OfficeDesk[]; hidden: number } {
  const desks = agents.slice(0, max).map((agent): OfficeDesk => {
    const state = agent.status === 'running' || agent.status === 'waiting' ? agent.status : 'queued'
    const work = (agent.candidate?.title ?? agent.instruction).replace(/\s+/g, ' ').trim()
    const direction = agent.direction ?? agent.request_title
    return {
      id: agent.assignment_id, role: agent.role, state, character: ROLE_CHARACTERS[agent.role] ?? HUB_CHARACTER,
      pose: state !== 'running' ? 'idle' : READING_ROLES.has(agent.role) ? 'read' : 'type',
      work: work.length > 60 ? `${work.slice(0, 59)}…` : work, direction,
      title: `${roleLabels[agent.role] ?? agent.role} · ${statusLabels[agent.status] ?? agent.status}\n在做：${work.length > 160 ? `${work.slice(0, 159)}…` : work}\n${agent.direction ? '方向' : '请求'}：${direction}`,
    }
  })
  return { desks, hidden: Math.max(0, agents.length - max) }
}

export interface ChartGeometry {
  width: number; height: number; left: number; right: number; baseline: number
  graduateY: number
  /** One entry per round slot, including rounds not yet run. */
  slots: Array<{ round: number; x: number; state: 'measured' | 'failed' | 'open'; y?: number; ratio?: number }>
  /** SVG path through the measured rounds, empty with fewer than two. */
  path: string
  /** The highest labelled ratio on the vertical axis. */
  top: { y: number; ratio: number }
}

/**
 * Lays out an incubation's gap ratio per round on a log scale, so a candidate that goes
 * from 100 times to 10 times the control shows the same progress as one going from 10 to 1.
 */
export function chartGeometry(item: Pick<BoardIncubation, 'rounds' | 'graduate_ratio' | 'max_rounds'>, width = 320, height = 124): ChartGeometry {
  const left = 38; const right = width - 14; const top = 14; const baseline = height - 22
  const ratios = item.rounds.filter(round => round.valid && round.ratio !== undefined && round.ratio > 0).map(round => round.ratio!)
  const highest = Math.max(...ratios, item.graduate_ratio * 2)
  const high = Math.log(highest * 1.12)
  const low = Math.log(Math.min(...ratios, item.graduate_ratio) * 0.85)
  const y = (ratio: number) => top + (high - Math.log(ratio)) / (high - low) * (baseline - 8 - top)
  const count = Math.max(item.max_rounds, item.rounds.length, 1)
  const x = (index: number) => count === 1 ? (left + right) / 2 : left + index / (count - 1) * (right - left)
  const slots: ChartGeometry['slots'] = Array.from({ length: count }, (_, index) => {
    const round = item.rounds[index]
    if (!round) return { round: index + 1, x: x(index), state: 'open' }
    if (!round.valid || round.ratio === undefined || !(round.ratio > 0)) return { round: index + 1, x: x(index), state: 'failed' }
    return { round: index + 1, x: x(index), state: 'measured', y: y(round.ratio), ratio: round.ratio }
  })
  const measured = slots.filter(slot => slot.state === 'measured')
  const fixed = (value: number) => Number(value.toFixed(1))
  return {
    width, height, left, right, baseline, graduateY: fixed(y(item.graduate_ratio)), slots: slots.map(slot => ({ ...slot, x: fixed(slot.x), ...(slot.y === undefined ? {} : { y: fixed(slot.y) }) })),
    path: measured.length > 1 ? measured.map((slot, index) => `${index ? 'L' : 'M'}${fixed(slot.x)} ${fixed(slot.y!)}`).join('') : '',
    top: { y: fixed(y(highest)), ratio: highest },
  }
}
