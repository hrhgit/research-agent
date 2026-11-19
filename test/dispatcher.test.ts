import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentActivationSpec, SubagentResult } from '@deepseek-ai/dsh-subagent'
import { ResearchStore } from '../src/store/sqlite.ts'
import { ResearchApi, createResearchTools } from '../src/dsh/api.ts'
import { ResearchDispatcher, type DispatchBackend } from '../src/dsh/dispatcher.ts'
import type { ResearchAssignmentRole } from '../src/core/types.ts'
import { recommendIncubation, validateIncubationPolicy, type IncubationPolicy } from '../src/core/incubation.ts'
import { buildBoard, reportReason, type BoardCache } from '../src/dsh/board.ts'

function main(id = 'parent') { return { session: { id, header: { origin: 'user' } } } as unknown as Agent }
function child(id: string) { return { session: { id, header: { origin: 'subagent' } } } as Agent }
function setup(store = new ResearchStore()) {
  const parent = main()
  const started: SubagentActivationSpec[] = []
  const finish = new Map<string, (result: SubagentResult) => void>()
  const messages: Array<{ id: string; text: string }> = []
  let dispatcher: ResearchDispatcher
  const backend: DispatchBackend = {
    async startActivation(spec) {
      started.push(spec)
      const childId = spec.childId!
      const result = new Promise<SubagentResult>(resolve => finish.set(childId, resolve))
      return { childId, name: spec.name ?? childId, messageId: 'message' as never, result, async dispose() { finish.get(childId)!({ stopReason: 'aborted', output: [] }) } }
    },
    async hasChild(_parent, id) { return started.some(spec => spec.childId === id) },
    async sendMessage(_parent, id, content) { messages.push({ id, text: content.map(item => item.type === 'text' ? item.text : '').join('') }); return 'message' as never },
    interrupt(id) { finish.get(id)?.({ stopReason: 'aborted', output: [] }) },
    async stopChild(_parent, id) { finish.get(id)?.({ stopReason: 'aborted', output: [] }) },
  }
  dispatcher = new ResearchDispatcher(store, backend)
  const request = store.submitRequest({ title: 'Small experiment', message: 'Investigate with evidence', session_id: 'parent' })
  store.claimRequest(request.id)
  const direction = store.createDirection({ title: 'Dispatch fixture' })
  const task = store.createTask({ direction_id: direction.id, title: 'Dispatch task', question: 'Can a small test settle the mechanism?' })
  store.acceptRequest(request.id, { direction_id: direction.id, task_id: task.id })
  const api = new ResearchApi(store)
  api.dispatcher = dispatcher
  const tools = createResearchTools(api)
  const create = (role: ResearchAssignmentRole = 'scout', depends_on: string[] = []) => store.createAssignment({ request_id: request.id, role, instruction: 'Inspect evidence', depends_on })
  const dispatch = (id: string) => dispatcher.dispatch(id, parent, new AbortController().signal)
  const report = (id: string) => {
    const assignment = store.getAssignment(id)!
    const report = assignment.role === 'scout' ? (() => {
      const source = dispatcher.captureSource({
        assignment_id: id, query: 'fixture search', url: 'https://example.org/fixture',
        title: 'Fixture source', source_type: 'documentation', claim: 'The fixture has a reusable mechanism.',
        applicability: 'Applies to this test.', limitations: 'Fixture only.', mechanism_hypothesis: 'Reuse a cached result.',
        minimal_experiment: { input: 'small', measure: ['cost'] }, pass_gate: 'Cost decreases.',
        stop_gate: 'Cost does not decrease.',
      }, child(assignment.child_id!))
      return {
        task_id: task.id, run_ids: [], evidence: [{ kind: 'url', path: source.url }], findings: 'Fixture only.',
        source_ids: [source.id], hypotheses: [{
          mechanism: source.mechanism_hypothesis, minimal_experiment: source.minimal_experiment,
          pass_gate: source.pass_gate, stop_gate: source.stop_gate, source_ids: [source.id],
        }],
      }
    })() : { task_id: task.id, run_ids: [], evidence: [], findings: 'Fixture only' }
    return dispatcher.report(id, { status: 'completed', report }, child(assignment.child_id!))
  }
  const end = async (id: string, stopReason: SubagentResult['stopReason'] = 'completed') => { finish.get(store.getAssignment(id)!.child_id!)!({ stopReason, output: [] }); await new Promise(resolve => setImmediate(resolve)) }
  return { store, parent, request, direction, task, dispatcher, tools, started, messages, create, dispatch, report, end, async close() { await dispatcher.close(); store.close() } }
}

async function candidateFactory(f: ReturnType<typeof setup>) {
  const scout = f.create('scout')
  await f.dispatch(scout.id)
  const scoutReport = f.report(scout.id)
  await f.end(scout.id)
  const sourceId = (scoutReport.report as { source_ids: string[] }).source_ids[0]!
  const source = f.store.getSource(sourceId)!
  return (title: string) => f.tools.research_candidate_create({
    request_id: f.request.id, title, question: f.task.question, mechanism: source.mechanism_hypothesis,
    source_ids: [source.id], minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
  }, f.parent)
}

async function startRunner(f: ReturnType<typeof setup>, candidateId: string) {
  const runner = f.create('runner')
  f.tools.research_candidate_update({ id: candidateId, runner_assignment_id: runner.id }, f.parent)
  const assignment = await f.dispatch(runner.id)
  const agent = child(assignment.child_id!)
  const startRun = () => f.tools.research_run_start({
    direction_id: f.direction.id, task_id: f.task.id, candidate_id: candidateId, scale_stage_id: 'small',
  }, agent)
  const complete = async (runIds: string[], status: 'succeeded' | 'inconclusive' = 'succeeded') => {
    f.tools.research_candidate_update({ id: candidateId, status, run_ids: runIds }, agent)
    f.dispatcher.report(runner.id, { status: 'completed', report: {
      task_id: f.task.id, candidate_id: candidateId, run_ids: runIds, evidence: [{ kind: 'log', path: 'fixture.log' }],
    } }, agent)
    await f.end(runner.id)
  }
  return { runner, agent, startRun, complete }
}

