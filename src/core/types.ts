import type { IncubationPolicy, IncubationRecommendation } from './incubation.ts'

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type DirectionStatus = 'active' | 'paused' | 'completed' | 'archived'
export type TaskStatus = 'draft' | 'ready' | 'running' | 'blocked' | 'completed' | 'cancelled'
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out'
export type RecordVerdict = 'supported' | 'refuted' | 'inconclusive' | 'rejected' | 'observed'
export type InsightStatus = 'hypothesis' | 'supported' | 'established' | 'refuted' | 'superseded'
export type ToolVersionStatus = 'candidate' | 'verified' | 'active' | 'retired'
export type ToolChangeStatus = 'proposed' | 'shadow' | 'accepted' | 'rejected' | 'superseded'
export type ResearchRequestStatus = 'queued' | 'assessing' | 'accepted' | 'running' | 'waiting' | 'blocked' | 'completed' | 'failed' | 'stopped'
export type ResearchAssignmentStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'cancelled'
export type ResearchAssignmentRole = 'scout' | 'runner' | 'auditor' | 'synthesizer' | 'tool-engineer'
export type ResearchCandidateStatus = 'proposed' | 'running' | 'succeeded' | 'refuted' | 'inconclusive' | 'cancelled'
export type ResearchIncubationStatus = 'incubating' | 'paused' | 'graduated' | 'stopped'

export interface EvidenceRef {
  kind: 'file' | 'directory' | 'url' | 'log' | 'metric' | 'other'
  path: string
  label?: string
  sha256?: string
  media_type?: string
  notes?: string
}

export interface Provenance {
  source: string
  source_id?: string
  imported_at?: string
  importer_version?: string
  source_path?: string
}

export interface ResearchDirection {
  schema: 'research-direction/v1'
  id: string
  title: string
  goal?: string
  status: DirectionStatus
  tags: string[]
  created_at: string
  updated_at: string
}

export interface ResearchTask {
  schema: 'research-task/v1'
  id: string
  direction_id: string
  title: string
  question: string
  hypothesis?: string
  protocol?: JsonValue
  status: TaskStatus
  priority: number
  created_at: string
  updated_at: string
}

export interface ResearchRun {
  schema: 'research-run/v1'
  id: string
  direction_id?: string
  task_id?: string
  candidate_id?: string
  runner_assignment_id?: string
  scale_stage_id?: string
  tool_version_ids: string[]
  status: RunStatus
  worker?: string
  started_at?: string
  finished_at?: string
  command?: string
  input?: JsonValue
  metrics?: Record<string, JsonValue>
  artifacts: EvidenceRef[]
  error?: string
  provenance?: Provenance
  created_at: string
  updated_at: string
}

export interface ResearchToolVersion {
  schema: 'research-tool-version/v1'
  id: string
  tool_name: string
  version: string
  source_hash: string
  environment: JsonValue
  input_schema?: JsonValue
  output_schema?: JsonValue
  validation?: JsonValue
  status: ToolVersionStatus
  created_at: string
  updated_at: string
}

export interface ResearchToolChangeProposal {
  schema: 'research-tool-change/v1'
  id: string
  tool_name: string
  base_version_id: string
  candidate_version_id?: string
  reason: string
  expected_impact: string
  validation_plan: JsonValue
  status: ToolChangeStatus
  created_at: string
  updated_at: string
}

export interface ResearchRecord {
  schema: 'research-record/v1'
  id: string
  kind: 'experiment' | 'observation' | 'decision' | 'review' | 'correction'
  direction_id?: string
  task_id?: string
  run_ids: string[]
  question: string
  hypothesis?: string
  protocol?: JsonValue
  observations: JsonValue
  verdict: RecordVerdict
  conclusion: string
  lesson?: string
  boundary?: string
  evidence: EvidenceRef[]
  provenance: Provenance
  parents: string[]
  supersedes?: string
  created_at: string
}

export interface ResearchInsight {
  schema: 'research-insight/v1'
  id: string
  direction_id?: string
  claim: string
  scope: string
  status: InsightStatus
  confidence?: 'low' | 'medium' | 'high'
  supports: string[]
  contradicts: string[]
  related: string[]
  created_at: string
  updated_at: string
}

