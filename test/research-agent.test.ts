import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseFrontmatter } from '../src/importer/frontmatter.ts'
import { importExperimentLog } from '../src/importer/experiment-log.ts'
import { ResearchApi, createResearchTools } from '../src/dsh/api.ts'
import { registerResearchHttp } from '../src/dsh/http.ts'
import { ResearchStore } from '../src/store/sqlite.ts'
import { extractQuantumMetrics, isQuantumCandidate } from '../src/adapters/quantum.ts'
import { recommendNextScale } from '../src/core/adaptive.ts'

test('frontmatter parser preserves scalar, arrays, and folded continuation text', () => {
  const value = parseFrontmatter(`---\nid: E-1\ntags:\n- one\n- two\ndid: first line\n  second line\n---\nbody`)
  assert.equal(value.id, 'E-1')
  assert.deepEqual(value.tags, ['one', 'two'])
  assert.equal(value.did, 'first line\nsecond line')
})

test('store keeps runs separate from append-only research records', () => {
  const store = new ResearchStore()
  const direction = store.createDirection({ title: 'GPU kernels', goal: 'Find a reusable dataflow' })
  const task = store.createTask({ direction_id: direction.id, title: 'Cache hypothesis', question: 'Does tiling reduce memory traffic?' })
  const run = store.startRun({ direction_id: direction.id, task_id: task.id, worker: 'local' })
  store.finalizeRun(run.id, { status: 'succeeded', metrics: { bytes: 12 } })
  const record = store.addRecord({ kind: 'experiment', direction_id: direction.id, task_id: task.id, run_ids: [run.id], question: task.question, observations: { bytes: 12 }, verdict: 'observed', conclusion: 'The run completed.', evidence: [], provenance: { source: 'test' }, parents: [] })
  assert.equal(store.getRun(run.id)?.status, 'succeeded')
  assert.equal(store.getRecord(record.id)?.run_ids[0], run.id)
  assert.equal(store.getTask(task.id)?.status, 'completed')
  assert.equal(store.overview().records, 1)
  store.close()
})

test('store rejects orphaned or unfinished run references in research records', () => {
  const store = new ResearchStore()
  const direction = store.createDirection({ title: 'Integrity' })
  const task = store.createTask({ direction_id: direction.id, title: 'Pinned run', question: 'Can an unfinished run be cited?' })
  const run = store.startRun({ direction_id: direction.id, task_id: task.id })
  const base = { kind: 'experiment' as const, direction_id: direction.id, task_id: task.id, question: task.question, observations: {}, verdict: 'inconclusive' as const, conclusion: 'Not measured yet.', evidence: [], provenance: { source: 'test' }, parents: [] }
  assert.throws(() => store.addRecord({ ...base, run_ids: [run.id] }), /must be finalized/)
  assert.throws(() => store.addRecord({ ...base, run_ids: ['missing-run'] }), /Run not found/)
  store.finalizeRun(run.id, { status: 'failed', error: 'fixture failure' })
  const record = store.addRecord({ ...base, run_ids: [run.id] })
  assert.deepEqual(record.run_ids, [run.id])
  store.close()
})