test('dispatch binds the exact child/preset, inherits the model and is idempotent; reports wait for execution', async () => {
  const f = setup()
  try {
    const work = f.create()
    const first = await f.dispatch(work.id)
    assert.equal(first.status, 'running')
    assert.equal((await f.dispatch(work.id)).child_id, first.child_id)
    assert.equal(f.started.length, 1)
    assert.equal(f.started[0].agentPreset, 'research-scout')
    assert.equal(f.started[0].agentOptions, undefined)
    assert.equal(f.started[0].delivery, 'parent')
    f.report(work.id)
    assert.equal(f.store.getAssignment(work.id)?.status, 'running')
    await f.end(work.id)
    assert.equal(f.store.getAssignment(work.id)?.status, 'completed')
    assert.equal(f.store.getRequest(f.request.id)?.status, 'accepted')
    assert.equal(f.store.overview().records, 0)
  } finally { await f.close() }
})

for (const status of ['waiting', 'blocked'] as const) {
  test(`request can become ${status} when the child finishes between tool read and update`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'research-request-race-'))
    const f = setup(new ResearchStore(join(directory, 'research.sqlite')))
    const controller = new ResearchStore(join(directory, 'research.sqlite'))
    const tools = createResearchTools(new ResearchApi(controller))
    try {
      const work = f.create()
      await f.dispatch(work.id)
      f.report(work.id)
      const snapshot = tools.research_request_show({ id: f.request.id })!
      assert.equal(snapshot.status, 'running')
      await f.end(work.id)
      assert.equal(tools.research_request_show({ id: snapshot.id })?.status, 'accepted')

      const last_error = 'No hypothesis is ready for an experiment.'
      const updated = tools.research_request_update({ id: snapshot.id, status, last_error })
      assert.equal(updated.status, status)
      assert.equal(f.store.getRequest(snapshot.id)?.last_error, last_error)
      const trace = tools.research_dispatch_trace({ request_id: snapshot.id })
        .filter(event => event.type === 'request-updated')
      assert.deepEqual(trace.map(event => event.payload), [
        { from: 'accepted', to: 'running', automatic: true, reason: 'assignment-started', assignment_id: work.id },
        { from: 'running', to: 'accepted', automatic: true, reason: 'assignment-settled', assignment_id: work.id },
        { from: 'accepted', to: status },
      ])

      const closureError = status === 'waiting' ? /measured candidate/ : /Invalid research request transition/
      assert.throws(() => tools.research_request_update({ id: snapshot.id, status: 'completed' }), closureError)
      tools.research_request_claim({ id: snapshot.id })
      tools.research_request_accept({ id: snapshot.id })
      const beforeRejectedClosure = tools.research_dispatch_trace({ request_id: snapshot.id })
      assert.throws(() => tools.research_request_update({ id: snapshot.id, status: 'completed' }), /measured candidate/)
      assert.equal(f.store.getRequest(snapshot.id)?.status, 'accepted')
      assert.deepEqual(tools.research_dispatch_trace({ request_id: snapshot.id }), beforeRejectedClosure)
      assert.equal(f.store.overview().records, 0)
    } finally { controller.close(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
  })
}

test('automatic request changes and assignment settlement roll back if trace persistence fails', async () => {
  const f = setup()
  try {
    const work = f.create()
    const active = await f.dispatch(work.id)
    f.report(work.id)
    const before = f.store.listDispatchEvents(f.request.id)
    f.store.db.exec(`CREATE TEMP TRIGGER reject_request_trace BEFORE INSERT ON research_dispatch_events
      WHEN NEW.type = 'request-updated' BEGIN SELECT RAISE(ABORT, 'trace write failed'); END`)
    assert.throws(() => f.dispatcher.settle({ id: active.child_id! as never, stopReason: 'completed' }, active.attempt), /trace write failed/)
    assert.equal(f.store.getRequest(f.request.id)?.status, 'running')
    assert.equal(f.store.getAssignment(work.id)?.status, 'running')
    assert.deepEqual(f.store.listDispatchEvents(f.request.id), before)
    f.store.db.exec('DROP TRIGGER reject_request_trace')
    await f.end(work.id)
    assert.equal(f.store.getAssignment(work.id)?.status, 'completed')
    assert.equal(f.store.getRequest(f.request.id)?.status, 'accepted')
  } finally { await f.close() }
})

test('missing reports and execution errors trace automatic waiting and blocking without completing research', async () => {
  for (const stopReason of ['completed', 'error'] as const) {
    const f = setup()
    try {
      const work = f.create()
      await f.dispatch(work.id)
      await f.end(work.id, stopReason)
      const status = stopReason === 'completed' ? 'waiting' : 'blocked'
      assert.equal(f.store.getRequest(f.request.id)?.status, status)
      const trace = f.store.listDispatchEvents(f.request.id)
      assert.deepEqual(trace.at(-1)?.payload, {
        from: 'running', to: status, automatic: true, reason: 'assignment-settled', assignment_id: work.id,
      })
      assert.equal(trace.at(-2)?.type, stopReason === 'completed' ? 'assignment-report' : 'assignment-failed')
      f.store.claimRequest(f.request.id)
      f.store.acceptRequest(f.request.id, {})
      assert.throws(() => f.store.updateRequest(f.request.id, { status: 'completed' }), /Resolve every assignment/)
      assert.equal(f.store.overview().records, 0)
    } finally { await f.close() }
  }
})

test('parallel completion never hides a live sibling and dependencies block premature dispatch', async () => {
  const f = setup()
  try {
    const one = f.create(), two = f.create(), later = f.create('scout', [one.id, two.id])
    await Promise.all([f.dispatch(one.id), f.dispatch(two.id)])
    const automaticChanges = () => f.store.listDispatchEvents(f.request.id).filter(event => event.type === 'request-updated')
    assert.equal(automaticChanges().length, 1, 'Starting a sibling must not log running -> running')
    await assert.rejects(f.dispatch(later.id), /Dependency/)
    f.report(one.id); await f.end(one.id)
    assert.equal(f.store.getRequest(f.request.id)?.status, 'running')
    assert.equal(automaticChanges().length, 1, 'Finishing one sibling must not log a request state change')
    assert.throws(() => f.store.updateRequest(f.request.id, { status: 'completed' }))
    f.report(two.id); await f.end(two.id)
    assert.deepEqual(automaticChanges().at(-1)?.payload, {
      from: 'running', to: 'accepted', automatic: true, reason: 'assignment-settled', assignment_id: two.id,
    })
    assert.equal((await f.dispatch(later.id)).status, 'running')
  } finally { await f.close() }
})

