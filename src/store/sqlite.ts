import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { id, now } from '../core/ids.ts'
import { recommendIncubation, validateIncubationPolicy, type IncubationPolicy } from '../core/incubation.ts'
import type {
  EvidenceRef, InsightStatus, JsonValue, RecordVerdict, ResearchDirection, ResearchInsight,
  ResearchAssignment, ResearchAssignmentRole, ResearchAssignmentStatus, ResearchChildModel, ResearchDispatchEvent,
  ResearchCandidate, ResearchCandidateStatus, ResearchOverview, ResearchRecord, ResearchRecordSummary, ResearchRequest, ResearchRequestStatus,
  ResearchRun, ResearchTask, ResearchToolChangeProposal, ResearchToolVersion, RunStatus, TaskStatus,
  ToolChangeStatus, ToolVersionStatus, ResearchSource, ResearchIncubation, ResearchIncubationRound, ResearchIncubationStatus,
} from '../core/types.ts'

type Row = Record<string, unknown>

function json(value: unknown): string { return JSON.stringify(value ?? null) }
function parse<T>(value: unknown): T { return JSON.parse(String(value)) as T }
function rowPayload<T>(row: Row): T { return parse<T>(row.payload) }
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function like(value: string): string { return `%${value.replaceAll('%', '\\%').replaceAll('_', '\\_')}%` }
function objectValue(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} must be a JSON object`)
  return value as Record<string, JsonValue>
}
function requireText(value: string | undefined, label: string): string {
  if (!value?.trim()) throw new Error(`${label} is required`)
  return value.trim()
}
function sourceUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Source URL must be a valid http(s) URL without credentials') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Source URL must be a valid http(s) URL without credentials')
  return url.href
}

/** Depth over breadth: a direction develops at most this many structural candidates at once. */
export const MAX_ACTIVE_INCUBATIONS_PER_DIRECTION = 2

const MEASURED_CANDIDATE_STATUSES = new Set<ResearchCandidateStatus>(['succeeded', 'refuted', 'inconclusive'])

function hasObservation(value: JsonValue): boolean {
  if (value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (typeof value === 'object') return Object.values(value).some(hasObservation)
  return true
}

function hasMeasuredOutcome(status: ResearchCandidateStatus, runs: readonly ResearchRun[]): boolean {
  return runs.some(run => {
    const measured = Object.values(run.metrics ?? {}).some(hasObservation)
      || (run.artifacts ?? []).some(artifact => typeof artifact?.path === 'string' && artifact.path.trim().length > 0)
    if (status === 'succeeded') return run.status === 'succeeded' && measured
    return measured || (run.status !== 'succeeded' && Boolean(run.error?.trim()))
  })
}

const REQUEST_TRANSITIONS: Record<ResearchRequestStatus, readonly ResearchRequestStatus[]> = {
  queued: ['assessing', 'stopped'], assessing: ['accepted', 'waiting', 'blocked', 'failed', 'stopped'],
  accepted: ['running', 'waiting', 'blocked', 'completed', 'stopped'], running: ['accepted', 'waiting', 'blocked', 'failed', 'stopped'],
  waiting: ['assessing', 'accepted', 'running', 'completed', 'stopped'], blocked: ['assessing', 'stopped'], failed: ['assessing', 'stopped'],
  completed: [], stopped: [],
}

function requestTransitionAllowed(from: ResearchRequestStatus, to: ResearchRequestStatus): boolean {
  return from === to || REQUEST_TRANSITIONS[from].includes(to)
}

export interface ResearchStoreOptions { busyTimeoutMs?: number }

/** The authority for research facts and the durable main-session dispatch ledger. */
export class ResearchStore {
  readonly db: DatabaseSync
  readonly path: string

  constructor(path: string = ':memory:', options: ResearchStoreOptions = {}) {
    this.path = path
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')
    if (options.busyTimeoutMs !== undefined) this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs))};`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS directions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, direction_id TEXT NOT NULL, title TEXT NOT NULL,
        status TEXT NOT NULL, priority INTEGER NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(direction_id) REFERENCES directions(id)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, direction_id TEXT, task_id TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS records (
        id TEXT PRIMARY KEY, direction_id TEXT, task_id TEXT, kind TEXT NOT NULL,
        created_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY, direction_id TEXT, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_versions (
        id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_changes (
        id TEXT PRIMARY KEY, tool_name TEXT NOT NULL, base_version_id TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_requests (
        id TEXT PRIMARY KEY, status TEXT NOT NULL, priority INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS research_assignments (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES research_requests(id)
      );
      CREATE TABLE IF NOT EXISTS research_dispatch_events (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, type TEXT NOT NULL,
        created_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES research_requests(id)
      );
      CREATE TABLE IF NOT EXISTS research_sources (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, assignment_id TEXT NOT NULL,
        url TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES research_requests(id),
        FOREIGN KEY(assignment_id) REFERENCES research_assignments(id)
      );
      CREATE TABLE IF NOT EXISTS research_candidates (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL, direction_id TEXT, task_id TEXT,
        status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(request_id) REFERENCES research_requests(id)
      );
      CREATE TABLE IF NOT EXISTS research_incubations (
        id TEXT PRIMARY KEY, direction_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, payload TEXT NOT NULL,
        FOREIGN KEY(direction_id) REFERENCES directions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_research_incubations_direction ON research_incubations(direction_id, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tasks_direction ON tasks(direction_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_runs_direction ON runs(direction_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_runs_task_status ON runs(task_id, status);
      CREATE INDEX IF NOT EXISTS idx_records_direction ON records(direction_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_records_kind ON records(kind, created_at);
      CREATE INDEX IF NOT EXISTS idx_insights_direction ON insights(direction_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tool_versions_name ON tool_versions(tool_name, updated_at);
      CREATE INDEX IF NOT EXISTS idx_tool_changes_status ON tool_changes(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_requests_status ON research_requests(status, priority DESC, updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_assignments_request ON research_assignments(request_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_assignments_status ON research_assignments(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_dispatch_events_request ON research_dispatch_events(request_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_research_sources_request ON research_sources(request_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_research_candidates_request ON research_candidates(request_id, updated_at);
      CREATE INDEX IF NOT EXISTS idx_research_candidates_status ON research_candidates(status, updated_at);
    `)
  }

  close(): void { this.db.close() }

  /** Queue a request from the DSH main-session conversation. No external chat source is required. */
  submitRequest(input: { id?: string; title: string; message: string; session_id?: string; priority?: number }): ResearchRequest {
    return this.transaction(() => {
      if (!input.title.trim()) throw new Error('Research request title is required')
      if (!input.message.trim()) throw new Error('Research request message is required')
      const timestamp = now()
      const request: ResearchRequest = {
        schema: 'research-request/v1', id: input.id ?? id('request'), title: input.title.trim(), message: input.message,
        channel: 'main-session', session_id: input.session_id, status: 'queued', priority: input.priority ?? 0,
        attempts: 0, created_at: timestamp, updated_at: timestamp,
      }
      this.db.prepare('INSERT INTO research_requests (id,status,priority,created_at,updated_at,payload) VALUES (?,?,?,?,?,?)')
        .run(request.id, request.status, request.priority, request.created_at, request.updated_at, json(request))
      this.dispatchEvent(request.id, 'submitted', { channel: request.channel, session_id: request.session_id ?? null })
      return request
    })
  }

  getRequest(idValue: string): ResearchRequest | undefined {
    const row = this.db.prepare('SELECT payload FROM research_requests WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchRequest>(row) : undefined
  }

  listRequests(filter: { status?: ResearchRequestStatus; limit?: number } = {}): ResearchRequest[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM research_requests ${where} ORDER BY priority DESC, updated_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchRequest>(row))
  }

  claimRequest(idValue: string): ResearchRequest {
    return this.transaction(() => {
      const request = this.getRequest(idValue)
      if (!request) throw new Error(`Research request not found: ${idValue}`)
      if (!['queued', 'blocked', 'failed', 'waiting'].includes(request.status)) {
        throw new Error(`Research request cannot be claimed from ${request.status}: ${idValue}`)
      }
      const updated: ResearchRequest = { ...request, status: 'assessing', attempts: request.attempts + 1,
        controller_hold: undefined, last_error: undefined, host_pid: process.pid, updated_at: now() }
      this.saveRequest(updated)
      this.dispatchEvent(updated.id, 'claimed', { attempt: updated.attempts })
      return updated
    })
  }

  acceptRequest(idValue: string, input: { direction_id?: string; task_id?: string }): ResearchRequest {
    return this.transaction(() => {
      const request = this.getRequest(idValue)
      if (!request) throw new Error(`Research request not found: ${idValue}`)
      if (request.status !== 'assessing' && request.status !== 'accepted') throw new Error(`Research request is not being assessed: ${idValue}`)
      const links = this.requestLinks(request, input)
      const updated: ResearchRequest = { ...request, ...links, status: 'accepted', updated_at: now() }
      this.saveRequest(updated)
      this.dispatchEvent(updated.id, 'accepted', { direction_id: updated.direction_id ?? null, task_id: updated.task_id ?? null })
      return updated
    })
  }

  updateRequest(idValue: string, patch: { status?: ResearchRequestStatus; direction_id?: string; task_id?: string; last_error?: string; current_assignment_id?: string }): ResearchRequest {
    return this.transaction(() => {
      const request = this.getRequest(idValue)
      if (!request) throw new Error(`Research request not found: ${idValue}`)
      const links = this.requestLinks(request, patch)
      if (patch.status && !requestTransitionAllowed(request.status, patch.status)) throw new Error(`Invalid research request transition: ${request.status} -> ${patch.status}`)
      if (patch.status === 'completed' && this.listAssignments(idValue).some(a => !['completed', 'cancelled'].includes(a.status))) {
        throw new Error('Resolve every assignment before completing the research request')
      }
      if (patch.status === 'completed') this.assertCandidateClosure(request)
      if (patch.current_assignment_id && this.getAssignment(patch.current_assignment_id)?.request_id !== idValue) throw new Error('Assignment belongs to a different request')
      const status = patch.status ?? request.status
      let hold = request.controller_hold
      if (patch.status !== undefined) hold = status === 'waiting' || status === 'blocked' || status === 'failed' ? status : undefined
      const updated: ResearchRequest = { ...request, ...patch, ...links, status, controller_hold: hold,
        last_error: patch.last_error ?? (status === request.status ? request.last_error : undefined), updated_at: now() }
      this.saveRequest(updated)
      this.dispatchEvent(updated.id, updated.status === 'stopped' ? 'request-stopped' : 'request-updated', { from: request.status, to: updated.status })
      return updated
    })
  }

  private requestLinks(request: ResearchRequest, patch: { direction_id?: string; task_id?: string }): Pick<ResearchRequest, 'direction_id' | 'task_id'> {
    const direction_id = patch.direction_id ?? request.direction_id
    const task_id = patch.task_id ?? request.task_id
    if (direction_id === request.direction_id && task_id === request.task_id) return { direction_id, task_id }
    if (['completed', 'stopped'].includes(request.status) || this.listAssignments(request.id).some(a => a.attempt > 0 || a.status === 'completed')) {
      throw new Error('Request direction and task cannot change after work has started or the request has closed')
    }
    if (direction_id !== undefined && !this.getDirection(direction_id)) throw new Error(`Direction not found: ${direction_id}`)
    if (task_id !== undefined) {
      const task = this.getTask(task_id)
      if (!task) throw new Error(`Task not found: ${task_id}`)
      if (direction_id !== undefined && task.direction_id !== direction_id) throw new Error('Request task must belong to its direction')
    }
    return { direction_id, task_id }
  }

  createAssignment(input: { id?: string; request_id: string; role: ResearchAssignmentRole; instruction: string; depends_on?: string[] }): ResearchAssignment {
    return this.transaction(() => {
      const request = this.getRequest(input.request_id)
      if (!request) throw new Error(`Research request not found: ${input.request_id}`)
      if (!['accepted', 'running', 'waiting'].includes(request.status)) throw new Error(`Research request cannot receive an assignment from ${request.status}: ${request.id}`)
      if (!input.instruction.trim()) throw new Error('Research assignment instruction is required')
      for (const dependency of input.depends_on ?? []) {
        const assignment = this.getAssignment(dependency)
        if (assignment?.request_id !== request.id) throw new Error('Dependency must be an existing assignment in this request')
        if (assignment.status === 'cancelled') throw new Error(`Dependency was cancelled: ${dependency}`)
      }
      const timestamp = now()
      const assignment: ResearchAssignment = {
        schema: 'research-assignment/v1', id: input.id ?? id('assignment'), request_id: input.request_id,
        role: input.role, instruction: input.instruction, status: 'queued', attempt: 0, depends_on: input.depends_on ?? [],
        created_at: timestamp, updated_at: timestamp,
      }
      this.db.prepare('INSERT INTO research_assignments (id,request_id,role,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?)')
        .run(assignment.id, assignment.request_id, assignment.role, assignment.status, assignment.created_at, assignment.updated_at, json(assignment))
      const updatedRequest: ResearchRequest = { ...request, current_assignment_id: assignment.id, updated_at: timestamp }
      this.saveRequest(updatedRequest)
      this.dispatchEvent(request.id, 'assignment-created', { assignment_id: assignment.id, role: assignment.role })
      return assignment
    })
  }

  getAssignment(idValue: string): ResearchAssignment | undefined {
    const row = this.db.prepare('SELECT payload FROM research_assignments WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchAssignment>(row) : undefined
  }

  findAssignmentByChild(childId: string): ResearchAssignment | undefined {
    const row = this.db.prepare("SELECT payload FROM research_assignments WHERE json_extract(payload, '$.child_id') = ? ORDER BY updated_at DESC LIMIT 1").get(childId) as Row | undefined
    return row ? rowPayload<ResearchAssignment>(row) : undefined
  }

  listAssignments(requestId?: string): ResearchAssignment[] {
    const rows = requestId
      ? this.db.prepare('SELECT payload FROM research_assignments WHERE request_id = ? ORDER BY created_at DESC').all(requestId)
      : this.db.prepare('SELECT payload FROM research_assignments ORDER BY updated_at DESC LIMIT 1000').all()
    return (rows as Row[]).map(row => rowPayload<ResearchAssignment>(row))
  }

  /** Only the dispatcher starts executions. The reserved child id is durable before DSH receives work. */
  startAssignment(idValue: string, childId: string, childModel?: ResearchChildModel): ResearchAssignment {
    return this.transaction(() => {
      const assignment = this.getAssignment(idValue)
      if (!assignment) throw new Error(`Research assignment not found: ${idValue}`)
      if (!['queued', 'waiting', 'failed'].includes(assignment.status)) throw new Error(`Cannot dispatch ${assignment.status} assignment`)
      const request = this.getRequest(assignment.request_id)!
      if (['completed', 'stopped'].includes(request.status)) throw new Error('Research request is terminal')
      if (assignment.role === 'runner' && this.getCandidateForRunner(assignment.id)?.status === 'cancelled') {
        throw new Error('Assigned candidate is cancelled')
      }
      for (const dependency of assignment.depends_on ?? []) {
        if (this.getAssignment(dependency)?.status !== 'completed') throw new Error(`Dependency not completed: ${dependency}`)
      }
      const updated: ResearchAssignment = { ...assignment, child_id: childId,
        ...(childModel === undefined ? {} : { child_model: childModel }), host_pid: process.pid, status: 'running',
        attempt: assignment.attempt + 1, started_at: now(), finished_at: undefined, report: undefined, reported_status: undefined, error: undefined, updated_at: now() }
      this.saveAssignment(updated)
      this.dispatchEvent(request.id, 'assignment-started', { assignment_id: idValue, child_id: childId, attempt: updated.attempt,
        ...(updated.child_model === undefined ? {} : { child_model: { ...updated.child_model } }) })
      this.saveAutomaticRequest(request,
        { ...request, status: 'running', host_pid: process.pid, current_assignment_id: idValue, controller_hold: undefined, last_error: undefined, updated_at: now() },
        { reason: 'assignment-started', assignment_id: idValue })
      return updated
    })
  }

  /** A worker submits evidence; only DSH execution settlement changes a running assignment to terminal. */
  submitAssignmentReport(idValue: string, childId: string, input: { status: 'completed' | 'waiting' | 'failed'; report: JsonValue; error?: string }): ResearchAssignment {
    return this.transaction(() => {
      const assignment = this.getAssignment(idValue)
      if (!assignment || assignment.child_id !== childId) throw new Error('Only the assigned child can report this assignment')
      if (assignment.status !== 'running') throw new Error('Assignment is not running')
      if (!input.report || typeof input.report !== 'object' || Array.isArray(input.report)) throw new Error('Report must be an object with evidence references')
      const report = input.report as Record<string, JsonValue>
      const request = this.getRequest(assignment.request_id)!
      if (report.task_id !== (request.task_id ?? null)) throw new Error('Report task_id must match the request (or null)')
      if (!Array.isArray(report.run_ids)) throw new Error('Report must include run_ids (empty for non-experimental work)')
      if ((assignment.role === 'runner' || assignment.role === 'auditor') && input.status === 'completed' && !report.run_ids.length) throw new Error('Completed execution or audit needs finalized run evidence')
      for (const runId of report.run_ids) {
        const run = typeof runId === 'string' ? this.getRun(runId) : undefined
        if (!run || ['queued', 'running'].includes(run.status) || (request.task_id && run.task_id !== request.task_id)) throw new Error('Report references missing, unfinished, or unrelated run')
      }
      if (!Array.isArray(report.evidence)) throw new Error('Report must include an evidence array')
      this.validateAssignmentReport(assignment, report, input.status === 'completed')
      const updated: ResearchAssignment = { ...assignment, report: input.report, reported_status: input.status, error: input.error, updated_at: now() }
      this.saveAssignment(updated)
      this.dispatchEvent(assignment.request_id, 'assignment-report', { assignment_id: idValue, reported_status: input.status, report: input.report })
      return updated
    })
  }

  /** Execution outcomes, never model-authored success, determine whether a report can be accepted. */
  reportAssignment(idValue: string, input: { status: ResearchAssignmentStatus; child_id?: string; report?: JsonValue; error?: string }, expectedAttempt?: number): ResearchAssignment {
    return this.transaction(() => {
      const assignment = this.getAssignment(idValue)
      if (!assignment) throw new Error(`Research assignment not found: ${idValue}`)
      if (expectedAttempt !== undefined && (assignment.status !== 'running' || assignment.attempt !== expectedAttempt
        || assignment.child_id !== input.child_id)) return assignment
      if (['stopped', 'completed', 'cancelled'].includes(assignment.status)) throw new Error(`Research assignment is already terminal: ${idValue}`)
      if (input.status === 'queued' || input.status === 'running') throw new Error('Use the dispatcher to start or resume an assignment')
      if (input.status === 'cancelled') throw new Error('Withdraw this assignment through candidate cancellation')
      if (input.child_id && assignment.child_id && input.child_id !== assignment.child_id) throw new Error('Stale child report')
      const timestamp = now()
      const terminal = ['completed', 'failed', 'stopped'].includes(input.status)
      const updated: ResearchAssignment = { ...assignment, ...input, finished_at: terminal ? timestamp : undefined, updated_at: timestamp }
      this.saveAssignment(updated)
      this.dispatchEvent(assignment.request_id, input.status === 'failed' ? 'assignment-failed' : 'assignment-report', { assignment_id: updated.id, status: updated.status, error: input.error ?? null })
      this.refreshRequest(assignment.request_id, assignment.id)
      return updated
    })
  }

  /** Recovery checks process ownership: opening the other UI never interrupts live work. */
  recoverDispatch(isAlive: (pid: number) => boolean = processAlive): { requests: number; assignments: number } {
    return this.transaction(() => {
      const assignments = (this.db.prepare("SELECT payload FROM research_assignments WHERE status = 'running'").all() as Row[])
        .map(row => rowPayload<ResearchAssignment>(row)).filter(a => a.host_pid !== undefined && !isAlive(a.host_pid))
      for (const assignment of assignments) this.reportAssignment(assignment.id, { status: 'waiting', error: 'Owning DSH process stopped. Inspect evidence and explicitly resume this assignment.' })
      const requests = (this.db.prepare("SELECT payload FROM research_requests WHERE status = 'assessing'").all() as Row[])
        .map(row => rowPayload<ResearchRequest>(row)).filter(r => r.host_pid !== undefined && !isAlive(r.host_pid))
      for (const request of requests) {
        this.dispatchEvent(request.id, 'request-recovered', { previous_status: request.status })
        this.saveAutomaticRequest(request,
          { ...request, status: 'waiting', last_error: 'Owning DSH process stopped during assessment.', updated_at: now() },
          { reason: 'request-recovered' })
      }
      return { requests: requests.length, assignments: assignments.length }
    })
  }

  private saveAssignment(assignment: ResearchAssignment): void {
    this.db.prepare('UPDATE research_assignments SET status=?, updated_at=?, payload=? WHERE id=?')
      .run(assignment.status, assignment.updated_at, json(assignment), assignment.id)
  }

  private refreshRequest(requestId: string, assignmentId: string): void {
    const request = this.getRequest(requestId)!
    if (['stopped', 'completed'].includes(request.status)) return
    const assignments = this.listAssignments(requestId)
    const status = request.controller_hold ?? (assignments.some(a => a.status === 'running') ? 'running'
      : assignments.some(a => a.status === 'waiting') ? 'waiting'
      : assignments.some(a => a.status === 'failed' || a.status === 'stopped') ? 'blocked' : 'accepted')
    this.saveAutomaticRequest(request, { ...request, status, updated_at: now() },
      { reason: 'assignment-settled', assignment_id: assignmentId })
  }

  private validateAssignmentReport(assignment: ResearchAssignment, report: Record<string, JsonValue>, completed: boolean): void {
    if (!completed) return
    const request = this.getRequest(assignment.request_id)!
    if (assignment.role === 'scout') {
      const sourceIds = report.source_ids
      if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.some(value => typeof value !== 'string')
        || new Set(sourceIds).size !== sourceIds.length) {
        throw new Error('Completed scout report must include source_ids from research_source_capture')
      }
      const capturedSourceIds = (this.db.prepare('SELECT id FROM research_sources WHERE request_id = ? AND assignment_id = ?')
        .all(request.id, assignment.id) as Row[]).map(row => String(row.id))
      if (capturedSourceIds.length !== sourceIds.length || capturedSourceIds.some(sourceId => !sourceIds.includes(sourceId))) {
        throw new Error('Completed scout report must include every captured source')
      }
      const sources = new Map<string, ResearchSource>()
      for (const sourceId of sourceIds as string[]) {
        const source = this.getSource(sourceId)
        if (!source || source.request_id !== request.id || source.assignment_id !== assignment.id) {
          throw new Error(`Scout report references an unowned source: ${sourceId}`)
        }
        sources.set(sourceId, source)
      }
      const hypotheses = report.hypotheses
      if (!Array.isArray(hypotheses) || !hypotheses.length) throw new Error('Completed scout report must include hypotheses')
      for (const hypothesis of hypotheses) {
        if (hypothesis === null || Array.isArray(hypothesis) || typeof hypothesis !== 'object') throw new Error('Each scout hypothesis must be an object')
        const item = hypothesis as Record<string, JsonValue>
        for (const key of ['mechanism', 'pass_gate', 'stop_gate']) {
          if (typeof item[key] !== 'string' || !item[key].trim()) throw new Error(`Scout hypothesis requires ${key}`)
        }
        objectValue(item.minimal_experiment ?? null, 'Scout minimal_experiment')
        if (!Array.isArray(item.source_ids) || !item.source_ids.length) throw new Error('Scout hypothesis must cite source_ids')
        for (const sourceId of item.source_ids) {
          if (typeof sourceId !== 'string' || !sourceIds.includes(sourceId)) throw new Error('Scout hypothesis source_ids must be in the report source_ids')
          const source = sources.get(sourceId)
          if (!source || source.mechanism_hypothesis !== item.mechanism
            || canonicalJson(source.minimal_experiment) !== canonicalJson(item.minimal_experiment)
            || source.pass_gate !== item.pass_gate || source.stop_gate !== item.stop_gate) {
            throw new Error(`Scout hypothesis must match captured source fields: ${sourceId}`)
          }
        }
      }
    }
    if (assignment.role === 'runner') {
      if (typeof report.candidate_id !== 'string' || !report.candidate_id) throw new Error('Completed runner report must include candidate_id')
      const candidate = this.getCandidate(report.candidate_id)
      if (!candidate || candidate.request_id !== request.id) throw new Error('Runner report references an unrelated candidate')
      if (!MEASURED_CANDIDATE_STATUSES.has(candidate.status) || !candidate.run_ids.length) {
        throw new Error('Runner report requires a measured terminal candidate')
      }
      if (candidate.runner_assignment_id !== assignment.id) throw new Error('Runner report candidate must be assigned to this runner')
      if (!Array.isArray(report.run_ids) || report.run_ids.length !== candidate.run_ids.length) {
        throw new Error('Runner report must list every finalized run for its candidate')
      }
      const reportedRunIds = report.run_ids as string[]
      if (new Set(reportedRunIds).size !== reportedRunIds.length
        || !candidate.run_ids.every(runId => reportedRunIds.includes(runId))) {
        throw new Error('Runner report must list each candidate run exactly once')
      }
      if (!this.hasMeasuredCandidate(candidate)) throw new Error('Runner report requires finalized runs with evidence for its assigned candidate')
    }
  }

  private finalizedCandidateRun(candidate: ResearchCandidate, runId: string): ResearchRun | undefined {
    const run = this.getRun(runId)
    if (run?.candidate_id === candidate.id && run.task_id === candidate.task_id
      && run.runner_assignment_id === candidate.runner_assignment_id && run.status !== 'queued' && run.status !== 'running') return run
  }

  private hasMeasuredCandidate(candidate: ResearchCandidate): boolean {
    if (!MEASURED_CANDIDATE_STATUSES.has(candidate.status)) return false
    const runs: ResearchRun[] = []
    for (const runId of candidate.run_ids ?? []) {
      const run = this.finalizedCandidateRun(candidate, runId)
      if (!run) return false
      runs.push(run)
    }
    return hasMeasuredOutcome(candidate.status, runs)
  }

  private assertCandidateClosure(request: ResearchRequest): void {
    const assignments = this.listAssignments(request.id)
    if (!assignments.some(assignment => assignment.role === 'scout' && assignment.status === 'completed')) return
    const candidates = (this.db.prepare('SELECT payload FROM research_candidates WHERE request_id = ?')
      .all(request.id) as Row[]).map(row => rowPayload<ResearchCandidate>(row))
      .filter(candidate => candidate.task_id === request.task_id && this.hasMeasuredCandidate(candidate))
    if (!candidates.length) {
      throw new Error('A request with completed scout analysis needs a measured candidate before completion')
    }
    const closedByRunner = assignments.some(assignment => assignment.role === 'runner' && assignment.status === 'completed'
      && assignment.report && typeof assignment.report === 'object' && !Array.isArray(assignment.report)
      && (assignment.report as Record<string, JsonValue>).task_id === (request.task_id ?? null)
      && typeof (assignment.report as Record<string, JsonValue>).candidate_id === 'string'
      && candidates.some(candidate => candidate.id === (assignment.report as Record<string, JsonValue>).candidate_id
        && candidate.runner_assignment_id === assignment.id
        && Array.isArray((assignment.report as Record<string, JsonValue>).run_ids)
        && ((assignment.report as Record<string, JsonValue>).run_ids as JsonValue[]).length === candidate.run_ids.length
        && new Set((assignment.report as Record<string, JsonValue>).run_ids as JsonValue[]).size === candidate.run_ids.length
        && candidate.run_ids.every(runId => ((assignment.report as Record<string, JsonValue>).run_ids as JsonValue[]).includes(runId))))
    if (!closedByRunner) {
      throw new Error('A measured candidate must be reported by a completed runner assignment before completion')
    }
  }

  addSource(input: Omit<ResearchSource, 'schema' | 'id' | 'created_at' | 'request_id' | 'retrieved_at'> & {
    id?: string
    request_id: string
    assignment_id: string
  }): ResearchSource {
    return this.transaction(() => {
      const request = this.getRequest(input.request_id)
      if (!request) throw new Error(`Research request not found: ${input.request_id}`)
      if (['completed', 'stopped'].includes(request.status)) throw new Error('Cannot add a source to a terminal request')
      const assignment = this.getAssignment(input.assignment_id)
      if (!assignment || assignment.request_id !== request.id || assignment.role !== 'scout') {
        throw new Error('Source capture requires a scout assignment from the same request')
      }
      if (assignment.status !== 'running') throw new Error('Scout assignment is not active')
      const timestamp = now()
      const source: ResearchSource = {
        schema: 'research-source/v1',
        id: input.id ?? id('source'),
        request_id: request.id,
        assignment_id: assignment.id,
        query: requireText(input.query, 'Search query'),
        url: sourceUrl(input.url),
        title: requireText(input.title, 'Source title'),
        source_type: input.source_type,
        provider: input.provider?.trim() || undefined,
        retrieved_at: timestamp,
        claim: requireText(input.claim, 'Source claim'),
        applicability: requireText(input.applicability, 'Source applicability'),
        limitations: requireText(input.limitations, 'Source limitations'),
        mechanism_hypothesis: requireText(input.mechanism_hypothesis, 'Mechanism hypothesis'),
        minimal_experiment: objectValue(input.minimal_experiment, 'Minimal experiment'),
        pass_gate: requireText(input.pass_gate, 'Pass gate'),
        stop_gate: requireText(input.stop_gate, 'Stop gate'),
        created_at: timestamp,
      }
      this.db.prepare('INSERT INTO research_sources (id,request_id,assignment_id,url,created_at,payload) VALUES (?,?,?,?,?,?)')
        .run(source.id, source.request_id, source.assignment_id, source.url, source.created_at, json(source))
      return source
    })
  }

  getSource(idValue: string): ResearchSource | undefined {
    const row = this.db.prepare('SELECT payload FROM research_sources WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchSource>(row) : undefined
  }

  listSources(filter: { request_id?: string; assignment_id?: string; query?: string; limit?: number } = {}): ResearchSource[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.request_id) { clauses.push('request_id = ?'); args.push(filter.request_id) }
    if (filter.assignment_id) { clauses.push('assignment_id = ?'); args.push(filter.assignment_id) }
    if (filter.query) { clauses.push("(payload LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\')"); const term = like(filter.query); args.push(term, term) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM research_sources ${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchSource>(row))
  }

  createCandidate(input: Omit<ResearchCandidate, 'schema' | 'id' | 'status' | 'run_ids' | 'created_at' | 'updated_at'> & { id?: string }): ResearchCandidate {
    return this.transaction(() => {
      const request = this.getRequest(input.request_id)
      if (!request) throw new Error(`Research request not found: ${input.request_id}`)
      if (['completed', 'stopped'].includes(request.status)) throw new Error('Cannot create a candidate for a terminal request')
      const direction_id = input.direction_id ?? request.direction_id
      const task_id = input.task_id ?? request.task_id
      if (request.direction_id && direction_id !== request.direction_id) throw new Error('Candidate direction must match the request')
      if (task_id !== request.task_id) throw new Error('Candidate task must match the request')
      if (direction_id && !this.getDirection(direction_id)) throw new Error(`Direction not found: ${direction_id}`)
      const task = task_id ? this.getTask(task_id) : undefined
      if (task_id && !task) throw new Error(`Task not found: ${task_id}`)
      if (task && direction_id && task.direction_id !== direction_id) {
        throw new Error('Candidate task must belong to its direction')
      }
      const incubation = input.incubation_id ? this.assertIncubationRoundOpen(input.incubation_id, direction_id) : undefined
      if (input.based_on_run_id && !incubation) throw new Error('based_on_run_id requires an incubation_id')
      const followsRound = Boolean(incubation && input.based_on_run_id)
      if (followsRound && incubation!.rounds.at(-1)?.run_id !== input.based_on_run_id) {
        throw new Error('A follow-up incubation round must be based on the latest recorded round run')
      }
      if (!followsRound && !input.source_ids.length) throw new Error('Candidate must cite at least one scout source')
      const sourceIds = [...new Set(input.source_ids)]
      const sourceReports = followsRound ? [] : sourceIds.map(sourceId => {
        const source = this.getSource(sourceId)
        if (!source || source.request_id !== request.id) throw new Error(`Source does not belong to the request: ${sourceId}`)
        const scout = this.getAssignment(source.assignment_id)
        if (scout?.status !== 'completed' || scout.role !== 'scout') throw new Error(`Source scout assignment is not complete: ${sourceId}`)
        if (!scout.report || typeof scout.report !== 'object' || Array.isArray(scout.report)) {
          throw new Error(`Source is not in a completed scout report: ${sourceId}`)
        }
        const report = scout.report as Record<string, JsonValue>
        if (!Array.isArray(report.source_ids) || !report.source_ids.includes(sourceId)) {
          throw new Error(`Source is not in a completed scout report: ${sourceId}`)
        }
        return report
      })
      if (followsRound) for (const sourceId of sourceIds) if (!this.getSource(sourceId)) throw new Error(`Source not found: ${sourceId}`)
      const experiment = objectValue(input.minimal_experiment, 'Minimal experiment')
      const supportedByReport = followsRound || sourceReports.some(report => Array.isArray(report.hypotheses) && report.hypotheses.some(value => {
        if (value === null || Array.isArray(value) || typeof value !== 'object') return false
        const hypothesis = value as Record<string, JsonValue>
        return hypothesis.mechanism === input.mechanism
          && canonicalJson(hypothesis.minimal_experiment) === canonicalJson(experiment)
          && hypothesis.pass_gate === input.pass_gate
          && hypothesis.stop_gate === input.stop_gate
          && Array.isArray(hypothesis.source_ids)
          && sourceIds.every(sourceId => (hypothesis.source_ids as JsonValue[]).includes(sourceId))
      }))
      if (!supportedByReport) throw new Error('Candidate must match a completed scout hypothesis and its cited sources')
      const timestamp = now()
      const candidate: ResearchCandidate = {
        schema: 'research-candidate/v1',
        id: input.id ?? id('candidate'),
        request_id: request.id,
        direction_id,
        task_id,
        title: requireText(input.title, 'Candidate title'),
        question: requireText(input.question, 'Candidate question'),
        mechanism: requireText(input.mechanism, 'Candidate mechanism'),
        source_ids: sourceIds,
        minimal_experiment: experiment,
        pass_gate: requireText(input.pass_gate, 'Pass gate'),
        stop_gate: requireText(input.stop_gate, 'Stop gate'),
        status: 'proposed',
        run_ids: [],
        ...(incubation ? { incubation_id: incubation.id } : {}),
        ...(followsRound ? { based_on_run_id: input.based_on_run_id } : {}),
        created_at: timestamp,
        updated_at: timestamp,
      }
      this.db.prepare('INSERT INTO research_candidates (id,request_id,direction_id,task_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
        .run(candidate.id, candidate.request_id, candidate.direction_id ?? null, candidate.task_id ?? null, candidate.status, candidate.created_at, candidate.updated_at, json(candidate))
      return candidate
    })
  }

  getCandidate(idValue: string): ResearchCandidate | undefined {
    const row = this.db.prepare('SELECT payload FROM research_candidates WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchCandidate>(row) : undefined
  }

  getCandidateForRunner(assignmentId: string): ResearchCandidate | undefined {
    const row = this.db.prepare("SELECT payload FROM research_candidates WHERE json_extract(payload, '$.runner_assignment_id') = ? LIMIT 1").get(assignmentId) as Row | undefined
    return row ? rowPayload<ResearchCandidate>(row) : undefined
  }

  listCandidates(filter: { request_id?: string; direction_id?: string; task_id?: string; status?: ResearchCandidateStatus; limit?: number } = {}): ResearchCandidate[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.request_id) { clauses.push('request_id = ?'); args.push(filter.request_id) }
    if (filter.direction_id) { clauses.push('direction_id = ?'); args.push(filter.direction_id) }
    if (filter.task_id) { clauses.push('task_id = ?'); args.push(filter.task_id) }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM research_candidates ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchCandidate>(row))
  }

  updateCandidate(idValue: string, patch: { status?: ResearchCandidateStatus; runner_assignment_id?: string; run_ids?: string[] }): ResearchCandidate {
    return this.transaction(() => {
      const candidate = this.getCandidate(idValue)
      if (!candidate) throw new Error(`Candidate not found: ${idValue}`)
      const next = patch.status ?? candidate.status
      const allowed: Record<ResearchCandidateStatus, ResearchCandidateStatus[]> = {
        proposed: ['proposed', 'running', 'cancelled'],
        running: ['running', 'succeeded', 'refuted', 'inconclusive', 'cancelled'],
        succeeded: ['succeeded'], refuted: ['refuted'], inconclusive: ['inconclusive'], cancelled: ['cancelled'],
      }
      if (!allowed[candidate.status].includes(next)) throw new Error(`Invalid candidate transition: ${candidate.status} -> ${next}`)
      const runIds = [...new Set([...(candidate.run_ids ?? []), ...(patch.run_ids ?? [])])]
      const runs: ResearchRun[] = []
      for (const runId of runIds) {
        const run = this.finalizedCandidateRun(candidate, runId)
        if (!run) throw new Error(`Candidate run must be a finalized run for its assigned candidate and task: ${runId}`)
        runs.push(run)
      }
      if (MEASURED_CANDIDATE_STATUSES.has(next)) {
        if (!runs.length) throw new Error('A measured candidate decision requires at least one finalized run')
        if (!hasMeasuredOutcome(next, runs)) {
          throw new Error(next === 'succeeded' ? 'A successful candidate requires a succeeded run with measured evidence'
            : 'A measured candidate decision requires recorded evidence from a finalized run')
        }
      }
      if (patch.runner_assignment_id) {
        const request = this.getRequest(candidate.request_id)
        if (!request || ['completed', 'stopped'].includes(request.status)) throw new Error('Cannot assign a candidate for a terminal request')
        const assignment = this.getAssignment(patch.runner_assignment_id)
        if (!assignment || assignment.request_id !== candidate.request_id || assignment.role !== 'runner' || assignment.status !== 'queued') throw new Error('Runner assignment must be queued in the candidate request')
        if (candidate.runner_assignment_id && candidate.runner_assignment_id !== assignment.id) throw new Error('Candidate is already assigned to a different runner')
        if (candidate.status !== 'proposed') throw new Error('Runner assignment must be set before candidate execution')
        const alreadyAssigned = this.db.prepare("SELECT id FROM research_candidates WHERE request_id = ? AND json_extract(payload, '$.runner_assignment_id') = ? AND id <> ? LIMIT 1")
          .get(candidate.request_id, assignment.id, candidate.id)
        if (alreadyAssigned) {
          throw new Error('A runner assignment can test only one candidate')
        }
      }
      if (next === 'running' && !candidate.runner_assignment_id && !patch.runner_assignment_id) {
        throw new Error('Candidate must be assigned to a runner before execution')
      }
      const updated: ResearchCandidate = { ...candidate, status: next, run_ids: runIds,
        ...(patch.runner_assignment_id === undefined ? {} : { runner_assignment_id: patch.runner_assignment_id }), updated_at: now() }
      this.db.prepare('UPDATE research_candidates SET status=?, updated_at=?, payload=? WHERE id=?')
        .run(updated.status, updated.updated_at, json(updated), updated.id)
      if (next === 'cancelled') this.cancelCandidateAssignments(updated)
      return updated
    })
  }

  private cancelCandidateAssignments(candidate: ResearchCandidate): void {
    const request = this.getRequest(candidate.request_id)!
    if (['completed', 'stopped'].includes(request.status)) throw new Error('Cannot cancel a candidate for a terminal request')
    if (!candidate.runner_assignment_id) return
    const runner = this.getAssignment(candidate.runner_assignment_id)
    if (!runner || runner.request_id !== request.id || runner.role !== 'runner') throw new Error('Candidate runner is unavailable')
    if (runner.status === 'running') throw new Error('Pause the candidate runner before cancelling the candidate')
    if (runner.status === 'completed' || runner.status === 'stopped') return

    const dependents = new Map<string, ResearchAssignment[]>()
    for (const assignment of this.listAssignments(request.id)) {
      if (assignment.status !== 'queued') continue
      for (const dependency of assignment.depends_on ?? []) {
        const queued = dependents.get(dependency) ?? []
        queued.push(assignment)
        dependents.set(dependency, queued)
      }
    }
    const seen = new Set<string>()
    const cancelled = [runner]
    let changed = false
    for (const assignment of cancelled) {
      if (seen.has(assignment.id)) continue
      seen.add(assignment.id)
      cancelled.push(...(dependents.get(assignment.id) ?? []))
      if (assignment.status === 'cancelled') continue
      const timestamp = now()
      this.saveAssignment({ ...assignment, status: 'cancelled', finished_at: timestamp, updated_at: timestamp })
      this.dispatchEvent(request.id, 'assignment-cancelled', {
        assignment_id: assignment.id, candidate_id: candidate.id, from: assignment.status,
      })
      changed = true
    }
    if (changed) this.refreshRequest(request.id, runner.id)
  }

  /** Short synchronous transactions serialize competing controllers across desktop and web. */
  private transaction<T>(action: () => T): T {
    this.db.exec('SAVEPOINT research_dispatch')
    try { const result = action(); this.db.exec('RELEASE research_dispatch'); return result }
    catch (error) { this.db.exec('ROLLBACK TO research_dispatch; RELEASE research_dispatch'); throw error }
  }

  listDispatchEvents(requestId?: string): ResearchDispatchEvent[] {
    const rows = requestId
      ? this.db.prepare('SELECT payload FROM research_dispatch_events WHERE request_id = ? ORDER BY created_at ASC, rowid ASC').all(requestId)
      : this.db.prepare('SELECT payload FROM research_dispatch_events ORDER BY created_at DESC, rowid DESC LIMIT 1000').all()
    return (rows as Row[]).map(row => rowPayload<ResearchDispatchEvent>(row))
  }

  private saveRequest(request: ResearchRequest): void {
    this.db.prepare('UPDATE research_requests SET status=?, priority=?, updated_at=?, payload=? WHERE id=?')
      .run(request.status, request.priority, request.updated_at, json(request), request.id)
  }

  /** Called inside the dispatch transaction so the state and its explanation persist together. */
  private saveAutomaticRequest(previous: ResearchRequest, updated: ResearchRequest,
    cause: { reason: 'assignment-started' | 'assignment-settled'; assignment_id: string } | { reason: 'request-recovered' }): void {
    this.saveRequest(updated)
    if (previous.status !== updated.status) {
      this.dispatchEvent(updated.id, 'request-updated', { from: previous.status, to: updated.status, automatic: true, ...cause })
    }
  }

  private dispatchEvent(requestId: string, type: ResearchDispatchEvent['type'], payload: JsonValue): void {
    const event: ResearchDispatchEvent = { schema: 'research-dispatch-event/v1', id: id('dispatch'), request_id: requestId, type, payload, created_at: now() }
    this.db.prepare('INSERT INTO research_dispatch_events (id,request_id,type,created_at,payload) VALUES (?,?,?,?,?)')
      .run(event.id, event.request_id, event.type, event.created_at, json(event))
  }

  createDirection(input: { id?: string; title: string; goal?: string; status?: ResearchDirection['status']; tags?: string[] }): ResearchDirection {
    const timestamp = now()
    const direction: ResearchDirection = {
      schema: 'research-direction/v1', id: input.id ?? id('direction'), title: input.title,
      goal: input.goal, status: input.status ?? 'active', tags: input.tags ?? [],
      created_at: timestamp, updated_at: timestamp,
    }
    this.db.prepare('INSERT INTO directions (id,title,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?)')
      .run(direction.id, direction.title, direction.status, direction.created_at, direction.updated_at, json(direction))
    return direction
  }

  getDirection(idValue: string): ResearchDirection | undefined {
    const row = this.db.prepare('SELECT payload FROM directions WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchDirection>(row) : undefined
  }

  listDirections(): ResearchDirection[] {
    return (this.db.prepare('SELECT payload FROM directions ORDER BY updated_at DESC').all() as Row[])
      .map(row => rowPayload<ResearchDirection>(row))
  }

  createTask(input: { id?: string; direction_id: string; title: string; question: string; hypothesis?: string; protocol?: JsonValue; status?: TaskStatus; priority?: number }): ResearchTask {
    if (!this.getDirection(input.direction_id)) throw new Error(`Direction not found: ${input.direction_id}`)
    const timestamp = now()
    const task: ResearchTask = {
      schema: 'research-task/v1', id: input.id ?? id('task'), direction_id: input.direction_id,
      title: input.title, question: input.question, hypothesis: input.hypothesis, protocol: input.protocol,
      status: input.status ?? 'draft', priority: input.priority ?? 0, created_at: timestamp, updated_at: timestamp,
    }
    this.db.prepare('INSERT INTO tasks (id,direction_id,title,status,priority,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?,?)')
      .run(task.id, task.direction_id, task.title, task.status, task.priority, task.created_at, task.updated_at, json(task))
    return task
  }

  getTask(idValue: string): ResearchTask | undefined {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchTask>(row) : undefined
  }

  listTasks(directionId?: string): ResearchTask[] {
    const rows = directionId
      ? this.db.prepare('SELECT payload FROM tasks WHERE direction_id = ? ORDER BY priority DESC, updated_at DESC').all(directionId)
      : this.db.prepare('SELECT payload FROM tasks ORDER BY priority DESC, updated_at DESC').all()
    return (rows as Row[]).map(row => rowPayload<ResearchTask>(row))
  }

  updateTask(idValue: string, patch: Partial<Pick<ResearchTask, 'title' | 'question' | 'hypothesis' | 'protocol' | 'status' | 'priority'>>): ResearchTask {
    const task = this.getTask(idValue)
    if (!task) throw new Error(`Task not found: ${idValue}`)
    const updated: ResearchTask = { ...task, ...patch, updated_at: now() }
    this.db.prepare('UPDATE tasks SET title=?, status=?, priority=?, updated_at=?, payload=? WHERE id=?')
      .run(updated.title, updated.status, updated.priority, updated.updated_at, json(updated), idValue)
    return updated
  }

  startRun(input: { id?: string; direction_id?: string; task_id?: string; candidate_id?: string; runner_assignment_id?: string; scale_stage_id?: string; tool_version_ids?: string[]; worker?: string; command?: string; input?: JsonValue; artifacts?: EvidenceRef[] }): ResearchRun {
    return this.transaction(() => {
      if (input.direction_id && !this.getDirection(input.direction_id)) throw new Error(`Direction not found: ${input.direction_id}`)
      if (input.task_id && !this.getTask(input.task_id)) throw new Error(`Task not found: ${input.task_id}`)
      const candidate = input.candidate_id ? this.getCandidate(input.candidate_id) : undefined
      if (input.candidate_id && !candidate) throw new Error(`Candidate not found: ${input.candidate_id}`)
      if (candidate) {
        if (candidate.direction_id && input.direction_id && candidate.direction_id !== input.direction_id) throw new Error('Run direction does not match candidate')
        if (candidate.task_id !== input.task_id) throw new Error('Run task does not match candidate')
        if (!candidate.runner_assignment_id || input.runner_assignment_id !== candidate.runner_assignment_id) throw new Error('Run must be started by the candidate assigned runner')
        if (!['proposed', 'running'].includes(candidate.status)) throw new Error(`Candidate is not runnable: ${candidate.status}`)
        if (this.getAssignment(candidate.runner_assignment_id)?.status !== 'running') throw new Error('Candidate work requires an active runner assignment')
      }
      for (const versionId of input.tool_version_ids ?? []) {
        const version = this.getToolVersion(versionId)
        if (!version) throw new Error(`Tool version not found: ${versionId}`)
        if (version.status === 'retired') throw new Error(`Tool version is retired: ${versionId}`)
      }
      const timestamp = now()
      const run: ResearchRun = {
        schema: 'research-run/v1', id: input.id ?? id('run'), direction_id: input.direction_id,
        task_id: input.task_id, candidate_id: input.candidate_id, runner_assignment_id: input.runner_assignment_id,
        scale_stage_id: input.scale_stage_id, tool_version_ids: input.tool_version_ids ?? [], status: 'running', worker: input.worker ?? 'main', started_at: timestamp,
        command: input.command, input: input.input, artifacts: input.artifacts ?? [],
        created_at: timestamp, updated_at: timestamp,
      }
      this.db.prepare('INSERT INTO runs (id,direction_id,task_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?)')
        .run(run.id, run.direction_id ?? null, run.task_id ?? null, run.status, run.created_at, run.updated_at, json(run))
      if (run.task_id) this.updateTask(run.task_id, { status: 'running' })
      if (candidate) {
        const updated: ResearchCandidate = { ...candidate, status: 'running', run_ids: [...new Set([...candidate.run_ids, run.id])], updated_at: timestamp }
        this.db.prepare('UPDATE research_candidates SET status=?, updated_at=?, payload=? WHERE id=?')
          .run(updated.status, updated.updated_at, json(updated), updated.id)
      }
      return run
    })
  }

  getRun(idValue: string): ResearchRun | undefined {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchRun>(row) : undefined
  }

  listRuns(filter: { direction_id?: string; task_id?: string; status?: RunStatus; limit?: number } = {}): ResearchRun[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.direction_id) { clauses.push('direction_id = ?'); args.push(filter.direction_id) }
    if (filter.task_id) { clauses.push('task_id = ?'); args.push(filter.task_id) }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM runs ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchRun>(row))
  }

  finalizeRun(idValue: string, input: { status: Exclude<RunStatus, 'queued' | 'running'>; metrics?: Record<string, JsonValue>; artifacts?: EvidenceRef[]; error?: string; finished_at?: string }): ResearchRun {
    return this.transaction(() => {
      const run = this.getRun(idValue)
      if (!run) throw new Error(`Run not found: ${idValue}`)
      if (!['succeeded', 'failed', 'cancelled', 'timed_out'].includes(input.status)) throw new Error('Finalizing a run requires a terminal status')
      const outcome = {
        status: input.status, metrics: input.metrics ?? run.metrics, artifacts: input.artifacts ?? run.artifacts,
        error: input.error ?? run.error, finished_at: input.finished_at ?? run.finished_at,
      }
      if (run.status !== 'queued' && run.status !== 'running') {
        const unchanged = Object.entries(outcome).every(([key, value]) => canonicalJson(value) === canonicalJson(run[key as keyof typeof outcome]))
        if (unchanged) return run
        throw new Error('Run is already finalized; its outcome cannot be changed')
      }
      const timestamp = now()
      const updated: ResearchRun = { ...run, ...outcome, finished_at: outcome.finished_at ?? timestamp, updated_at: timestamp }
      this.db.prepare('UPDATE runs SET status=?, updated_at=?, payload=? WHERE id=?').run(updated.status, updated.updated_at, json(updated), idValue)
      if (updated.task_id) this.refreshTaskFromRuns(updated.task_id)
      return updated
    })
  }

  private refreshTaskFromRuns(taskId: string): void {
    const runs = this.db.prepare('SELECT DISTINCT status FROM runs WHERE task_id = ?').all(taskId) as { status: RunStatus }[]
    const status = runs.some(run => run.status === 'queued' || run.status === 'running') ? 'running'
      : runs.some(run => run.status === 'succeeded') ? 'completed' : 'blocked'
    this.updateTask(taskId, { status })
  }

  addRecord(input: Omit<ResearchRecord, 'schema' | 'id' | 'created_at'> & { id?: string; created_at?: string }): ResearchRecord {
    if (input.direction_id && !this.getDirection(input.direction_id)) throw new Error(`Direction not found: ${input.direction_id}`)
    if (input.task_id && !this.getTask(input.task_id)) throw new Error(`Task not found: ${input.task_id}`)
    for (const runId of input.run_ids) {
      const run = this.getRun(runId)
      if (!run) throw new Error(`Run not found: ${runId}`)
      if (run.status === 'queued' || run.status === 'running') {
        throw new Error(`Run must be finalized before adding a research record: ${runId}`)
      }
      if (input.direction_id && run.direction_id && input.direction_id !== run.direction_id) {
        throw new Error(`Run belongs to a different direction: ${runId}`)
      }
      if (input.task_id && run.task_id && input.task_id !== run.task_id) {
        throw new Error(`Run belongs to a different task: ${runId}`)
      }
    }
    const record: ResearchRecord = {
      schema: 'research-record/v1', id: input.id ?? id('record'), created_at: input.created_at ?? now(),
      kind: input.kind, direction_id: input.direction_id, task_id: input.task_id, run_ids: input.run_ids,
      question: input.question, hypothesis: input.hypothesis, protocol: input.protocol, observations: input.observations,
      verdict: input.verdict, conclusion: input.conclusion, lesson: input.lesson, boundary: input.boundary,
      evidence: input.evidence, provenance: input.provenance, parents: input.parents, supersedes: input.supersedes,
    }
    this.db.prepare('INSERT INTO records (id,direction_id,task_id,kind,created_at,payload) VALUES (?,?,?,?,?,?)')
      .run(record.id, record.direction_id ?? null, record.task_id ?? null, record.kind, record.created_at, json(record))
    return record
  }

  getRecord(idValue: string): ResearchRecord | undefined {
    const row = this.db.prepare('SELECT payload FROM records WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchRecord>(row) : undefined
  }

  /** Changes whenever a record is added, so callers can reuse a lookup made from records. */
  recordStamp(): string {
    const row = this.db.prepare('SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM records').get() as Row
    return `${row.n}:${row.latest ?? ''}`
  }

  /** The conclusions that formal records give for the listed runs, without loading whole records. */
  listRunConclusions(runIds: string[]): Array<{ run_id: string; record_id: string; kind: ResearchRecord['kind']; verdict: ResearchRecord['verdict']; conclusion: string; created_at: string }> {
    if (!runIds.length) return []
    return this.db.prepare(`SELECT j.value AS run_id, r.id AS record_id, r.kind AS kind, json_extract(r.payload, '$.verdict') AS verdict,
      json_extract(r.payload, '$.conclusion') AS conclusion, r.created_at AS created_at
      FROM records r, json_each(r.payload, '$.run_ids') j WHERE j.value IN (${runIds.map(() => '?').join(',')}) ORDER BY r.created_at DESC`)
      .all(...runIds) as never
  }

  listRecords(filter: { direction_id?: string; kind?: ResearchRecord['kind']; query?: string; limit?: number } = {}): ResearchRecord[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.direction_id) { clauses.push('direction_id = ?'); args.push(filter.direction_id) }
    if (filter.kind) { clauses.push('kind = ?'); args.push(filter.kind) }
    if (filter.query) {
      const term = like(filter.query)
      clauses.push("(payload LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')"); args.push(term, term)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM records ${where} ORDER BY created_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchRecord>(row))
  }

  addInsight(input: Omit<ResearchInsight, 'schema' | 'id' | 'created_at' | 'updated_at'> & { id?: string; created_at?: string }): ResearchInsight {
    const timestamp = input.created_at ?? now()
    const insight: ResearchInsight = { schema: 'research-insight/v1', id: input.id ?? id('insight'), created_at: timestamp, updated_at: timestamp, ...input }
    this.db.prepare('INSERT INTO insights (id,direction_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?)')
      .run(insight.id, insight.direction_id ?? null, insight.status, insight.created_at, insight.updated_at, json(insight))
    return insight
  }

  listInsights(directionId?: string): ResearchInsight[] {
    const rows = directionId
      ? this.db.prepare('SELECT payload FROM insights WHERE direction_id = ? ORDER BY updated_at DESC').all(directionId)
      : this.db.prepare('SELECT payload FROM insights ORDER BY updated_at DESC').all()
    return (rows as Row[]).map(row => rowPayload<ResearchInsight>(row))
  }

  registerToolVersion(input: { id?: string; tool_name: string; version: string; source_hash: string; environment: JsonValue; input_schema?: JsonValue; output_schema?: JsonValue; validation?: JsonValue; status?: ToolVersionStatus }): ResearchToolVersion {
    const timestamp = now()
    const tool: ResearchToolVersion = { schema: 'research-tool-version/v1', id: input.id ?? id('tool'), tool_name: input.tool_name, version: input.version, source_hash: input.source_hash, environment: input.environment, input_schema: input.input_schema, output_schema: input.output_schema, validation: input.validation, status: input.status ?? 'candidate', created_at: timestamp, updated_at: timestamp }
    this.db.prepare('INSERT INTO tool_versions (id,tool_name,version,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?)').run(tool.id, tool.tool_name, tool.version, tool.status, tool.created_at, tool.updated_at, json(tool))
    return tool
  }

  getToolVersion(idValue: string): ResearchToolVersion | undefined {
    const row = this.db.prepare('SELECT payload FROM tool_versions WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchToolVersion>(row) : undefined
  }

  listToolVersions(toolName?: string): ResearchToolVersion[] {
    const rows = toolName ? this.db.prepare('SELECT payload FROM tool_versions WHERE tool_name = ? ORDER BY updated_at DESC').all(toolName) : this.db.prepare('SELECT payload FROM tool_versions ORDER BY updated_at DESC').all()
    return (rows as Row[]).map(row => rowPayload<ResearchToolVersion>(row))
  }

  proposeToolChange(input: Omit<ResearchToolChangeProposal, 'schema' | 'id' | 'created_at' | 'updated_at' | 'status'> & { id?: string }): ResearchToolChangeProposal {
    if (!this.getToolVersion(input.base_version_id)) throw new Error(`Tool version not found: ${input.base_version_id}`)
    if (input.candidate_version_id && !this.getToolVersion(input.candidate_version_id)) throw new Error(`Tool version not found: ${input.candidate_version_id}`)
    for (const versionId of [input.base_version_id, input.candidate_version_id].filter(Boolean) as string[]) {
      if (this.getToolVersion(versionId)!.tool_name !== input.tool_name) throw new Error(`Tool version belongs to a different tool: ${versionId}`)
    }
    if (input.candidate_version_id === input.base_version_id) throw new Error('Candidate and base versions must differ')
    const timestamp = now()
    const proposal: ResearchToolChangeProposal = { schema: 'research-tool-change/v1', id: input.id ?? id('tool-change'), status: 'proposed', created_at: timestamp, updated_at: timestamp, ...input }
    this.db.prepare('INSERT INTO tool_changes (id,tool_name,base_version_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?,?)').run(proposal.id, proposal.tool_name, proposal.base_version_id, proposal.status, proposal.created_at, proposal.updated_at, json(proposal))
    return proposal
  }

  listToolChanges(filter: { tool_name?: string; status?: ToolChangeStatus } = {}): ResearchToolChangeProposal[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.tool_name) { clauses.push('tool_name = ?'); args.push(filter.tool_name) }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    return (this.db.prepare(`SELECT payload FROM tool_changes ${where} ORDER BY updated_at DESC`).all(...args as any[]) as Row[]).map(row => rowPayload<ResearchToolChangeProposal>(row))
  }

  reviewToolChange(idValue: string, status: Exclude<ToolChangeStatus, 'proposed'>): ResearchToolChangeProposal {
    const row = this.db.prepare('SELECT payload FROM tool_changes WHERE id = ?').get(idValue) as Row | undefined
    if (!row) throw new Error(`Tool change not found: ${idValue}`)
    const proposal = rowPayload<ResearchToolChangeProposal>(row)
    const transitions: Record<ToolChangeStatus, ToolChangeStatus[]> = {
      proposed: ['shadow', 'rejected', 'superseded'], shadow: ['accepted', 'rejected', 'superseded'],
      accepted: ['superseded'], rejected: [], superseded: [],
    }
    if (proposal.status === status) return proposal
    if (!transitions[proposal.status].includes(status)) throw new Error(`Invalid tool change transition: ${proposal.status} -> ${status}`)
    if (status === 'accepted') {
      const candidate = proposal.candidate_version_id ? this.getToolVersion(proposal.candidate_version_id) : undefined
      if (!candidate?.validation || (typeof candidate.validation === 'object' && !Object.keys(candidate.validation).length)) {
        throw new Error('Acceptance requires a candidate version with validation evidence')
      }
    }
    const updated = { ...proposal, status, updated_at: now() }
    this.db.prepare('UPDATE tool_changes SET status=?, updated_at=?, payload=? WHERE id=?').run(updated.status, updated.updated_at, json(updated), idValue)
    return updated
  }

  /** Open a multi-round incubation for one structural candidate. Its policy is fixed from here on. */
  openIncubation(input: { id?: string; direction_id: string; task_id?: string; title: string; architecture: string; control_description: string; control_evidence: EvidenceRef[]; policy: IncubationPolicy }): ResearchIncubation {
    return this.transaction(() => {
      if (!this.getDirection(input.direction_id)) throw new Error(`Direction not found: ${input.direction_id}`)
      const task = input.task_id ? this.getTask(input.task_id) : undefined
      if (input.task_id && !task) throw new Error(`Task not found: ${input.task_id}`)
      if (task && task.direction_id !== input.direction_id) throw new Error('Incubation task must belong to its direction')
      const evidence = (input.control_evidence ?? []).filter(item => typeof item?.path === 'string' && item.path.trim())
      if (!evidence.length) throw new Error('Incubation control needs evidence for its measured value')
      const policy = validateIncubationPolicy(input.policy)
      this.assertIncubationSlot(input.direction_id)
      const timestamp = now()
      const incubation: ResearchIncubation = {
        schema: 'research-incubation/v1', id: input.id ?? id('incubation'), direction_id: input.direction_id, task_id: input.task_id,
        title: requireText(input.title, 'Incubation title'), architecture: requireText(input.architecture, 'Incubation architecture'),
        control: { description: requireText(input.control_description, 'Incubation control description'), evidence },
        policy, status: 'incubating', rounds: [], decision: recommendIncubation(policy, []),
        created_at: timestamp, updated_at: timestamp,
      }
      this.db.prepare('INSERT INTO research_incubations (id,direction_id,status,created_at,updated_at,payload) VALUES (?,?,?,?,?,?)')
        .run(incubation.id, incubation.direction_id, incubation.status, incubation.created_at, incubation.updated_at, json(incubation))
      return incubation
    })
  }

  getIncubation(idValue: string): ResearchIncubation | undefined {
    const row = this.db.prepare('SELECT payload FROM research_incubations WHERE id = ?').get(idValue) as Row | undefined
    return row ? rowPayload<ResearchIncubation>(row) : undefined
  }

  listIncubations(filter: { id?: string; direction_id?: string; status?: ResearchIncubationStatus; limit?: number } = {}): ResearchIncubation[] {
    const clauses: string[] = []; const args: unknown[] = []
    if (filter.id) { clauses.push('id = ?'); args.push(filter.id) }
    if (filter.direction_id) { clauses.push('direction_id = ?'); args.push(filter.direction_id) }
    if (filter.status) { clauses.push('status = ?'); args.push(filter.status) }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const limit = Math.max(1, Math.min(1000, Math.floor(filter.limit ?? 100)))
    return (this.db.prepare(`SELECT payload FROM research_incubations ${where} ORDER BY updated_at DESC LIMIT ${limit}`).all(...args as any[]) as Row[])
      .map(row => rowPayload<ResearchIncubation>(row))
  }

  /**
   * Record one candidate's finalized run as an incubation round. The measured value and cost come
   * from the run itself, and the gap-trend, round, cost and failure limits decide the next status.
   */
  addIncubationRound(idValue: string, input: { run_id: string; bottleneck: string; next_change?: string; control_effect?: number }): ResearchIncubation {
    return this.transaction(() => {
      const incubation = this.getIncubation(idValue)
      if (!incubation) throw new Error(`Incubation not found: ${idValue}`)
      if (incubation.status !== 'incubating') throw new Error(`Incubation is not active: ${incubation.status}`)
      const run = this.getRun(input.run_id)
      if (!run) throw new Error(`Run not found: ${input.run_id}`)
      if (run.status === 'queued' || run.status === 'running') throw new Error(`Run must be finalized before it is recorded as a round: ${run.id}`)
      const candidate = run.candidate_id ? this.getCandidate(run.candidate_id) : undefined
      if (!candidate || candidate.incubation_id !== incubation.id) throw new Error('Round run must belong to a candidate of this incubation')
      if (!MEASURED_CANDIDATE_STATUSES.has(candidate.status)) throw new Error('The runner must close the round candidate before it is recorded')
      if (incubation.rounds.some(round => round.candidate_id === candidate.id)) throw new Error('This candidate is already recorded as a round')
      const metric = (item: ResearchRun): number | undefined => {
        const value = item.metrics?.[incubation.policy.metric]
        return item.status === 'succeeded' && typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
      }
      const effect = metric(run)
      if (effect === undefined) {
        const measured = candidate.run_ids.map(runId => this.getRun(runId)).find(item => item && metric(item) !== undefined)
        if (measured) throw new Error(`Record the measured run of this candidate instead: ${measured.id}`)
      }
      const cost = run.metrics?.cost_units
      if (effect !== undefined && !(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0)) {
        throw new Error('A measured round run must report metrics.cost_units')
      }
      const control_effect = input.control_effect ?? incubation.policy.control_effect
      if (!Number.isFinite(control_effect) || control_effect <= 0) throw new Error('Round control_effect must be a positive number')
      const round: ResearchIncubationRound = {
        index: incubation.rounds.length + 1, run_id: run.id, candidate_id: candidate.id, valid: effect !== undefined,
        ...(effect === undefined ? {} : { effect, ratio: incubation.policy.effect_direction === 'lower_better' ? effect / control_effect : control_effect / effect }),
        control_effect, cost_units: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : 0,
        scale_stage_id: run.scale_stage_id, bottleneck: requireText(input.bottleneck, 'Round bottleneck'),
        next_change: input.next_change?.trim() || undefined, created_at: now(),
      }
      const rounds = [...incubation.rounds, round]
      const decision = recommendIncubation(incubation.policy, rounds)
      const status: ResearchIncubationStatus = decision.action === 'graduate' ? 'graduated' : decision.action === 'stop' ? 'stopped' : 'incubating'
      return this.saveIncubation({ ...incubation, rounds, decision, status,
        status_reason: status === 'incubating' ? incubation.status_reason : decision.reason })
    })
  }

  /** Pause, resume or stop an incubation. A graduated or stopped incubation stays closed. */
  updateIncubation(idValue: string, input: { status: ResearchIncubationStatus; reason: string }): ResearchIncubation {
    return this.transaction(() => {
      const incubation = this.getIncubation(idValue)
      if (!incubation) throw new Error(`Incubation not found: ${idValue}`)
      const allowed: Record<ResearchIncubationStatus, ResearchIncubationStatus[]> = {
        incubating: ['paused', 'stopped'], paused: ['incubating', 'stopped'], graduated: [], stopped: [],
      }
      if (!allowed[incubation.status].includes(input.status)) throw new Error(`Invalid incubation transition: ${incubation.status} -> ${input.status}`)
      if (input.status === 'incubating') this.assertIncubationSlot(incubation.direction_id)
      return this.saveIncubation({ ...incubation, status: input.status, status_reason: requireText(input.reason, 'Incubation status reason') })
    })
  }

  private saveIncubation(incubation: ResearchIncubation): ResearchIncubation {
    const updated = { ...incubation, updated_at: now() }
    this.db.prepare('UPDATE research_incubations SET status=?, updated_at=?, payload=? WHERE id=?')
      .run(updated.status, updated.updated_at, json(updated), updated.id)
    return updated
  }

  private assertIncubationSlot(directionId: string): void {
    const active = Number((this.db.prepare("SELECT COUNT(*) AS n FROM research_incubations WHERE direction_id = ? AND status = 'incubating'").get(directionId) as Row).n)
    if (active >= MAX_ACTIVE_INCUBATIONS_PER_DIRECTION) {
      throw new Error(`This direction already develops ${active} incubations; continue, pause or stop one before starting another`)
    }
  }

  /** A new round may start only after every earlier round is closed and recorded. */
  private assertIncubationRoundOpen(incubationId: string, directionId: string | undefined): ResearchIncubation {
    const incubation = this.getIncubation(incubationId)
    if (!incubation) throw new Error(`Incubation not found: ${incubationId}`)
    if (incubation.status !== 'incubating') throw new Error(`Incubation is not active: ${incubation.status}`)
    if (incubation.direction_id !== directionId) throw new Error('Candidate direction must match its incubation')
    const earlier = (this.db.prepare("SELECT payload FROM research_candidates WHERE json_extract(payload, '$.incubation_id') = ?").all(incubation.id) as Row[])
      .map(row => rowPayload<ResearchCandidate>(row))
    for (const candidate of earlier) {
      if (candidate.status === 'proposed' || candidate.status === 'running') throw new Error(`Finish the current incubation round first: ${candidate.id}`)
      if (candidate.status !== 'cancelled' && !incubation.rounds.some(round => round.candidate_id === candidate.id)) {
        throw new Error(`Record the finished round with research_incubation_round before starting the next: ${candidate.id}`)
      }
    }
    return incubation
  }

  overview(): ResearchOverview {
    const count = (table: string, where = '', args: unknown[] = []): number => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get(...args as any[]) as Row).n)
    const recent_records: ResearchRecordSummary[] = this.listRecords({ limit: 10 }).map(record => ({
      id: record.id, direction_id: record.direction_id, question: record.question,
      verdict: record.verdict, conclusion: record.conclusion, created_at: record.created_at,
    }))
    return {
      directions: count('directions'), tasks: count('tasks'), runs: count('runs'),
      active_runs: count('runs', "WHERE status IN ('queued','running')"), records: count('records'), insights: count('insights'),
      requests: count('research_requests'),
      queued_requests: count('research_requests', "WHERE status = 'queued'"),
      active_requests: count('research_requests', "WHERE status IN ('assessing','accepted','running','waiting')"),
      blocked_requests: count('research_requests', "WHERE status IN ('blocked','failed')"),
      assignments: count('research_assignments'),
      sources: count('research_sources'),
      candidates: count('research_candidates'),
      incubations: count('research_incubations'),
      active_incubations: count('research_incubations', "WHERE status = 'incubating'"),
      recent_records,
    }
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}
