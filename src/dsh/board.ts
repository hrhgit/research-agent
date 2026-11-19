import type { ResearchStore } from '../store/sqlite.ts'
import type {
  JsonValue, ResearchAssignment, ResearchCandidate, ResearchIncubation, ResearchIncubationStatus, ResearchRequest,
} from '../core/types.ts'
import type { IncubationAction, IncubationRecommendation } from '../core/incubation.ts'

/** Where a line of work ended up, as the status board shows it. */
export type BoardOutcome = 'active' | 'adopted' | 'abandoned' | 'undecided' | 'pending'

export interface BoardRequest { id: string; title: string; status: ResearchRequest['status']; updated_at: string; last_error?: string }

/** One subagent assignment that has not ended, with the work it is attached to. */
export interface BoardAgent {
  assignment_id: string
  request_id: string
  request_title: string
  /** Title of the research direction this work belongs to, when it has one. */
  direction?: string
  role: ResearchAssignment['role']
  status: ResearchAssignment['status']
  instruction: string
  attempt: number
  started_at?: string
  updated_at: string
  model?: string
  candidate?: { id: string; title: string }
  /** `round` is the round this runner is producing. */
  incubation?: { id: string; title: string; round: number }
  run?: { id: string; status: string; started_at?: string; scale_stage_id?: string }
  /** Sources a scout has registered so far. */
  sources?: number
}

export interface BoardIncubationRound { index: number; valid: boolean; ratio?: number; effect?: number; cost_units: number; bottleneck: string; next_change?: string }

export interface BoardIncubation {
  id: string
  title: string
  direction_title: string
  status: ResearchIncubationStatus
  status_reason?: string
  metric: string
  graduate_ratio: number
  max_rounds: number
  max_total_cost_units: number
  rounds: BoardIncubationRound[]
  action: IncubationAction
  reason_code: IncubationRecommendation['reason_code']
  reason: string
  /** Latest measured gap ratio; above `graduate_ratio` means still behind the control. */
  ratio?: number
  best_ratio?: number
  /** Share of the remaining gap closed in the last judged window. */
  window_closure?: number
  rounds_left: number
  cost_used: number
  updated_at: string
}

export interface BoardLine {
  id: string
  kind: 'candidate' | 'incubation'
  title: string
  outcome: BoardOutcome
  /** Why it ended this way. Absent when nothing was recorded. */
  reason?: string
  /** Where the reason comes from: a formal record, the runner's own report, or the incubation's stored decision. */
  reason_source?: 'record' | 'report' | 'incubation'
  record_id?: string
  runs: number
  updated_at: string
}

export interface BoardDirection {
  direction_id?: string
  direction_title: string
  counts: Record<BoardOutcome, number>
  items: BoardLine[]
}

export interface ResearchBoard {
  generated_at: string
  requests: BoardRequest[]
  agents: BoardAgent[]
  incubations: BoardIncubation[]
  lines: BoardDirection[]
}

const ENDED_REQUESTS = new Set(['completed', 'failed', 'stopped'])
const OPEN_ASSIGNMENTS = ['running', 'waiting', 'queued']
const CANDIDATE_OUTCOME: Record<ResearchCandidate['status'], BoardOutcome> = {
  proposed: 'pending', running: 'active', succeeded: 'adopted', refuted: 'abandoned', cancelled: 'abandoned', inconclusive: 'undecided',
}
const INCUBATION_OUTCOME: Record<ResearchIncubationStatus, BoardOutcome> = {
  incubating: 'active', paused: 'active', graduated: 'adopted', stopped: 'abandoned',
}
const OUTCOME_ORDER: BoardOutcome[] = ['active', 'adopted', 'undecided', 'pending', 'abandoned']

function clip(text: string, limit = 240): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