test('only the bound scout captures sources and resumes by its own id after the request pointer changes', async () => {
  const f = setup()
  try {
    const original = f.create()
    const dispatched = await f.dispatch(original.id)
    const prompt = f.started[0].prompt[0]
    assert.ok(prompt.type === 'text')
    const context = JSON.parse(prompt.text)
    assert.equal(context.assignment_id, original.id)
    assert.match(context.report_contract, /Use this assignment_id for source capture and reports/)
    await f.end(original.id)

    const sibling = f.create()
    const other = await f.dispatch(sibling.id)
    assert.equal(f.store.getRequest(f.request.id)?.current_assignment_id, sibling.id)
    const input = {
      assignment_id: original.id, query: 'existing search', url: 'https://example.org/original',
      title: 'Original source', source_type: 'documentation' as const, claim: 'Reuse a cached result.',
      applicability: 'Fixture only.', limitations: 'Not a real experiment.', mechanism_hypothesis: 'Reuse a cached result.',
      minimal_experiment: { input: 'small', measure: ['cost'] }, pass_gate: 'Cost decreases.', stop_gate: 'Cost does not decrease.',
    }
    assert.throws(() => f.dispatcher.captureSource(input, f.parent), /Only an assigned scout.*research_assignment_list/)
    assert.throws(() => f.dispatcher.captureSource(input, child(other.child_id!)), /Only the assigned scout.*dispatch context/)
    const auditor = f.create('auditor')
    const audit = await f.dispatch(auditor.id)
    assert.throws(() => f.dispatcher.captureSource({ ...input, assignment_id: auditor.id }, child(audit.child_id!)), /Only the assigned scout/)
    assert.equal(f.store.listSources().length, 0)

    const recovered = f.store.listAssignments(f.request.id).find(assignment => assignment.id === original.id)!
    const resumed = await f.dispatcher.resume(recovered.id, 'Save the existing source notes and submit the report.', f.parent, new AbortController().signal)
    assert.equal(resumed.child_id, dispatched.child_id)
    assert.equal(f.started.length, 3, 'Continuation must not start another child')
    assert.equal(f.messages.at(-1)!.id, dispatched.child_id)
    // A sibling can take over the request pointer again while the original scout runs.
    f.store.updateRequest(f.request.id, { current_assignment_id: sibling.id })
    const source = f.dispatcher.captureSource(input, child(dispatched.child_id!))
    assert.equal(source.assignment_id, original.id)
    assert.equal(source.request_id, f.request.id)
    f.dispatcher.report(original.id, { status: 'completed', report: {
      task_id: f.task.id, run_ids: [], evidence: [{ kind: 'url', path: source.url }], findings: 'Reused the existing search.',
      source_ids: [source.id], hypotheses: [{ mechanism: source.mechanism_hypothesis, minimal_experiment: source.minimal_experiment,
        pass_gate: source.pass_gate, stop_gate: source.stop_gate, source_ids: [source.id] }],
    } }, child(dispatched.child_id!))
    f.dispatcher.settle({ id: dispatched.child_id! as never, stopReason: 'completed' }, resumed.attempt)
    assert.equal(f.store.getAssignment(original.id)?.status, 'completed')
    assert.equal(f.store.getAssignment(sibling.id)?.status, 'running')
    assert.equal(f.store.listSources({ assignment_id: original.id }).length, 1)
  } finally { await f.close() }
})

test('missing evidence and execution failure remain visible; another session cannot dispatch or forge reports', async () => {
  const f = setup()
  try {
    const work = f.create()
    await assert.rejects(f.dispatcher.dispatch(work.id, main('other'), new AbortController().signal), /originating main/)
    await f.dispatch(work.id)
    assert.throws(() => f.dispatcher.report(work.id, { status: 'completed', report: {} }, child('unrelated')), /assigned child/)
    await f.end(work.id)
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    const failure = f.create()
    await f.dispatch(failure.id); f.report(failure.id); await f.end(failure.id, 'error')
    assert.equal(f.store.getAssignment(failure.id)?.status, 'failed')
    const failedChild = f.store.getAssignment(failure.id)!.child_id
    const startsBeforeResume = f.started.length
    const resumed = await f.dispatcher.resume(failure.id, 'Continue from the checkpoint', f.parent, new AbortController().signal)
    assert.equal(resumed.child_id, failedChild)
    assert.equal(f.started.length, startsBeforeResume)
    assert.match(f.messages.at(-1)!.text, /^Resume .*Check existing work first; avoid duplicates\./)
    const limited = f.create()
    await f.dispatch(limited.id)
    await f.end(limited.id, 'max-tokens')
    assert.equal(f.store.getAssignment(limited.id)?.status, 'waiting')
    assert.equal(f.store.getRequest(f.request.id)?.status, 'running')
    const runner = f.create('runner')
    await assert.rejects(f.dispatch(runner.id), /Assign a candidate before dispatching its runner/)
  } finally { await f.close() }
})

test('scout sources become candidates assigned to one runner and closure needs that runner report', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Reuse a cached result')
    const runner = f.create('runner')
    f.dispatcher.updateCandidate(candidate.id, { runner_assignment_id: runner.id }, f.parent)
    await f.dispatch(runner.id)
    const prompt = JSON.parse(f.started.at(-1)!.prompt!.map(item => item.type === 'text' ? item.text : '').join(''))
    assert.equal(prompt.candidate.id, candidate.id)

    const runnerAgent = child(f.store.getAssignment(runner.id)!.child_id!)
    assert.throws(() => f.dispatcher.startCandidateRun({
      direction_id: f.direction.id, task_id: f.task.id, candidate_id: candidate.id,
    }, child('unassigned-runner')), /assigned to this runner/)
    const run = f.dispatcher.startCandidateRun({
      direction_id: f.direction.id, task_id: f.task.id, candidate_id: candidate.id, scale_stage_id: 'small',
    }, runnerAgent)
    assert.equal(run.runner_assignment_id, runner.id)
    assert.throws(() => f.dispatcher.authorizeCandidateRun(run.id, child('unassigned-runner')), /assigned to this runner/)
    f.store.finalizeRun(run.id, { status: 'succeeded', metrics: { cost_units: 1, effect: 0.97 } })
    f.dispatcher.updateCandidate(candidate.id, { status: 'succeeded', run_ids: [run.id] }, runnerAgent)
    f.dispatcher.report(runner.id, {
      status: 'completed',
      report: { task_id: f.task.id, candidate_id: candidate.id, run_ids: [run.id], evidence: [], findings: 'Fixture result.' },
    }, runnerAgent)
    await f.end(runner.id)
    assert.equal(f.store.updateRequest(f.request.id, { status: 'completed' }).status, 'completed')
  } finally { await f.close() }
})

