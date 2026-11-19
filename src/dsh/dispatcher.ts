import { randomUUID } from 'node:crypto'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { Session, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SubagentActivation, SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'
import type { JsonValue, ResearchAssignment, ResearchChildModel } from '../core/types.ts'
import type { ResearchStore } from '../store/sqlite.ts'
import { childModelOptions, type ChildModelRequest, type ResearchChildModels } from './child-model.ts'
import type { DispatchBackend } from './backend.ts'
export type { DispatchBackend } from './backend.ts'

type ChildId = SubagentActivation['childId']

interface LiveChild {
  agent: Agent
  parent: Agent
  assignmentId: string
  runId: SubagentRunInfo['runId']
  attempt?: number
  turnEnd?: TurnEndReason['kind']
}

/** Durable research handoffs over DSH's own executor, cancellation and parent inbox. */
export class ResearchDispatcher {
  private active = new Map<string, SubagentActivation>()
  private children = new Map<ChildId, LiveChild>()
  private pending = new Set<Promise<unknown>>()
  private closed = false
  private parents = new Map<string, Agent>()

  readonly store: ResearchStore
  private backend: DispatchBackend
  private warn: (error: unknown) => void
  private models?: Pick<ResearchChildModels, 'resolve' | 'list' | 'defaultFor' | 'listDefaults' | 'applyToLiveChild'>
  constructor(store: ResearchStore, backend: DispatchBackend, warn: (error: unknown) => void = () => {},
    models?: Pick<ResearchChildModels, 'resolve' | 'list' | 'defaultFor' | 'listDefaults' | 'applyToLiveChild'>) {
    this.store = store; this.backend = backend; this.warn = warn; this.models = models
  }

  owner(requestId: string, agent: Agent | undefined): Agent {
    const request = this.store.getRequest(requestId)
    if (!agent || !request || request.session_id !== agent.session.id || agent.session.header.origin === 'subagent') {
      throw new Error('Only the originating main session can dispatch or change this request')
    }
    return agent
  }

  private assignment(id: string, agent: Agent | undefined): ResearchAssignment {
    const assignment = this.store.getAssignment(id)
    if (!assignment) throw new Error('Assignment not found')
    this.owner(assignment.request_id, agent)
    return assignment
  }

  async dispatch(id: string, agent: Agent | undefined, signal: AbortSignal, model?: ResearchChildModel): Promise<ResearchAssignment> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('Research dispatcher is shutting down')
    const assignment = this.assignment(id, agent)
    if (assignment.status === 'running') return assignment // Idempotent retry of an accepted dispatch.
    const assignedCandidate = assignment.role === 'runner' ? this.store.getCandidateForRunner(assignment.id) : undefined
    if (assignment.role === 'runner' && !assignedCandidate) throw new Error('Assign a candidate before dispatching its runner')
    if (assignedCandidate && !['proposed', 'running'].includes(assignedCandidate.status)) {
      throw new Error(`Assigned candidate is not runnable: ${assignedCandidate.status}`)
    }
    if (assignment.child_id && await this.backend.hasChild(agent!.session.id, assignment.child_id as ChildId, signal)) {
      throw new Error('Use research_assignment_resume to continue the existing child; do not duplicate its experiment')
    }
    const childId = (assignment.child_id ?? randomUUID()) as ChildId
    // A saved choice wins on retries; a role default only fills a new assignment.
    const selected = model ?? (!assignment.child_model ? await this.models?.defaultFor(assignment.role, signal) : undefined)
    signal.throwIfAborted()
    if (this.closed) throw new Error('Research dispatcher is shutting down')
    this.parents.set(assignment.request_id, agent!)
    const reserved = this.store.startAssignment(id, childId, selected)
    const request = this.store.getRequest(reserved.request_id)!
    try {
      const activation = await this.backend.startActivation({
        provider: 'spawn', childId, label: `研究 ${reserved.role}: ${request.title}`, delivery: 'parent', signal,
        parent: agent!, agentPreset: `research-${reserved.role}`,
          ...(reserved.child_model === undefined ? {} : { agentOptions: childModelOptions(reserved.child_model) }),
          prompt: [{ type: 'text', text: JSON.stringify({
            request_id: request.id, assignment_id: reserved.id, task_id: request.task_id ?? null,
            direction_id: request.direction_id ?? null, question: request.message, instruction: reserved.instruction,
            candidate: assignedCandidate ?? null,
            ...(assignedCandidate?.incubation_id ? { incubation: this.store.getIncubation(assignedCandidate.incubation_id) ?? null } : {}),
            reports_from_dependencies: (reserved.depends_on ?? []).map(dependency => this.store.getAssignment(dependency)),
            report_contract: reserved.role === 'scout'
              ? 'Use this assignment_id for source capture and reports, regardless of request.current_assignment_id. Reuse existing search results and saved sources on continuation. Use available web tools for evidence gaps. Save sources that inform a proposal with research_source_capture, then call research_assignment_report with task_id, run_ids: [], evidence, source_ids, hypotheses, and findings. Each hypothesis must contain mechanism, minimal_experiment, pass_gate, stop_gate and source_ids. Do not invent measurements.'
              : reserved.role === 'runner'
                ? 'Before finishing, read the assigned candidate, bind all actual runs with candidate_id, finalize them, mark the candidate succeeded, refuted, or inconclusive, then call research_assignment_report with task_id, candidate_id, finalized run_ids, evidence, and findings. Do not report a plan as a result.'
                : 'Before finishing, call research_assignment_report with this assignment_id, status, and a report object containing task_id, run_ids, evidence, and findings. Do not invent measurements. Use empty run_ids for work without experiments.',
          }) }],
      })
      this.active.set(id, activation)
      const finished = activation.result.then(
        result => this.settle({ id: childId, stopReason: result.stopReason }, reserved.attempt),
        error => this.fail(reserved, String(error)),
      ).finally(() => {
        if (this.active.get(id) === activation) this.active.delete(id)
        this.pending.delete(finished)
      }).catch(this.warn)
      this.pending.add(finished)
      return this.store.getAssignment(id)!
    } catch (error) {
      // Retain the reserved identity for recovery: acceptance may have happened before an infrastructure failure.
      this.fail(reserved, String(error))
      throw error
    }
  }

  subagentStarted(info: SubagentRunInfo, agent: Agent | undefined, parent: Agent | undefined): void {
    if (this.closed || !info.local || !agent || !parent || agent.session.header.origin !== 'subagent') return
    const assignment = this.store.findAssignmentByChild(info.id)
    if (!assignment || this.store.getRequest(assignment.request_id)?.session_id !== info.parentSessionId) return
    this.children.set(info.id, { agent, parent, assignmentId: assignment.id, runId: info.runId })
  }

  childTurnEnded(session: Session, reason: TurnEndReason['kind']): void {
    const child = this.children.get(session.id)
    if (child?.agent.session === session) child.turnEnd = reason
  }

  childStatusChanged(agent: Agent, status: AgentStatus): void {
    const child = this.children.get(agent.session.id)
    if (child?.agent !== agent) return
    if (status === 'idle') {
      // DSH keeps the activation resident when interrupt parks accepted input.
      // Its end event can be delayed until the next wake or never arrive at all.
      const parked = agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0
      if (child.attempt !== undefined && (parked || child.turnEnd === 'aborted')) {
        const reason = child.turnEnd
        const stopReason = reason === 'error' || reason === 'max-tokens' ? reason : reason === 'blocked' ? 'refusal' : 'aborted'
        this.settle({ id: agent.session.id, stopReason }, child.attempt)
      }
      return
    }
    if (this.closed) return
    const assignment = this.store.getAssignment(child.assignmentId)
    if (!assignment || assignment.child_id !== agent.session.id) return
    const request = this.store.getRequest(assignment.request_id)!
    if (request.status === 'completed' || request.status === 'stopped') return
    child.turnEnd = undefined
    if (assignment.status === 'waiting' || assignment.status === 'failed') {
      // A message sent from the DSH child chat wakes the same assignment.
      child.attempt = this.store.startAssignment(assignment.id, agent.session.id).attempt
    } else if (assignment.status === 'running' && assignment.host_pid === process.pid) {
      child.attempt = assignment.attempt
    } else {
      return
    }
    this.parents.set(assignment.request_id, child.parent)
  }

  subagentEnded(info: SubagentRunEndInfo): void {
    const child = this.children.get(info.id)
    if (!child || child.runId !== info.runId) return
    this.children.delete(info.id)
    if (child.attempt !== undefined) this.settle(info, child.attempt)
  }

  settle(info: Pick<SubagentRunEndInfo, 'id' | 'stopReason'>, attempt: number): void {
    const assignment = this.store.findAssignmentByChild(info.id)
    if (!assignment || assignment.status !== 'running' || assignment.attempt !== attempt) return
    // A token ceiling is recoverable in the same child session, just like an
    // explicit pause. Keep it out of the blocked/failed queue so the main
    // agent can continue the existing context without creating new work.
    const status = info.stopReason === 'completed' ? assignment.reported_status ?? 'waiting'
      : ['aborted', 'max-tokens'].includes(info.stopReason) ? 'waiting' : 'failed'
    const error = info.stopReason !== 'completed' ? `DSH child stopped: ${info.stopReason}`
      : !assignment.reported_status ? 'Child finished without a structured evidence report. Resume it to collect the report.' : assignment.error
    this.store.reportAssignment(assignment.id, { status, child_id: info.id, error }, attempt)
  }

  private fail(assignment: ResearchAssignment, error: string): void {
    this.store.reportAssignment(assignment.id, { status: 'failed', child_id: assignment.child_id, error }, assignment.attempt)
  }

  async resume(id: string, message: string, agent: Agent | undefined, signal: AbortSignal, model: ChildModelRequest = {}): Promise<ResearchAssignment> {
    signal.throwIfAborted()
    if (this.closed) throw new Error('Research dispatcher is shutting down')
    const assignment = this.assignment(id, agent)
    if (assignment.status === 'running') throw new Error('Assignment is already running; wait for its report or pause it first')
    if (!['queued', 'waiting', 'failed'].includes(assignment.status)) throw new Error(`Cannot resume ${assignment.status} assignment`)
    const requested = model.provider !== undefined || model.model !== undefined || model.reasoning_effort !== undefined
    if (requested && !this.models) throw new Error('Child model selection is unavailable')
    const selected = requested ? await this.models!.resolve(model, signal) : undefined
    signal.throwIfAborted()
    if (this.closed) throw new Error('Research dispatcher is shutting down')
    if (!assignment.child_id) return this.dispatch(id, agent, signal, selected)
    this.parents.set(assignment.request_id, agent!)
    const reserved = this.store.startAssignment(id, assignment.child_id, selected)
    try {
      this.models?.applyToLiveChild(assignment.child_id as ChildId)
      await this.backend.sendMessage(agent!, assignment.child_id as ChildId,
        [{ type: 'text', text: `Resume ${id}. Check existing work first; avoid duplicates. ${message.trim()}` }], { signal })
      return this.store.getAssignment(id)!
    } catch (error) {
      this.fail(reserved, String(error))
      // A failed initial admission may have reserved an id before DSH created
      // the child. Retry that admission only when DSH explicitly says the
      // persisted child cannot be resumed and the durable catalog has no such
      // child. Existing children always remain on the same continuation path.
      if (errorCode(error) === 'NOT_RESUMABLE'
        && !await this.backend.hasChild(agent!.session.id, assignment.child_id as ChildId, signal)) {
        return this.dispatch(id, agent, signal, selected)
      }
      throw error
    }
  }

  async listModels(input: { provider?: string; model?: string }, signal: AbortSignal): Promise<unknown> {
    if (!this.models) throw new Error('Child model selection is unavailable')
    return this.models.list(input, signal)
  }

  listModelDefaults(): unknown {
    if (!this.models) throw new Error('Child model selection is unavailable')
    return this.models.listDefaults()
  }

  async pause(id: string, agent: Agent | undefined): Promise<ResearchAssignment> {
    const assignment = this.assignment(id, agent)
    if (assignment.status !== 'running' || !assignment.child_id) throw new Error('Only a running assignment can be paused')
    await this.backend.stopChild(agent!, assignment.child_id as ChildId)
    // DSH retains idle activations with parked inbox messages, so subagent/end
    // need not fire on pause. The backend has now confirmed the child is idle.
    this.settle({ id: assignment.child_id as ChildId, stopReason: 'aborted' }, assignment.attempt)
    return this.store.getAssignment(id)!
  }

  async stop(requestId: string, agent: Agent | undefined): Promise<unknown> {
    const owner = this.owner(requestId, agent)
    const assignments = this.store.listAssignments(requestId)
    const request = this.store.updateRequest(requestId, { status: 'stopped' })
    for (const assignment of assignments) {
      if (!['completed', 'stopped', 'cancelled'].includes(assignment.status)) this.store.reportAssignment(assignment.id, { status: 'stopped' })
    }
    await Promise.all(assignments.map(async assignment => {
      if (assignment.child_id) await this.backend.stopChild(owner, assignment.child_id as ChildId)
      await this.active.get(assignment.id)?.dispose()
    }))
    return request
  }

  report(id: string, input: { status: 'completed' | 'waiting' | 'failed'; report: JsonValue; error?: string }, agent: Agent | undefined): ResearchAssignment {
    if (!agent || agent.session.header.origin !== 'subagent') throw new Error('Only an assigned child can submit its evidence report')
    return this.store.submitAssignmentReport(id, agent.session.id, input)
  }

  captureSource(input: Omit<Parameters<ResearchStore['addSource']>[0], 'request_id'>, agent: Agent): ReturnType<ResearchStore['addSource']> {
    if (agent.session.header.origin !== 'subagent') throw new Error('Only an assigned scout can capture web sources. Find the original assignment with research_assignment_list; wait for it or use research_assignment_resume so that scout saves its sources and report.')
    const assignment = this.store.getAssignment(input.assignment_id)
    if (!assignment || assignment.role !== 'scout' || assignment.child_id !== agent.session.id) {
      throw new Error('Only the assigned scout can capture sources for this assignment. Use the assignment_id from your dispatch context, not request.current_assignment_id.')
    }
    return this.store.addSource({ ...input, request_id: assignment.request_id })
  }

  createCandidate(input: Parameters<ResearchStore['createCandidate']>[0], agent: Agent): ReturnType<ResearchStore['createCandidate']> {
    this.owner(input.request_id, agent)
    if (agent.session.header.origin === 'subagent') throw new Error('Only the controller can create a candidate')
    return this.store.createCandidate(input)
  }

  updateCandidate(id: string, patch: Parameters<ResearchStore['updateCandidate']>[1], agent: Agent): ReturnType<ResearchStore['updateCandidate']> {
    const candidate = this.store.getCandidate(id)
    if (!candidate) throw new Error('Candidate not found')
    if (agent.session.header.origin === 'subagent') {
      this.assertActiveRunner(this.authorizeCandidate(candidate, agent))
      if (patch.status === 'cancelled') throw new Error('Report the interruption to the controller, who can cancel a proposed candidate')
    } else {
      this.owner(candidate.request_id, agent)
      const assignment = patch.runner_assignment_id ? this.store.getAssignment(patch.runner_assignment_id) : undefined
      const assigningRunner = candidate.status === 'proposed' && patch.status === undefined && assignment?.role === 'runner'
        && assignment.request_id === candidate.request_id && assignment.status === 'queued'
      const cancelling = patch.status === 'cancelled' && ['proposed', 'cancelled'].includes(candidate.status) && patch.runner_assignment_id === undefined
      if (!assigningRunner && !cancelling) throw new Error('The controller may assign or cancel a proposed candidate')
    }
    return this.store.updateCandidate(id, patch)
  }

  startCandidateRun(input: Parameters<ResearchStore['startRun']>[0], agent: Agent | undefined): ReturnType<ResearchStore['startRun']> {
    if (!input.candidate_id || !agent) throw new Error('Candidate runs require an assigned runner')
    const candidate = this.store.getCandidate(input.candidate_id)
    if (!candidate) throw new Error('Candidate not found')
    const assignment = this.authorizeCandidate(candidate, agent)
    this.assertActiveRunner(assignment)
    if (!['proposed', 'running'].includes(candidate.status)) throw new Error(`Candidate is not runnable: ${candidate.status}`)
    return this.store.startRun({ ...input, runner_assignment_id: assignment.id })
  }

  authorizeCandidateRun(runId: string, agent: Agent | undefined): void {
    const run = this.store.getRun(runId)
    const candidate = run?.candidate_id ? this.store.getCandidate(run.candidate_id) : undefined
    if (!run || !candidate || !agent) throw new Error('Candidate run is unavailable')
    const assignment = this.authorizeCandidate(candidate, agent)
    if (run.runner_assignment_id !== assignment.id) throw new Error('Candidate run belongs to a different runner assignment')
    if (run.status === 'queued' || run.status === 'running') this.assertActiveRunner(assignment)
  }

  private authorizeCandidate(candidate: NonNullable<ReturnType<ResearchStore['getCandidate']>>, agent: Agent): ResearchAssignment {
    if (agent.session.header.origin !== 'subagent') throw new Error('Candidate execution must run in an assigned runner')
    const assignment = this.store.findAssignmentByChild(agent.session.id)
    if (!assignment || assignment.role !== 'runner' || assignment.request_id !== candidate.request_id
      || candidate.runner_assignment_id !== assignment.id) throw new Error('Candidate is not assigned to this runner')
    return assignment
  }

  private assertActiveRunner(assignment: ResearchAssignment): void {
    const request = this.store.getRequest(assignment.request_id)!
    if (assignment.status !== 'running' || ['completed', 'stopped'].includes(request.status)) {
      throw new Error('Candidate work requires an active runner assignment')
    }
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.parents].flatMap(([requestId, parent]) =>
      this.store.listAssignments(requestId).flatMap(a => a.child_id && a.host_pid === process.pid
        ? [this.backend.stopChild(parent, a.child_id as ChildId)] : [])))
    await Promise.allSettled([...this.active.values()].map(activation => activation.dispose()))
    await Promise.allSettled([...this.pending])
    for (const requestId of this.parents.keys()) for (const assignment of this.store.listAssignments(requestId)) {
      if (assignment.status === 'running' && assignment.host_pid === process.pid) {
        this.store.reportAssignment(assignment.id,
          { status: 'waiting', child_id: assignment.child_id, error: 'DSH host closed; resume from saved evidence.' }, assignment.attempt)
      }
    }
    this.children.clear()
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}