test('finalized evidence remains unchanged across connections and supports exact retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-finalized-evidence-'))
  const dbPath = join(root, 'research.sqlite')
  const store = new ResearchStore(dbPath)
  const other = new ResearchStore(dbPath)
  try {
    const tools = createResearchTools(new ResearchApi(other))
    const run = store.startRun({})
    const artifacts = [{ kind: 'log' as const, path: 'fixture.log', sha256: 'fixture-hash' }]
    const finished = store.finalizeRun(run.id, { status: 'succeeded', metrics: { cost: 5, effect: 0.96 }, artifacts })
    const record = store.addRecord({ kind: 'experiment', run_ids: [run.id], question: 'How much did it cost?', observations: { cost: 5 },
      verdict: 'observed', conclusion: 'Measured 5 units', evidence: artifacts, provenance: { source: 'test' }, parents: [] })

    assert.deepEqual(tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { effect: 0.96, cost: 5 } }), other.getRun(run.id))
    assert.throws(() => tools.research_run_finalize({ id: run.id, status: 'failed', metrics: { cost: 100 } }), /already finalized/)
    assert.throws(() => tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 100 } }), /already finalized/)
    assert.throws(() => tools.research_run_finalize({ id: run.id, status: 'succeeded', artifacts: [] }), /already finalized/)
    assert.throws(() => tools.research_run_finalize({ id: run.id, status: 'succeeded', finished_at: '2020-01-01' }), /already finalized/)
    assert.equal(other.getRun(run.id)?.updated_at, finished.updated_at)
    assert.deepEqual(other.getRun(run.id)?.metrics, { cost: 5, effect: 0.96 })
    assert.deepEqual(other.getRun(run.id)?.artifacts, artifacts)
    assert.deepEqual(other.getRecord(record.id)?.observations, { cost: 5 })
  } finally {
    other.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('task status summarizes all runs across database connections and is independent of finish order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-task-runs-'))
  const dbPath = join(root, 'research.sqlite')
  const store = new ResearchStore(dbPath)
  const other = new ResearchStore(dbPath)
  try {
    const direction = store.createDirection({ title: 'Parallel experiments' })
    for (const [first, second, expected] of [
      ['succeeded', 'failed', 'completed'],
      ['failed', 'succeeded', 'completed'],
      ['timed_out', 'failed', 'blocked'],
    ] as const) {
      const task = store.createTask({ direction_id: direction.id, title: `${first} then ${second}`, question: 'Aggregate this task.' })
      const runA = store.startRun({ task_id: task.id })
      const runB = other.startRun({ task_id: task.id })
      store.finalizeRun(runA.id, { status: first })
      assert.equal(other.getTask(task.id)?.status, 'running')
      other.finalizeRun(runB.id, { status: second })
      assert.equal(store.getTask(task.id)?.status, expected)
      store.finalizeRun(runA.id, { status: first })
      assert.equal(other.getTask(task.id)?.status, expected)
    }
  } finally {
    other.close()
    store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('experiment-log importer is idempotent and preserves source evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-agent-'))
  await mkdir(join(root, 'experiments/demo/runs'), { recursive: true })
  await writeFile(join(root, 'experiments/demo/DIRECTION.md'), `---\ndirection: Demo\ngoal: Check import\nstatus: active\n---\n`)
  const source = join(root, 'experiments/demo/runs/E-001.md')
  await writeFile(source, `---\nid: E-001\nquestion: Can it import?\ndid: wrote a fixture\nresult: 复现成功\ntakeaway: Keep the raw result\ncaveats: Fixture only\nfollows:\n- E-000\ntags:\n- import\nevidence:\n- reports/demo.json\nnumbers: 'score=12'\n---\n`)
  const store = new ResearchStore()
  const first = await importExperimentLog(root, store)
  const second = await importExperimentLog(root, store)
  assert.equal(first.records, 1)
  assert.equal(second.records, 0)
  const record = store.listRecords()[0]!
  assert.equal(record.verdict, 'supported')
  assert.match(record.evidence[0]!.path, /experiments\/demo\/runs\/E-001\.md/)
  assert.deepEqual(record.parents, ['record-demo-E-000'])
  store.close()
  assert.equal((await readFile(source, 'utf8')).includes('score=12'), true)
})

test('DSH tool surface provides trace and digest operations', () => {
  const store = new ResearchStore()
  const direction = store.createDirection({ title: 'Test', tags: ['cache'] })
  const older = store.addRecord({ kind: 'experiment', direction_id: direction.id, run_ids: [], question: 'old', observations: { tags: ['cache'] }, verdict: 'rejected', conclusion: 'no', evidence: [], provenance: { source: 'test' }, parents: [] })
  const newer = store.addRecord({ kind: 'experiment', direction_id: direction.id, run_ids: [], question: 'new', observations: { tags: ['cache'] }, verdict: 'supported', conclusion: 'yes', evidence: [], provenance: { source: 'test' }, parents: [older.id] })
  const tools = createResearchTools(new ResearchApi(store))
  assert.equal(tools.research_trace({ id: newer.id }).length, 2)
  assert.equal(tools.research_digest({ direction_id: direction.id }).recurring_tags[0]!.tag, 'cache')
  store.close()
})