test('a closed request keeps the run already cited in a formal record', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const { agent, startRun, complete } = await startRunner(f, createCandidate('Measure cost').id)
    const run = startRun()
    f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 5 } }, agent)
    await complete([run.id])
    f.tools.research_request_update({ id: f.request.id, status: 'completed' })
    const record = f.tools.research_record_add({ kind: 'experiment', task_id: f.task.id, run_ids: [run.id], question: f.task.question,
      observations: { cost: 5 }, verdict: 'supported', conclusion: 'Measured 5 units', evidence: [{ kind: 'metric', path: 'cost' }],
      provenance: { source: 'test' }, parents: [] })

    assert.throws(() => f.tools.research_run_finalize({ id: run.id, status: 'failed', metrics: { cost: 100 } }, agent), /already finalized/)
    assert.throws(() => f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 100 } }, agent), /already finalized/)
    assert.equal(f.store.getRequest(f.request.id)?.status, 'completed')
    assert.deepEqual(f.store.getRun(run.id)?.metrics, { cost: 5 })
    assert.deepEqual(f.store.getRecord(record.id)?.observations, { cost: 5 })
  } finally { await f.close() }
})

test('candidate success requires a successful run with measured evidence and retains the finalized-run checks', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Measure effect')
    const { agent, startRun, complete } = await startRunner(f, candidate.id)
    const cancelled = startRun()
    f.tools.research_run_finalize({ id: cancelled.id, status: 'cancelled' }, agent)
    const decision = () => f.tools.research_candidate_update({ id: candidate.id, status: 'succeeded' }, agent)
    assert.throws(decision, /succeeded run with measured evidence/)
    assert.throws(() => f.tools.research_candidate_update({ id: candidate.id, status: 'inconclusive' }, agent), /recorded evidence/)

    const failed = startRun()
    f.tools.research_run_finalize({ id: failed.id, status: 'failed', metrics: { cost: 10 }, error: 'Measured failure' }, agent)
    assert.throws(decision, /succeeded run with measured evidence/)

    const empty = startRun()
    f.tools.research_run_finalize({ id: empty.id, status: 'succeeded', metrics: { effect: null, note: ' ' } }, agent)
    assert.throws(decision, /succeeded run with measured evidence/)

    const measured = startRun()
    assert.throws(decision, /must be a finalized run/)
    f.tools.research_run_finalize({ id: measured.id, status: 'succeeded', metrics: { effect: 0 } }, agent)
    await complete([cancelled.id, failed.id, empty.id, measured.id])
    assert.equal(f.tools.research_request_update({ id: f.request.id, status: 'completed' }).status, 'completed')
  } finally { await f.close() }
})

test('closure rechecks older candidate decisions and accepts a documented unsuccessful experiment', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Legacy candidate decision')
    const legacy = await startRunner(f, candidate.id)
    const run = legacy.startRun()
    f.tools.research_run_finalize({ id: run.id, status: 'cancelled' }, legacy.agent)
    const legacyCandidate = { ...f.store.getCandidate(candidate.id), status: 'succeeded' }
    f.store.db.prepare('UPDATE research_candidates SET status=?, payload=? WHERE id=?')
      .run('succeeded', JSON.stringify(legacyCandidate), candidate.id)
    f.store.reportAssignment(legacy.runner.id, { status: 'completed',
      report: { task_id: f.task.id, candidate_id: candidate.id, run_ids: [run.id], evidence: [] } })
    assert.throws(() => f.tools.research_request_update({ id: f.request.id, status: 'completed' }), /measured candidate/)

    const later = await startRunner(f, createCandidate('Test with a diagnostic').id)
    const failed = later.startRun()
    f.tools.research_run_finalize({ id: failed.id, status: 'failed', error: 'Fixture stopped at its measured resource limit' }, later.agent)
    await later.complete([failed.id], 'inconclusive')
    assert.equal(f.tools.research_request_update({ id: f.request.id, status: 'completed' }).status, 'completed')
  } finally { await f.close() }
})

test('cancelling a proposed candidate withdraws its queued runner and dependents without waiving measured closure', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Withdraw this candidate')
    const runner = f.create('runner')
    f.tools.research_candidate_update({ id: candidate.id, runner_assignment_id: runner.id }, f.parent)
    const audit = f.create('auditor', [runner.id])
    const summary = f.create('synthesizer', [audit.id])
    f.tools.research_candidate_update({ id: candidate.id, status: 'cancelled' }, f.parent)
    for (const work of [runner, audit, summary]) assert.equal(f.store.getAssignment(work.id)?.status, 'cancelled')
    assert.throws(() => f.create('auditor', [runner.id]), /Dependency was cancelled/)
    await assert.rejects(f.dispatcher.resume(runner.id, 'Continue', f.parent, new AbortController().signal), /Cannot resume cancelled/)
    assert.throws(() => f.tools.research_request_update({ id: f.request.id, status: 'completed' }), /measured candidate/)
    f.tools.research_candidate_update({ id: candidate.id, status: 'cancelled' }, f.parent)
    assert.equal(f.store.listDispatchEvents(f.request.id).filter(event => event.type === 'assignment-cancelled').length, 3)

    const alternate = await startRunner(f, createCandidate('Test a separate candidate').id)
    const run = alternate.startRun()
    f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 1 } }, alternate.agent)
    await alternate.complete([run.id])
    assert.equal(f.tools.research_request_update({ id: f.request.id, status: 'completed' }).status, 'completed')
  } finally { await f.close() }
})