/** A durable request received through the DSH main-session conversation. */
export interface ResearchRequest {
  schema: 'research-request/v1'
  id: string
  title: string
  message: string
  channel: 'main-session'
  session_id?: string
  direction_id?: string
  task_id?: string
  status: ResearchRequestStatus
  priority: number
  attempts: number
  host_pid?: number
  current_assignment_id?: string
  controller_hold?: 'waiting' | 'blocked' | 'failed'
  last_error?: string
  created_at: string
  updated_at: string
}

/** Explicit model choice retained across child continuations. */
export interface ResearchChildModel {
  provider: string
  model: string
  reasoning_effort?: string
}

/** A durable handoff from the controller to one bounded research worker. */
export interface ResearchAssignment {
  schema: 'research-assignment/v1'
  id: string
  request_id: string
  role: ResearchAssignmentRole
  instruction: string
  status: ResearchAssignmentStatus
  attempt: number
  child_id?: string
  child_model?: ResearchChildModel
  host_pid?: number
  depends_on?: string[]
  reported_status?: 'completed' | 'waiting' | 'failed'
  report?: JsonValue
  error?: string
  created_at: string
  updated_at: string
  started_at?: string
  finished_at?: string
}

export interface ResearchDispatchEvent {
  schema: 'research-dispatch-event/v1'
  id: string
  request_id: string
  type: 'submitted' | 'claimed' | 'accepted' | 'assignment-created' | 'assignment-started' | 'assignment-report' | 'request-updated' | 'assignment-failed' | 'assignment-cancelled' | 'request-recovered' | 'request-stopped'
  payload: JsonValue
  created_at: string
}

export interface ResearchRecordSummary {
  id: string
  direction_id?: string
  question: string
  verdict: RecordVerdict
  conclusion: string
  created_at: string
}

/** A source-backed scout note. It is evidence for a candidate, not a final conclusion. */
export interface ResearchSource {
  schema: 'research-source/v1'
  id: string
  request_id: string
  assignment_id: string
  query: string
  url: string
  title: string
  source_type: 'search_result' | 'fetched_page' | 'paper' | 'repository' | 'documentation' | 'other'
  provider?: string
  retrieved_at: string
  claim: string
  applicability: string
  limitations: string
  mechanism_hypothesis: string
  minimal_experiment: JsonValue
  pass_gate: string
  stop_gate: string
  created_at: string
}

/** A controller-approved hypothesis that must be connected to a real run before closure. */
export interface ResearchCandidate {
  schema: 'research-candidate/v1'
  id: string
  request_id: string
  direction_id?: string
  task_id?: string
  title: string
  question: string
  mechanism: string
  source_ids: string[]
  minimal_experiment: JsonValue
  pass_gate: string
  stop_gate: string
  status: ResearchCandidateStatus
  runner_assignment_id?: string
  run_ids: string[]
  /** The incubation this candidate is one round of. */
  incubation_id?: string
  /** The recorded incubation run whose bottleneck this round targets, in place of new sources. */
  based_on_run_id?: string
  created_at: string
  updated_at: string
}

/** One measured version of an incubated structural candidate. */
export interface ResearchIncubationRound {
  index: number
  run_id: string
  candidate_id: string
  valid: boolean
  effect?: number
  control_effect: number
  ratio?: number
  cost_units: number
  scale_stage_id?: string
  /** The dominant remaining cost, taken from the run's ledger. */
  bottleneck: string
  next_change?: string
  created_at: string
}

/** A structural candidate developed over several rounds and judged by its gap trend against a control. */
export interface ResearchIncubation {
  schema: 'research-incubation/v1'
  id: string
  direction_id: string
  task_id?: string
  title: string
  architecture: string
  control: { description: string; evidence: EvidenceRef[] }
  policy: IncubationPolicy
  status: ResearchIncubationStatus
  rounds: ResearchIncubationRound[]
  decision: IncubationRecommendation
  status_reason?: string
  created_at: string
  updated_at: string
}

export interface ResearchOverview {
  directions: number
  tasks: number
  runs: number
  active_runs: number
  records: number
  insights: number
  requests: number
  queued_requests: number
  active_requests: number
  blocked_requests: number
  assignments: number
  sources: number
  candidates: number
  incubations: number
  active_incubations: number
  recent_records: ResearchRecordSummary[]
}

export type StoredEntity = ResearchDirection | ResearchTask | ResearchRun | ResearchRecord | ResearchInsight