test('DSH HTTP adapter exposes the state route', async () => {
  const store = new ResearchStore()
  store.createDirection({ title: 'HTTP' })
  let handler: ((request: any, response: any) => Promise<void>) | undefined
  const server = { register(route: any) { handler = route.handler; return () => {} } }
  registerResearchHttp(server, new ResearchApi(store))
  assert.ok(handler)
  let status = 0; let result = ''
  const request = { method: 'GET', url: '/research/api/state', async *[Symbol.asyncIterator]() {} }
  const response = Object.assign(new EventEmitter(), { writeHead(code: number) { status = code }, end(value: string) { result = value } })
  await handler!(request, response)
  assert.equal(status, 200)
  assert.equal(JSON.parse(result).directions, 1)
  store.close()
})

test('quantum adapter extracts resource metrics without changing the generic record shape', () => {
  const metrics = extractQuantumMetrics({ build: { qubits: 881, static_toffoli: 994499 }, full: { score: 123.4, phase_errors: 1 } })
  assert.deepEqual(metrics, { qubits: 881, static_toffoli: 994499, score: 123.4, phase_errors: 1 })
  assert.equal(isQuantumCandidate({ qubits: 10 }), true)
  assert.equal(isQuantumCandidate({ accuracy: 0.2 }), false)
})

test('adaptive planner expands only while effect retention and marginal gain pass gates', () => {
  const policy = { stages: [{ id: 'small', label: 'small', order: 1, scale: 1 }, { id: 'medium', label: 'medium', order: 2, scale: 2 }, { id: 'large', label: 'large', order: 3, scale: 4 }], effect_direction: 'lower_better' as const, baseline_effect: 100, min_effect_retention: 0.9, max_total_cost_units: 100, max_failed_runs: 1, min_marginal_gain_per_cost: 0.05 }
  const first = recommendNextScale(policy, [{ run_id: 'r1', stage_id: 'small', effect: 100, cost_units: 5, valid: true }])
  assert.equal(first.action, 'expand'); assert.equal(first.next_stage_id, 'medium')
  const second = recommendNextScale(policy, [{ run_id: 'r1', stage_id: 'small', effect: 100, cost_units: 5, valid: true }, { run_id: 'r2', stage_id: 'medium', effect: 95, cost_units: 10, valid: true }])
  assert.equal(second.action, 'expand'); assert.equal(second.next_stage_id, 'large')
  const floor = recommendNextScale(policy, [{ run_id: 'r1', stage_id: 'small', effect: 130, cost_units: 5, valid: true }])
  assert.equal(floor.action, 'stop'); assert.equal(floor.reason_code, 'effect_floor')
})

test('tool changes are versioned and cannot bypass the proposal lifecycle', () => {
  const store = new ResearchStore()
  const base = store.registerToolVersion({ tool_name: 'runner', version: '1', source_hash: 'aaa', environment: { node: 26 }, status: 'active' })
  const candidate = store.registerToolVersion({ tool_name: 'runner', version: '2', source_hash: 'bbb', environment: { node: 26 } })
  const proposal = store.proposeToolChange({ tool_name: 'runner', base_version_id: base.id, candidate_version_id: candidate.id, reason: 'Reduce setup time', expected_impact: 'Same result with lower cost', validation_plan: { shadow_runs: 2 } })
  assert.equal(proposal.status, 'proposed')
  assert.throws(() => store.reviewToolChange(proposal.id, 'accepted'), /Invalid tool change transition/)
  assert.equal(store.reviewToolChange(proposal.id, 'shadow').status, 'shadow')
  assert.throws(() => store.reviewToolChange(proposal.id, 'accepted'), /validation evidence/)
  assert.throws(() => store.startRun({ tool_version_ids: ['missing'] }), /Tool version not found/)
  assert.throws(() => store.proposeToolChange({ tool_name: 'runner', base_version_id: 'missing', reason: 'bad', expected_impact: 'bad', validation_plan: {} }))
  store.close()
})