test('a running candidate runner must pause before the controller can withdraw it', async () => {
  const f = setup()
  try {
    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Pause before cancelling')
    const { runner, startRun } = await startRunner(f, candidate.id)
    const cancel = () => f.tools.research_candidate_update({ id: candidate.id, status: 'cancelled' }, f.parent)
    assert.throws(cancel, /Pause the candidate runner/)
    assert.equal(f.store.getCandidate(candidate.id)?.status, 'proposed')
    assert.equal(f.store.getAssignment(runner.id)?.status, 'running')
    await f.dispatcher.pause(runner.id, f.parent)
    assert.equal(cancel().status, 'cancelled')
    assert.equal(f.store.getAssignment(runner.id)?.status, 'cancelled')
    assert.throws(startRun, /active runner assignment/)
    await assert.rejects(f.dispatch(runner.id), /not runnable|Cannot dispatch cancelled/)
    await f.dispatcher.stop(f.request.id, f.parent)
    assert.equal(f.store.getAssignment(runner.id)?.status, 'cancelled')
  } finally { await f.close() }
})

test('manual waiting survives live settlement and allows only an evidenced request to close directly', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-controller-hold-'))
  const path = join(directory, 'research.sqlite')
  const f = setup(new ResearchStore(path))
  const controller = new ResearchStore(path)
  const tools = createResearchTools(new ResearchApi(controller))
  try {
    const createCandidate = await candidateFactory(f)
    const executing = await startRunner(f, createCandidate('Confirm the measured result').id)
    const run = executing.startRun()
    const last_error = 'Wait for user confirmation'
    tools.research_request_update({ id: f.request.id, status: 'waiting', last_error })
    const closeRequest = () => tools.research_request_update({ id: f.request.id, status: 'completed' })
    assert.throws(closeRequest, /Resolve every assignment/)
    f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 1 } }, executing.agent)
    await executing.complete([run.id])

    const waiting = tools.research_request_show({ id: f.request.id })!
    assert.equal(waiting.status, 'waiting')
    assert.equal(waiting.last_error, last_error)
    assert.equal(waiting.controller_hold, 'waiting')
    assert.equal(closeRequest().status, 'completed')
    assert.equal(f.store.getRequest(f.request.id)?.last_error, undefined)
  } finally { controller.close(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('assignment work locks request task and direction while its measured report still closes the original request', async () => {
  const f = setup()
  try {
    const alternateTask = f.store.createTask({ direction_id: f.direction.id, title: 'Different task', question: 'Different measurement?' })
    const alternateDirection = f.store.createDirection({ title: 'Different direction' })
    const changeTask = (task_id: string) => f.tools.research_request_update({ id: f.request.id, task_id })
    assert.equal(changeTask(alternateTask.id).task_id, alternateTask.id)
    assert.throws(() => f.tools.research_request_update({ id: f.request.id, direction_id: alternateDirection.id }), /task must belong to its direction/)
    changeTask(f.task.id)

    const createCandidate = await candidateFactory(f)
    const candidate = createCandidate('Original task evidence')
    assert.equal(candidate.direction_id, f.direction.id)
    assert.equal(candidate.task_id, f.task.id)
    assert.throws(() => f.tools.research_request_accept({ id: f.request.id, task_id: alternateTask.id }), /cannot change after work has started/)
    const runner = await startRunner(f, candidate.id)
    const run = runner.startRun()
    f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 1 } }, runner.agent)
    assert.throws(() => changeTask(alternateTask.id), /cannot change after work has started/)
    await runner.complete([run.id])
    assert.equal(f.tools.research_request_update({ id: f.request.id, status: 'completed' }).task_id, f.task.id)
    assert.throws(() => changeTask(alternateTask.id), /cannot change after work has started/)
  } finally { await f.close() }
})

test('pause and resume retain the child identity; stop cannot be undone by late results', async () => {
  const f = setup()
  try {
    const work = f.create(); const active = await f.dispatch(work.id)
    await f.dispatcher.pause(work.id, f.parent)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    assert.deepEqual(f.store.listDispatchEvents(f.request.id).filter(event => event.type === 'request-updated').at(-1)?.payload, {
      from: 'running', to: 'waiting', automatic: true, reason: 'assignment-settled', assignment_id: work.id,
    })
    const resumed = await f.dispatcher.resume(work.id, 'Continue from artifacts', f.parent, new AbortController().signal)
    assert.equal(resumed.child_id, active.child_id)
    assert.equal(resumed.attempt, 2)
    assert.deepEqual(f.store.listDispatchEvents(f.request.id).filter(event => event.type === 'request-updated').at(-1)?.payload, {
      from: 'waiting', to: 'running', automatic: true, reason: 'assignment-started', assignment_id: work.id,
    })
    assert.deepEqual(f.messages, [{ id: active.child_id, text: `Resume ${work.id}. Check existing work first; avoid duplicates. Continue from artifacts` }])
    await f.dispatcher.stop(f.request.id, f.parent)
    const stoppedTrace = f.store.listDispatchEvents(f.request.id)
    f.dispatcher.settle({ id: active.child_id as never, stopReason: 'completed' }, resumed.attempt)
    assert.equal(f.store.getRequest(f.request.id)?.status, 'stopped')
    assert.equal(f.store.getAssignment(work.id)?.status, 'stopped')
    assert.deepEqual(f.store.listDispatchEvents(f.request.id), stoppedTrace)
  } finally { await f.close() }
})

test('desktop/web sharing survives reopening; recovery touches only dead owners and preserves reports', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'research-sharing-'))
  const f = setup(new ResearchStore(join(directory, 'research.sqlite')))
  const other = new ResearchStore(join(directory, 'research.sqlite'))
  try {
    const work = f.create(); await f.dispatch(work.id); f.report(work.id)
    assert.deepEqual(other.recoverDispatch(() => true), { requests: 0, assignments: 0 })
    assert.equal(other.getAssignment(work.id)?.status, 'running')
    assert.equal(other.recoverDispatch(() => false).assignments, 1)
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    assert.ok(f.store.getAssignment(work.id)?.report)
    const recoveredTrace = f.store.listDispatchEvents(f.request.id)
    assert.deepEqual(recoveredTrace.filter(event => event.type === 'request-updated').at(-1)?.payload, {
      from: 'running', to: 'waiting', automatic: true, reason: 'assignment-settled', assignment_id: work.id,
    })
    assert.equal(other.recoverDispatch(() => false).assignments, 0)
    assert.deepEqual(other.listDispatchEvents(f.request.id), recoveredTrace)
    const reopened = new ResearchStore(join(directory, 'research.sqlite'))
    try { assert.deepEqual(reopened.listDispatchEvents(f.request.id), recoveredTrace) } finally { reopened.close() }
  } finally { other.close(); await f.close(); rmSync(directory, { recursive: true, force: true }) }
})