function text(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

/** The sentence a runner's report gives for its outcome; reports are free-form, so several keys are tried. */
export function reportReason(report: JsonValue | undefined): string | undefined {
  if (typeof report === 'string') return text(report) && clip(report)
  if (!report || typeof report !== 'object' || Array.isArray(report)) return undefined
  const found = text(report.conclusion) ?? text(report.summary) ?? text(report.verdict)
    ?? (Array.isArray(report.findings) ? report.findings.map(item => text(item) ?? reportReason(item)).find(Boolean) : undefined)
  return found && clip(found)
}

type RunConclusion = ReturnType<ResearchStore['listRunConclusions']>[number]

/** Keeps the record lookup between polls; it is rebuilt when a record is added or the set of runs changes. */
export interface BoardCache { key?: string; byRun?: Map<string, RunConclusion[]> }

function conclusionsByRun(store: ResearchStore, runIds: string[], cache: BoardCache): Map<string, RunConclusion[]> {
  const key = `${store.recordStamp()}|${runIds.join(',')}`
  if (cache.key === key && cache.byRun) return cache.byRun
  const byRun = new Map<string, RunConclusion[]>()
  for (const row of store.listRunConclusions(runIds)) byRun.set(row.run_id, [...(byRun.get(row.run_id) ?? []), row])
  cache.key = key; cache.byRun = byRun
  return byRun
}

function incubationView(item: ResearchIncubation, directionTitle: string): BoardIncubation {
  return {
    id: item.id, title: item.title, direction_title: directionTitle, status: item.status, status_reason: item.status_reason,
    metric: item.policy.metric, graduate_ratio: item.policy.graduate_ratio, max_rounds: item.policy.max_rounds, max_total_cost_units: item.policy.max_total_cost_units,
    rounds: item.rounds.map(round => ({ index: round.index, valid: round.valid, ratio: round.ratio, effect: round.effect, cost_units: round.cost_units, bottleneck: round.bottleneck, next_change: round.next_change })),
    action: item.decision.action, reason_code: item.decision.reason_code, reason: item.decision.reason, ratio: item.decision.ratio, best_ratio: item.decision.best_ratio,
    window_closure: item.decision.window_closure, rounds_left: item.decision.rounds_left, cost_used: item.decision.cost_used,
    updated_at: item.updated_at,
  }
}

/**
 * Read-only summary for the status board: who is working on what, how each incubation is moving,
 * and which lines of work were adopted or abandoned. It reads recorded state and writes nothing.
 */
export function buildBoard(store: ResearchStore, cache: BoardCache = {}): ResearchBoard {
  const requests = new Map(store.listRequests({ limit: 1000 }).map(item => [item.id, item]))
  const assignments = store.listAssignments()
  const assignmentById = new Map(assignments.map(item => [item.id, item]))
  const directions = new Map(store.listDirections().map(item => [item.id, item.title]))
  const incubations = store.listIncubations({ limit: 200 })
  const incubationById = new Map(incubations.map(item => [item.id, item]))
  const directionTitle = (id?: string) => (id && directions.get(id)) || '未归入方向'

  const agents: BoardAgent[] = []
  for (const assignment of assignments) {
    if (!OPEN_ASSIGNMENTS.includes(assignment.status)) continue
    const request = requests.get(assignment.request_id) ?? store.getRequest(assignment.request_id)
    if (!request || ENDED_REQUESTS.has(request.status)) continue
    const agent: BoardAgent = {
      assignment_id: assignment.id, request_id: request.id, request_title: request.title, role: assignment.role, status: assignment.status,
      instruction: clip(assignment.instruction, 320), attempt: assignment.attempt, started_at: assignment.started_at, updated_at: assignment.updated_at,
      model: assignment.child_model ? `${assignment.child_model.provider}/${assignment.child_model.model}` : undefined,
      direction: request.direction_id ? directions.get(request.direction_id) : undefined,
    }
    if (assignment.role === 'runner') {
      const candidate = store.getCandidateForRunner(assignment.id)
      if (candidate) {
        agent.candidate = { id: candidate.id, title: candidate.title }
        agent.direction = (candidate.direction_id && directions.get(candidate.direction_id)) || agent.direction
        const incubation = candidate.incubation_id ? incubationById.get(candidate.incubation_id) ?? store.getIncubation(candidate.incubation_id) : undefined
        if (incubation) agent.incubation = { id: incubation.id, title: incubation.title, round: incubation.rounds.length + 1 }
        const run = candidate.run_ids.length ? store.getRun(candidate.run_ids.at(-1)!) : undefined
        if (run) agent.run = { id: run.id, status: run.status, started_at: run.started_at, scale_stage_id: run.scale_stage_id }
      }
    }
    if (assignment.role === 'scout') agent.sources = store.listSources({ assignment_id: assignment.id, limit: 1000 }).length
    agents.push(agent)
  }
  agents.sort((a, b) => OPEN_ASSIGNMENTS.indexOf(a.status) - OPEN_ASSIGNMENTS.indexOf(b.status) || b.updated_at.localeCompare(a.updated_at))

  const groups = new Map<string, BoardDirection>()
  const add = (directionId: string | undefined, line: BoardLine) => {
    const key = directionId && directions.has(directionId) ? directionId : ''
    let group = groups.get(key)
    if (!group) {
      group = { direction_id: key || undefined, direction_title: directionTitle(key), counts: { active: 0, adopted: 0, abandoned: 0, undecided: 0, pending: 0 }, items: [] }
      groups.set(key, group)
    }
    group.counts[line.outcome] += 1; group.items.push(line)
  }
  for (const item of incubations) {
    const reason = item.status_reason ?? (item.status === 'incubating' || item.status === 'paused' ? undefined : item.decision.reason)
    add(item.direction_id, {
      id: item.id, kind: 'incubation', title: item.title, outcome: INCUBATION_OUTCOME[item.status], runs: item.rounds.length, updated_at: item.updated_at,
      ...(reason ? { reason: clip(reason), reason_source: 'incubation' as const } : {}),
    })
  }
  // A candidate that is one round of an incubation is shown as part of that incubation's line.
  const candidates = store.listCandidates({ limit: 1000 }).filter(item => !item.incubation_id)
  const ended = candidates.filter(item => item.status !== 'proposed' && item.status !== 'running')
  const byRun = conclusionsByRun(store, [...new Set(ended.flatMap(item => item.run_ids))].sort(), cache)
  for (const candidate of candidates) {
    const line: BoardLine = { id: candidate.id, kind: 'candidate', title: candidate.title, outcome: CANDIDATE_OUTCOME[candidate.status], runs: candidate.run_ids.length, updated_at: candidate.updated_at }
    if (ended.includes(candidate)) {
      // The controller's formal record outranks the runner's own report; an experiment record outranks a review of it.
      const records = candidate.run_ids.flatMap(id => byRun.get(id) ?? []).sort((a, b) => b.created_at.localeCompare(a.created_at))
      const record = records.find(item => item.kind === 'experiment') ?? records[0]
      const report = candidate.runner_assignment_id ? reportReason((assignmentById.get(candidate.runner_assignment_id) ?? store.getAssignment(candidate.runner_assignment_id))?.report) : undefined
      if (record?.conclusion) Object.assign(line, { reason: clip(record.conclusion), reason_source: 'record', record_id: record.record_id })
      else if (report) Object.assign(line, { reason: report, reason_source: 'report' })
    }
    add(candidate.direction_id, line)
  }
  const lines = [...groups.values()]
  for (const group of lines) group.items.sort((a, b) => OUTCOME_ORDER.indexOf(a.outcome) - OUTCOME_ORDER.indexOf(b.outcome) || b.updated_at.localeCompare(a.updated_at))
  lines.sort((a, b) => b.counts.active - a.counts.active || b.items.length - a.items.length)

  return {
    generated_at: new Date().toISOString(),
    requests: [...requests.values()].filter(item => !ENDED_REQUESTS.has(item.status))
      .map(item => ({ id: item.id, title: item.title, status: item.status, updated_at: item.updated_at, last_error: item.last_error })),
    agents: agents.slice(0, 40),
    incubations: incubations.map(item => incubationView(item, directionTitle(item.direction_id)))
      .sort((a, b) => Number(INCUBATION_OUTCOME[b.status] === 'active') - Number(INCUBATION_OUTCOME[a.status] === 'active') || b.updated_at.localeCompare(a.updated_at)),
    lines,
  }
}
