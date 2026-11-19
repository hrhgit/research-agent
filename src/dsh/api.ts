import type { ResearchDispatcher } from './dispatcher.ts'
import type { ResearchModelSettings } from './model-settings.ts'
import type { JsonValue, ResearchRecord } from '../core/types.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ResearchStore } from '../store/sqlite.ts'
import { buildBoard, type BoardCache } from './board.ts'
import { recommendNextScale, type AdaptiveObservation, type AdaptivePolicy } from '../core/adaptive.ts'

export class ResearchApi {
  dispatcher?: ResearchDispatcher
  modelSettings?: ResearchModelSettings
  readonly store: ResearchStore
  private readonly boardCache: BoardCache = {}
  constructor(store: ResearchStore) { this.store = store }

  state() { return this.store.overview() }
  /** Agents at work, incubation trends and adopted or abandoned lines, for the status board. */
  board() { return buildBoard(this.store, this.boardCache) }
  directions() { return this.store.listDirections() }
  tasks(directionId?: string) { return this.store.listTasks(directionId) }
  runs(filter: Parameters<ResearchStore['listRuns']>[0] = {}) { return this.store.listRuns(filter) }
  records(filter: Parameters<ResearchStore['listRecords']>[0] = {}) { return this.store.listRecords(filter) }
  sources(filter: Parameters<ResearchStore['listSources']>[0] = {}) { return this.store.listSources(filter) }
  candidates(filter: Parameters<ResearchStore['listCandidates']>[0] = {}) { return this.store.listCandidates(filter) }
  incubations(filter: Parameters<ResearchStore['listIncubations']>[0] = {}) { return this.store.listIncubations(filter) }
  insights(directionId?: string) { return this.store.listInsights(directionId) }
  recall(query: string, limit = 20) { return this.store.listRecords({ query, limit }) }
  requests(filter: Parameters<ResearchStore['listRequests']>[0] = {}) { return this.store.listRequests(filter) }
  assignments(requestId?: string) { return this.store.listAssignments(requestId) }
  dispatchEvents(requestId?: string) { return this.store.listDispatchEvents(requestId) }

  createDirection(input: Parameters<ResearchStore['createDirection']>[0]) { return this.store.createDirection(input) }
  createTask(input: Parameters<ResearchStore['createTask']>[0]) { return this.store.createTask(input) }
  addRecord(input: Parameters<ResearchStore['addRecord']>[0]) { return this.store.addRecord(input) }
  addInsight(input: Parameters<ResearchStore['addInsight']>[0]) { return this.store.addInsight(input) }
  createCandidate(input: Parameters<ResearchStore['createCandidate']>[0], agent: Agent) {
    if (!this.dispatcher) throw new Error('Research dispatcher is unavailable')
    return this.dispatcher.createCandidate(input, agent)
  }
  updateCandidate(id: string, input: Parameters<ResearchStore['updateCandidate']>[1], agent: Agent) {
    if (!this.dispatcher) throw new Error('Research dispatcher is unavailable')
    return this.dispatcher.updateCandidate(id, input, agent)
  }
  startRun(input: Parameters<ResearchStore['startRun']>[0], agent?: Agent) {
    if (input.candidate_id && !this.dispatcher) throw new Error('Research dispatcher is unavailable')
    return input.candidate_id ? this.dispatcher!.startCandidateRun(input, agent) : this.store.startRun(input)
  }
  finalizeRun(id: string, input: Parameters<ResearchStore['finalizeRun']>[1], agent?: Agent) {
    const run = this.store.getRun(id)
    if (run?.candidate_id) {
      if (!this.dispatcher) throw new Error('Research dispatcher is unavailable')
      this.dispatcher.authorizeCandidateRun(id, agent)
    }
    return this.store.finalizeRun(id, input)
  }
  captureSource(input: Omit<Parameters<ResearchStore['addSource']>[0], 'request_id'>, agent: Agent) {
    if (!this.dispatcher) throw new Error('Research dispatcher is unavailable')
    return this.dispatcher.captureSource(input, agent)
  }
  submitRequest(input: Parameters<ResearchStore['submitRequest']>[0]) { return this.store.submitRequest(input) }
  claimRequest(id: string) { return this.store.claimRequest(id) }
  acceptRequest(id: string, input: Parameters<ResearchStore['acceptRequest']>[1]) { return this.store.acceptRequest(id, input) }
  updateRequest(id: string, input: Parameters<ResearchStore['updateRequest']>[1]) { return this.store.updateRequest(id, input) }
  createAssignment(input: Parameters<ResearchStore['createAssignment']>[0]) { return this.store.createAssignment(input) }
  reportAssignment(id: string, input: Parameters<ResearchStore['reportAssignment']>[1]) { return this.store.reportAssignment(id, input) }
  recoverDispatch() { return this.store.recoverDispatch() }
  /** Incubation state is controller-owned: children read it and report runs. */
  private controllerOnly(agent: Agent | undefined): void {
    if (!agent?.session || agent.session.header.origin === 'subagent') throw new Error('Only the controller session can change an incubation')
  }
  openIncubation(input: Parameters<ResearchStore['openIncubation']>[0], agent?: Agent) { this.controllerOnly(agent); return this.store.openIncubation(input) }
  addIncubationRound(id: string, input: Parameters<ResearchStore['addIncubationRound']>[1], agent?: Agent) { this.controllerOnly(agent); return this.store.addIncubationRound(id, input) }
  updateIncubation(id: string, input: Parameters<ResearchStore['updateIncubation']>[1], agent?: Agent) { this.controllerOnly(agent); return this.store.updateIncubation(id, input) }
  recommendScale(policy: AdaptivePolicy, observations: AdaptiveObservation[]) { return recommendNextScale(policy, observations) }
  registerToolVersion(input: Parameters<ResearchStore['registerToolVersion']>[0]) { return this.store.registerToolVersion(input) }
  proposeToolChange(input: Parameters<ResearchStore['proposeToolChange']>[0]) { return this.store.proposeToolChange(input) }
  reviewToolChange(id: string, status: Parameters<ResearchStore['reviewToolChange']>[1]) { return this.store.reviewToolChange(id, status) }
}