const incubationPolicy: IncubationPolicy = {
  metric: 'total_cost', effect_direction: 'lower_better', control_effect: 100, graduate_ratio: 1,
  min_gap_closure: 0.2, patience: 1, max_rounds: 5, max_total_cost_units: 100, max_failed_rounds: 1,
}
function openIncubation(f: ReturnType<typeof setup>, policy = incubationPolicy, agent: Agent = f.parent) {
  return f.tools.research_incubation_open({
    direction_id: f.direction.id, title: 'Replace the solver', architecture: 'A recurrence in place of the Euclidean solver.',
    control_description: 'Tuned public control', control_evidence: [{ kind: 'file', path: 'control/official.json' }], policy,
  }, agent)
}
/** Runs one incubation round to a finalized run and a closed candidate. */
async function incubationRound(f: ReturnType<typeof setup>, candidateId: string, metrics: Record<string, number> | undefined) {
  const round = await startRunner(f, candidateId)
  const run = round.startRun()
  f.tools.research_run_finalize(metrics ? { id: run.id, status: 'succeeded', metrics }
    : { id: run.id, status: 'failed', error: 'The build did not finish.' }, round.agent)
  await round.complete([run.id], 'inconclusive')
  return run
}

test('incubation judges a structural candidate by its gap trend and keeps hard limits outside the model', () => {
  const round = (effect: number | undefined, cost_units = 1, index = 0) => ({ run_id: `run-${index}`, valid: effect !== undefined, effect, cost_units })
  const decide = (effects: Array<number | undefined>, policy = incubationPolicy) => recommendIncubation(policy, effects.map((effect, index) => round(effect, 1, index)))

  assert.equal(decide([]).reason_code, 'no_round')
  const first = decide([317])
  assert.deepEqual([first.action, first.reason_code, first.ratio, first.rounds_left], ['continue', 'closing', 3.17, 4], 'A first version behind the control stays open')
  const closing = decide([300, 200])
  assert.deepEqual([closing.action, closing.window_closure], ['continue', 0.5])
  const stalled = decide([300, 200, 195])
  assert.deepEqual([stalled.action, stalled.reason_code], ['stop', 'stalled'])
  assert.ok(Math.abs(stalled.window_closure! - 0.05) < 1e-9)
  assert.equal(decide([300, 310, 150], { ...incubationPolicy, patience: 2 }).action, 'continue', 'A worse intermediate round is tolerated within patience')
  assert.deepEqual([decide([300, 95]).action, decide([300, 95]).reason_code], ['graduate', 'graduated'])
  const higher = { ...incubationPolicy, effect_direction: 'higher_better' as const, control_effect: 10 }
  assert.deepEqual([decide([4, 5], higher).reason_code, decide([4, 4.1], higher).reason_code, decide([4, 10], higher).action], ['closing', 'stalled', 'graduate'])
  assert.equal(decide([2000], { ...incubationPolicy, max_entry_ratio: 10 }).reason_code, 'entry_gap')
  assert.equal(decide([300, 200, 150, 110, 105]).reason_code, 'round_limit')
  assert.equal(recommendIncubation(incubationPolicy, [round(300, 60, 0), round(200, 40, 1)]).reason_code, 'cost_limit')
  assert.deepEqual([decide([300, undefined]).action, decide([300, undefined]).reason_code], ['continue', 'invalid_round'])
  assert.equal(decide([300, undefined, undefined]).reason_code, 'too_many_failures')
  assert.equal(recommendIncubation(incubationPolicy, [round(300, 99, 0), round(90, 5, 1)]).action, 'graduate', 'Reaching the control on the last affordable round still graduates')

  for (const invalid of [{ min_gap_closure: 0 }, { min_gap_closure: 1 }, { patience: 0 }, { max_rounds: 1 }, { control_effect: 0 }, { metric: ' ' }, { max_entry_ratio: 1 }, { max_total_cost_units: Infinity }]) {
    assert.throws(() => validateIncubationPolicy({ ...incubationPolicy, ...invalid }), /Incubation/)
  }
})