test('main-session requests persist dispatch lifecycle, reports, and restart recovery', () => {
  const store = new ResearchStore()
  const request = store.submitRequest({ title: 'Main session request', message: 'Test the small configuration first.', session_id: 'main-1' })
  assert.equal(request.channel, 'main-session')
  assert.equal(store.overview().queued_requests, 1)
  assert.equal(store.claimRequest(request.id).status, 'assessing')
  const direction = store.createDirection({ title: 'Dispatch direction' })
  const task = store.createTask({ direction_id: direction.id, title: 'Small test', question: 'Does the small test retain effect?' })
  assert.equal(store.acceptRequest(request.id, { direction_id: direction.id, task_id: task.id }).status, 'accepted')
  const assignment = store.createAssignment({ request_id: request.id, role: 'runner', instruction: 'Run the pinned small test.' })
  assert.equal(store.getRequest(request.id)?.status, 'accepted')
  assert.equal(store.startAssignment(assignment.id, 'child-1').attempt, 1)
  assert.equal(store.reportAssignment(assignment.id, { status: 'completed', report: { run_id: 'run-1', measured: true } }).status, 'completed')
  assert.equal(store.getRequest(request.id)?.status, 'accepted')
  assert.equal(store.updateRequest(request.id, { status: 'completed' }).status, 'completed')
  assert.ok(store.listDispatchEvents(request.id).some(event => event.type === 'assignment-report'))

  const recovering = store.submitRequest({ title: 'Recover me', message: 'Continue after restart.' })
  store.claimRequest(recovering.id)
  const recovered = store.recoverDispatch(() => false)
  assert.equal(recovered.requests, 1)
  assert.equal(store.getRequest(recovering.id)?.status, 'waiting')
  assert.match(store.getRequest(recovering.id)?.last_error ?? '', /stopped/)
  assert.deepEqual(store.listDispatchEvents(recovering.id).filter(event => event.type === 'request-updated').map(event => event.payload), [
    { from: 'assessing', to: 'waiting', automatic: true, reason: 'request-recovered' },
  ])
  assert.ok(store.listDispatchEvents(recovering.id).some(event => event.type === 'request-recovered'))
  store.close()
})