export type ResearchToolName =
  | 'research_models'
  | 'research_model_defaults'
  | 'research_request_submit' | 'research_request_queue' | 'research_request_show' | 'research_request_claim' | 'research_request_accept' | 'research_request_update'
  | 'research_assignment_create' | 'research_assignment_dispatch' | 'research_assignment_resume' | 'research_assignment_pause' | 'research_assignment_report' | 'research_assignment_list' | 'research_dispatch_trace' | 'research_request_stop'
  | 'research_direction_new' | 'research_task_create' | 'research_run_start' | 'research_run_finalize'
  | 'research_record_add' | 'research_record_show' | 'research_recall' | 'research_trace' | 'research_digest' | 'research_insight_add'
  | 'research_source_capture' | 'research_sources' | 'research_candidate_create' | 'research_candidates' | 'research_candidate_show' | 'research_candidate_update'
  | 'research_incubation_open' | 'research_incubation_round' | 'research_incubation_update' | 'research_incubations'
  | 'research_scale_recommend' | 'research_tool_version_register' | 'research_tool_change_propose' | 'research_tool_change_review'

/** Small tool surface that a DSH session can call without knowing the SQLite schema. */
export function createResearchTools(api: ResearchApi) {
  return {
    research_request_submit: (input: Parameters<ResearchApi['submitRequest']>[0]) => api.submitRequest(input),
    research_request_queue: (input: Parameters<ResearchApi['requests']>[0] = {}) => api.requests(input),
    research_request_show: (input: { id: string }) => api.store.getRequest(input.id),
    research_request_claim: (input: { id: string }) => api.claimRequest(input.id),
    research_request_accept: (input: { id: string; direction_id?: string; task_id?: string }) => {
      const { id: requestId, ...patch } = input; return api.acceptRequest(requestId, patch)
    },
    research_request_update: (input: { id: string; status?: Parameters<ResearchApi['updateRequest']>[1]['status']; direction_id?: string; task_id?: string; last_error?: string; current_assignment_id?: string }) => {
      const { id: requestId, ...patch } = input; return api.updateRequest(requestId, patch)
    },
    research_assignment_create: (input: Parameters<ResearchApi['createAssignment']>[0]) => api.createAssignment(input),
    research_assignment_report: (input: { id: string; status: Parameters<ResearchApi['reportAssignment']>[1]['status']; child_id?: string; report?: JsonValue; error?: string }) => {
      const { id: assignmentId, ...patch } = input; return api.reportAssignment(assignmentId, patch)
    },
    research_assignment_list: (input: { request_id?: string } = {}) => api.assignments(input.request_id),
    research_dispatch_trace: (input: { request_id: string }) => api.dispatchEvents(input.request_id),
    research_direction_new: (input: Parameters<ResearchApi['createDirection']>[0]) => api.createDirection(input),
    research_task_create: (input: Parameters<ResearchApi['createTask']>[0]) => api.createTask(input),
    research_run_start: (input: Parameters<ResearchApi['startRun']>[0], agent?: Agent) => api.startRun(input, agent),
    research_run_finalize: (input: { id: string } & Parameters<ResearchApi['finalizeRun']>[1], agent?: Agent) => { const { id, ...patch } = input; return api.finalizeRun(id, patch, agent) },
    research_record_show: (input: { id: string }) => api.store.getRecord(input.id),
    research_record_add: (input: Parameters<ResearchApi['addRecord']>[0]) => api.addRecord(input),
    research_source_capture: (input: Omit<Parameters<ResearchStore['addSource']>[0], 'request_id'>, agent: Agent) => api.captureSource(input, agent),
    research_sources: (input: Parameters<ResearchApi['sources']>[0] = {}) => api.sources(input),
    research_candidate_show: (input: { id: string }) => api.store.getCandidate(input.id),
    research_candidates: (input: Parameters<ResearchApi['candidates']>[0] = {}) => api.candidates(input),
    research_candidate_create: (input: Parameters<ResearchApi['createCandidate']>[0], agent: Agent) => api.createCandidate(input, agent),
    research_candidate_update: (input: { id: string } & Parameters<ResearchApi['updateCandidate']>[1], agent: Agent) => {
      const { id: candidateId, ...patch } = input; return api.updateCandidate(candidateId, patch, agent)
    },
    research_incubation_open: (input: Parameters<ResearchApi['openIncubation']>[0], agent?: Agent) => api.openIncubation(input, agent),
    research_incubation_round: (input: { id: string } & Parameters<ResearchApi['addIncubationRound']>[1], agent?: Agent) => {
      const { id: incubationId, ...round } = input; return api.addIncubationRound(incubationId, round, agent)
    },
    research_incubation_update: (input: { id: string } & Parameters<ResearchApi['updateIncubation']>[1], agent?: Agent) => {
      const { id: incubationId, ...patch } = input; return api.updateIncubation(incubationId, patch, agent)
    },
    research_incubations: (input: Parameters<ResearchApi['incubations']>[0] = {}) => api.incubations(input),
    research_recall: (input: { query: string; limit?: number }) => api.recall(input.query, input.limit),
    research_trace: (input: { id: string }) => trace(api.store, input.id),
    research_digest: (input: { direction_id?: string }) => digest(api.store, input.direction_id),
    research_insight_add: (input: Parameters<ResearchApi['addInsight']>[0]) => api.addInsight(input),
    research_scale_recommend: (input: { policy: AdaptivePolicy; observations: AdaptiveObservation[] }) => api.recommendScale(input.policy, input.observations),
    research_tool_version_register: (input: Parameters<ResearchApi['registerToolVersion']>[0]) => api.registerToolVersion(input),
    research_tool_change_propose: (input: Parameters<ResearchApi['proposeToolChange']>[0]) => api.proposeToolChange(input),
    research_tool_change_review: (input: { id: string; status: Parameters<ResearchApi['reviewToolChange']>[1] }) => api.reviewToolChange(input.id, input.status),
  }
}

function trace(store: ResearchStore, recordId: string): ResearchRecord[] {
  const result: ResearchRecord[] = []; const visited = new Set<string>(); const pending = [recordId]
  while (pending.length) {
    const id = pending.shift()!; if (visited.has(id)) continue; visited.add(id)
    const record = store.getRecord(id); if (!record) continue
    result.push(record); pending.push(...record.parents)
  }
  return result
}

function digest(store: ResearchStore, directionId?: string) {
  const records = store.listRecords({ direction_id: directionId, limit: 1000 })
  const tags = new Map<string, number>()
  for (const record of records) {
    const raw = record.observations && typeof record.observations === 'object' && !Array.isArray(record.observations)
      ? (record.observations as Record<string, JsonValue>).tags : undefined
    if (Array.isArray(raw)) for (const tag of raw) tags.set(String(tag), (tags.get(String(tag)) ?? 0) + 1)
  }
  return { direction_id: directionId ?? null, records: records.length, verdicts: Object.groupBy(records, record => record.verdict), recurring_tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count })) }
}