test('an incubation carries a structural candidate across rounds and stops only on its fixed limits', async () => {
  const f = setup()
  try {
    assert.throws(() => openIncubation(f, incubationPolicy, child('scout-child')), /Only the controller/)
    assert.throws(() => f.tools.research_incubation_open({ direction_id: f.direction.id, title: 'x', architecture: 'y', control_description: 'z', control_evidence: [], policy: incubationPolicy }, f.parent), /evidence/)
    const incubation = openIncubation(f)
    assert.deepEqual([incubation.status, incubation.decision.reason_code, f.store.overview().active_incubations], ['incubating', 'no_round', 1])
    assert.equal(f.store.getIncubation(incubation.id)!.policy.max_rounds, 5)

    const createCandidate = await candidateFactory(f)
    const fromScout = f.store.listSources()[0]!
    const roundCandidate = (extra: { source_ids: string[]; based_on_run_id?: string; incubation_id?: string }) => f.tools.research_candidate_create({
      request_id: f.request.id, title: 'Round', question: f.task.question, mechanism: fromScout.mechanism_hypothesis,
      minimal_experiment: fromScout.minimal_experiment, pass_gate: fromScout.pass_gate, stop_gate: fromScout.stop_gate,
      incubation_id: incubation.id, ...extra,
    }, f.parent)
    assert.throws(() => roundCandidate({ source_ids: [] }), /at least one scout source/, 'The first round still needs a sourced mechanism')
    assert.throws(() => roundCandidate({ source_ids: [fromScout.id], based_on_run_id: 'run-missing' }), /latest recorded round/)
    assert.throws(() => roundCandidate({ source_ids: [], based_on_run_id: 'run-missing', incubation_id: undefined }), /requires an incubation_id/)

    const first = roundCandidate({ source_ids: [fromScout.id] })
    assert.equal(first.incubation_id, incubation.id)
    assert.throws(() => roundCandidate({ source_ids: [fromScout.id] }), /Finish the current incubation round first/)
    const round1 = await startRunner(f, first.id)
    const prompt = JSON.parse((f.started.at(-1)!.prompt as Array<{ text: string }>)[0]!.text)
    assert.equal(prompt.incubation.id, incubation.id, 'The runner receives the incubation with its candidate')
    const run1 = round1.startRun()
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: 'x' }, f.parent), /finalized/)
    f.tools.research_run_finalize({ id: run1.id, status: 'succeeded', metrics: { total_cost: 317, cost_units: 2 } }, round1.agent)
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: 'x' }, f.parent), /close the round candidate/)
    await round1.complete([run1.id], 'inconclusive')

    assert.throws(() => roundCandidate({ source_ids: [fromScout.id] }), /Record the finished round/, 'A measured round cannot be skipped')
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: 'x' }, child('runner-child')), /Only the controller/)
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: ' ' }, f.parent), /bottleneck/)
    const afterFirst = f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: 'Row arithmetic: 204 of 317', next_change: 'Share partial products' }, f.parent)
    assert.deepEqual([afterFirst.status, afterFirst.decision.action, afterFirst.rounds[0]!.ratio, afterFirst.rounds[0]!.cost_units], ['incubating', 'continue', 3.17, 2],
      'A first version at 3.17x the control is kept')
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: run1.id, bottleneck: 'x' }, f.parent), /already recorded/)
    const state = f.tools.research_incubations({ status: 'incubating' })
    assert.equal(state[0]!.rounds[0]!.next_change, 'Share partial products')

    // Later rounds build on the recorded run and need no new web source.
    const second = roundCandidate({ source_ids: [], based_on_run_id: run1.id })
    assert.deepEqual([second.based_on_run_id, second.source_ids], [run1.id, []])
    const run2 = await incubationRound(f, second.id, { total_cost: 200, cost_units: 3 })
    const afterSecond = f.tools.research_incubation_round({ id: incubation.id, run_id: run2.id, bottleneck: 'Carry schedule: 120 of 200' }, f.parent)
    assert.deepEqual([afterSecond.status, afterSecond.decision.reason_code], ['incubating', 'closing'])
    assert.throws(() => roundCandidate({ source_ids: [], based_on_run_id: run1.id }), /latest recorded round/)

    const third = roundCandidate({ source_ids: [], based_on_run_id: run2.id })
    const run3 = await incubationRound(f, third.id, { total_cost: 195, cost_units: 3 })
    const stopped = f.tools.research_incubation_round({ id: incubation.id, run_id: run3.id, bottleneck: 'Carry schedule: 118 of 195' }, f.parent)
    assert.deepEqual([stopped.status, stopped.decision.reason_code], ['stopped', 'stalled'])
    assert.match(stopped.status_reason!, /closed 5\.0% of the remaining gap/)
    assert.throws(() => roundCandidate({ source_ids: [], based_on_run_id: run3.id }), /not active: stopped/)
    assert.throws(() => f.tools.research_incubation_update({ id: incubation.id, status: 'incubating', reason: 'Try again' }, f.parent), /Invalid incubation transition/)
    assert.equal(f.store.overview().active_incubations, 0)
    assert.equal(createCandidate('An ordinary single screen').incubation_id, undefined, 'Ordinary candidates keep the existing path')
  } finally { await f.close() }
})

test('incubation rounds take measurements from the run, count failures, graduate and respect the per-direction limit', async () => {
  const f = setup()
  try {
    const incubation = openIncubation(f)
    const second = openIncubation(f)
    assert.throws(() => openIncubation(f), /already develops 2 incubations/)
    f.tools.research_incubation_update({ id: second.id, status: 'paused', reason: 'Waiting for a rebuildable source' }, f.parent)
    const third = openIncubation(f)
    assert.throws(() => f.tools.research_incubation_update({ id: second.id, status: 'incubating', reason: 'Resume' }, f.parent), /already develops 2/)
    f.tools.research_incubation_update({ id: third.id, status: 'stopped', reason: 'Opened to test the limit' }, f.parent)
    assert.throws(() => f.tools.research_incubation_update({ id: second.id, status: 'incubating', reason: ' ' }, f.parent), /reason/)

    await candidateFactory(f)
    const source = f.store.listSources()[0]!
    const candidate = (incubationId: string, based_on_run_id?: string) => f.tools.research_candidate_create({
      request_id: f.request.id, title: 'Round', question: f.task.question, mechanism: source.mechanism_hypothesis,
      minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
      incubation_id: incubationId, source_ids: based_on_run_id ? [] : [source.id], based_on_run_id,
    }, f.parent)
    assert.throws(() => candidate(second.id), /not active: paused/)

    const noCost = await incubationRound(f, candidate(incubation.id).id, { total_cost: 250 })
    assert.throws(() => f.tools.research_incubation_round({ id: incubation.id, run_id: noCost.id, bottleneck: 'x' }, f.parent), /cost_units/)
    assert.throws(() => f.tools.research_incubation_round({ id: second.id, run_id: noCost.id, bottleneck: 'x' }, f.parent), /not active/)
    f.store.db.prepare('UPDATE runs SET payload = json_set(payload, \'$.metrics.cost_units\', 4) WHERE id = ?').run(noCost.id)
    const measured = f.tools.research_incubation_round({ id: incubation.id, run_id: noCost.id, bottleneck: 'Lookup: 150 of 250', control_effect: 125 }, f.parent)
    assert.deepEqual([measured.rounds[0]!.ratio, measured.rounds[0]!.control_effect, measured.rounds[0]!.scale_stage_id], [2, 125, 'small'])

    const failedRun = await incubationRound(f, candidate(incubation.id, noCost.id).id, undefined)
    const afterFailure = f.tools.research_incubation_round({ id: incubation.id, run_id: failedRun.id, bottleneck: 'Build failure in cleanup' }, f.parent)
    assert.deepEqual([afterFailure.status, afterFailure.decision.reason_code, afterFailure.rounds[1]!.valid], ['incubating', 'invalid_round', false])

    const winning = await incubationRound(f, candidate(incubation.id, failedRun.id).id, { total_cost: 90, cost_units: 5 })
    const graduated = f.tools.research_incubation_round({ id: incubation.id, run_id: winning.id, bottleneck: 'None above the control' }, f.parent)
    assert.deepEqual([graduated.status, graduated.decision.action, graduated.decision.best_ratio], ['graduated', 'graduate', 0.9])
    assert.throws(() => candidate(incubation.id, winning.id), /not active: graduated/)
    assert.equal(f.store.listIncubations({ direction_id: f.direction.id }).length, 3)
  } finally { await f.close() }
})