test('scout sources require complete provenance and hypotheses, and request completion requires a measured candidate', () => {
  const store = new ResearchStore()
  const request = store.submitRequest({ title: 'Source-backed loop', message: 'Find a tested mechanism.', session_id: 'main' })
  store.claimRequest(request.id)
  const direction = store.createDirection({ title: 'Source-backed research' })
  const task = store.createTask({ direction_id: direction.id, title: 'Test mechanism', question: 'Does the documented reuse reduce measured cost?' })
  store.acceptRequest(request.id, { direction_id: direction.id, task_id: task.id })
  const scout = store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Search sources and propose tests.' })
  store.startAssignment(scout.id, 'scout-child')
  const sourceBase = {
    request_id: request.id, assignment_id: scout.id, query: 'kernel reuse benchmark',
    url: 'https://example.org/paper', title: 'A measured reuse method', source_type: 'paper' as const,
    claim: 'The method reuses an intermediate result.', applicability: 'It may apply to adjacent arithmetic stages.',
    limitations: 'Different width and precision target.', mechanism_hypothesis: 'Avoid recomputing one shared intermediate.',
    minimal_experiment: { stage_pair: 'A/B', domain: 'reduced exact domain', measure: ['Q', 'branch_weighted_cost'] },
    pass_gate: 'Exact phase and at least 5% complete cost reduction.', stop_gate: 'Stop if phase differs or cleanup erases savings.',
  }
  assert.throws(() => store.addSource({ ...sourceBase, url: 'file:///etc/passwd' }), /http\(s\)/)
  const source = store.addSource(sourceBase)
  assert.equal(store.listSources({ request_id: request.id })[0]?.id, source.id)
  assert.equal(source.retrieved_at, source.created_at)
  assert.throws(() => store.submitAssignmentReport(scout.id, 'scout-child', {
    status: 'completed', report: { task_id: task.id, run_ids: [], evidence: [], findings: 'analysis only' },
  }), /source_ids/)
  assert.throws(() => store.createCandidate({
    request_id: request.id, direction_id: direction.id, task_id: task.id, title: 'Candidate',
    question: task.question, mechanism: source.mechanism_hypothesis, source_ids: [source.id],
    minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
  }), /not complete/)
  const scoutReport = {
    task_id: task.id, run_ids: [], evidence: [{ kind: 'url', path: source.url }],
    source_ids: [source.id], hypotheses: [{
      mechanism: source.mechanism_hypothesis, minimal_experiment: source.minimal_experiment,
      source_ids: [source.id], pass_gate: source.pass_gate, stop_gate: source.stop_gate,
    }],
  }
  assert.throws(() => store.submitAssignmentReport(scout.id, 'scout-child', {
    status: 'completed', report: { ...scoutReport, hypotheses: [{ ...scoutReport.hypotheses[0], mechanism: 'Unsupported mechanism' }] },
  }), /must match captured source fields/)
  assert.throws(() => store.createCandidate({
    request_id: request.id, direction_id: direction.id, task_id: task.id, title: 'Candidate',
    question: task.question, mechanism: source.mechanism_hypothesis, source_ids: [source.id],
    minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
  }), /not complete/)
  store.submitAssignmentReport(scout.id, 'scout-child', { status: 'completed', report: scoutReport })
  store.reportAssignment(scout.id, { status: 'completed', child_id: 'scout-child' })
  const candidate = store.createCandidate({
    request_id: request.id, direction_id: direction.id, task_id: task.id, title: 'Reuse one intermediate',
    question: task.question, mechanism: source.mechanism_hypothesis, source_ids: [source.id],
    minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
  })
  assert.throws(() => store.updateRequest(request.id, { status: 'completed' }), /measured candidate/)
  assert.throws(() => store.createCandidate({
    request_id: request.id, direction_id: direction.id, task_id: task.id, title: 'Mismatched candidate',
    question: task.question, mechanism: 'A different mechanism', source_ids: [source.id],
    minimal_experiment: source.minimal_experiment, pass_gate: source.pass_gate, stop_gate: source.stop_gate,
  }), /match a completed scout hypothesis/)
  const runner = store.createAssignment({ request_id: request.id, role: 'runner', instruction: `Test candidate ${candidate.id}.` })
  store.updateCandidate(candidate.id, { status: 'running', runner_assignment_id: runner.id })
  store.startAssignment(runner.id, 'runner-child')
  assert.throws(() => store.startRun({ direction_id: direction.id, task_id: task.id, candidate_id: candidate.id }), /assigned runner/)
  const run = store.startRun({ direction_id: direction.id, task_id: task.id, candidate_id: candidate.id, runner_assignment_id: runner.id, scale_stage_id: 'small' })
  store.finalizeRun(run.id, { status: 'succeeded', metrics: { cost_units: 1, effect: 0.94 } })
  store.updateCandidate(candidate.id, { status: 'refuted', run_ids: [run.id] })
  const runnerReport = { task_id: task.id, candidate_id: candidate.id, run_ids: [run.id], evidence: [], findings: 'The measured cost missed the pass gate.' }
  const unrelatedRunner = store.createAssignment({ request_id: request.id, role: 'runner', instruction: 'Wrong runner.' })
  store.startAssignment(unrelatedRunner.id, 'wrong-runner-child')
  assert.throws(() => store.submitAssignmentReport(unrelatedRunner.id, 'wrong-runner-child', { status: 'completed', report: runnerReport }), /assigned to this runner/)
  store.reportAssignment(unrelatedRunner.id, { status: 'completed', child_id: 'wrong-runner-child' })
  store.submitAssignmentReport(runner.id, 'runner-child', { status: 'completed', report: runnerReport })
  store.reportAssignment(runner.id, { status: 'completed', child_id: 'runner-child' })
  assert.equal(store.updateRequest(request.id, { status: 'completed' }).status, 'completed')
  store.close()
})