test('the status board shows open work, incubation trends and where each line ended, and writes nothing', async () => {
  const f = setup()
  try {
    const empty = buildBoard(f.store)
    assert.deepEqual([empty.agents, empty.incubations, empty.lines], [[], [], []])
    assert.deepEqual(empty.requests.map(item => [item.id, item.status]), [[f.request.id, 'accepted']])

    const createCandidate = await candidateFactory(f)
    const kept = createCandidate('Cache the lookup')
    const dropped = createCandidate('Recompute every step')
    const first = await startRunner(f, kept.id)
    const run = first.startRun()
    const working = buildBoard(f.store)
    const agent = working.agents[0]!
    assert.deepEqual([working.agents.length, agent.assignment_id, agent.role, agent.status, agent.request_title, agent.direction, agent.candidate, agent.run?.id, agent.run?.status, agent.run?.scale_stage_id],
      [1, first.runner.id, 'runner', 'running', f.request.title, 'Dispatch fixture', { id: kept.id, title: 'Cache the lookup' }, run.id, 'running', 'small'])
    assert.equal(agent.incubation, undefined)
    assert.deepEqual(working.lines.map(group => [group.direction_title, group.counts.pending + group.counts.active, group.items.length]), [['Dispatch fixture', 2, 2]])
    f.tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 5 } }, first.agent)
    await first.complete([run.id])

    // A line that ended with only the runner's own report says so; a formal record replaces it once the controller writes one.
    const second = await startRunner(f, dropped.id)
    const run2 = second.startRun()
    f.tools.research_run_finalize({ id: run2.id, status: 'succeeded', metrics: { cost: 40 } }, second.agent)
    f.tools.research_candidate_update({ id: dropped.id, status: 'refuted', run_ids: [run2.id] }, second.agent)
    f.dispatcher.report(second.runner.id, { status: 'completed', report: {
      task_id: f.task.id, candidate_id: dropped.id, run_ids: [run2.id], evidence: [{ kind: 'log', path: 'fixture.log' }], findings: [{ conclusion: 'No saving at this size.' }],
    } }, second.agent)
    await f.end(second.runner.id)
    const cache: BoardCache = {}
    const line = (id: string) => buildBoard(f.store, cache).lines.flatMap(group => group.items).find(item => item.id === id)!
    assert.deepEqual([line(dropped.id).outcome, line(dropped.id).reason, line(dropped.id).reason_source, line(dropped.id).runs], ['abandoned', 'No saving at this size.', 'report', 1])
    assert.deepEqual([line(kept.id).outcome, line(kept.id).reason], ['adopted', undefined], 'Nothing is invented when no reason was recorded')
    const record = f.tools.research_record_add({ kind: 'experiment', task_id: f.task.id, run_ids: [run.id], question: f.task.question,
      observations: { cost: 5 }, verdict: 'supported', conclusion: 'Caching cut the cost to 5 units.', evidence: [{ kind: 'metric', path: 'cost' }],
      provenance: { source: 'test' }, parents: [] })
    assert.deepEqual([line(kept.id).reason, line(kept.id).reason_source, line(kept.id).record_id], ['Caching cut the cost to 5 units.', 'record', record.id], 'A new record is seen through the cache')
    assert.equal(buildBoard(f.store).agents.length, 0, 'Finished assignments leave the board')

    // An incubation is one line however many round candidates it has, and its runner shows the round it is producing.
    const incubation = openIncubation(f)
    const source = f.store.listSources()[0]!
    const round = f.tools.research_candidate_create({
      request_id: f.request.id, title: 'Round', question: f.task.question, mechanism: source.mechanism_hypothesis, source_ids: [source.id],
      minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate, incubation_id: incubation.id,
    }, f.parent)
    const third = await startRunner(f, round.id)
    assert.deepEqual(buildBoard(f.store).agents[0]!.incubation, { id: incubation.id, title: 'Replace the solver', round: 1 })
    const run3 = third.startRun()
    f.tools.research_run_finalize({ id: run3.id, status: 'succeeded', metrics: { total_cost: 317, cost_units: 2 } }, third.agent)
    await third.complete([run3.id], 'inconclusive')
    f.tools.research_incubation_round({ id: incubation.id, run_id: run3.id, bottleneck: 'Row arithmetic: 204 of 317', next_change: 'Share partial products' }, f.parent)

    const before = JSON.stringify([f.store.overview(), f.store.listIncubations(), f.store.listCandidates()])
    const board = buildBoard(f.store)
    const shown = board.incubations[0]!
    assert.deepEqual([board.incubations.length, shown.status, shown.reason_code, shown.ratio, shown.rounds_left, shown.cost_used, shown.max_rounds, shown.direction_title],
      [1, 'incubating', 'closing', 3.17, 4, 2, 5, 'Dispatch fixture'])
    assert.deepEqual(shown.rounds, [{ index: 1, valid: true, ratio: 3.17, effect: 317, cost_units: 2, bottleneck: 'Row arithmetic: 204 of 317', next_change: 'Share partial products' }])
    const group = board.lines.find(item => item.direction_id === f.direction.id)!
    assert.deepEqual([group.counts, group.items.map(item => [item.kind, item.id, item.outcome, item.runs])], [
      { active: 1, adopted: 1, abandoned: 1, undecided: 0, pending: 0 },
      [['incubation', incubation.id, 'active', 1], ['candidate', kept.id, 'adopted', 1], ['candidate', dropped.id, 'abandoned', 1]],
    ], 'Work in progress comes first and abandoned lines last')
    assert.equal(board.lines.flatMap(item => item.items).some(item => item.id === round.id), false)
    assert.equal(JSON.stringify([f.store.overview(), f.store.listIncubations(), f.store.listCandidates()]), before, 'Reading the board changes nothing')

    f.tools.research_request_update({ id: f.request.id, status: 'completed' })
    assert.deepEqual(buildBoard(f.store).requests, [], 'A closed request leaves the board')
    assert.deepEqual([reportReason({ summary: ' ' }), reportReason({ verdict: 'Too wide.' }), reportReason('  Plain text  '), reportReason(['x'])], [undefined, 'Too wide.', 'Plain text', undefined])
  } finally { await f.close() }
})
