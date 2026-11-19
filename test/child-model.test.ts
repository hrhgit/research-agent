import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter, ReasoningEffortId, createUserMessage, type GenerateOptions, type StreamChunk, type ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionQuery from '@deepseek-ai/dsh-session-query'
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Subagents, { type SubagentRunEndInfo } from '@deepseek-ai/dsh-subagent'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as ResearchHost from '../src/dsh/plugin.ts'
import { createResearchTools } from '../src/dsh/api.ts'
import type { ChildModelDefaults } from '../src/dsh/child-model.ts'

class FixtureQuery extends SessionQuery {
  override searchSessions(): Promise<never> { throw new Error('Unused search') }
  override searchEvents(): Promise<never> { throw new Error('Unused search') }
}

class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  blockUntilAborted = false
  entered = Promise.withResolvers<void>()
  continueAfter?: Promise<void>
  finishReason: 'stop' | 'max-tokens' = 'max-tokens'
  nextToolCall?: ToolCallBlock
  override async listModels(provider: string) { return ['first', 'second'].map(id => ({ provider, id, name: id })) }
  override async resolveModel(provider: string, model: string) {
    if (!['first', 'second'].includes(model)) throw new Error('Unknown fixture model')
    return { provider, id: model, name: model, reasoning: { efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }], defaultEffort: ReasoningEffortId('low') } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    this.entered.resolve()
    if (this.continueAfter) await this.continueAfter
    if (this.blockUntilAborted) {
      const signal = options.signal!
      signal.throwIfAborted()
      await new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    }
    const call = this.nextToolCall
    if (call) {
      this.nextToolCall = undefined
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `saved evidence ${this.requests.length}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: this.finishReason } }
  }
}

async function fixture(root: string, resumeParent = false, childModelDefaults: ChildModelDefaults = {}) {
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(Persistence, { root: join(root, 'sessions') })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(FixtureQuery)
  await ctx.plugin(Subagents)
  await ctx.plugin(Spawn, { providerName: 'spawn' })
  await ctx.plugin(AgentPresets, { default: 'standard' })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  await ctx.agentPresets.register({ id: 'research-scout', plugins: [{ name: new URL('../src/dsh/agent.ts', import.meta.url).href, config: { role: 'scout' } }] })
  ctx.provide('webServer', { register: () => () => {} } as never)
  ctx.provide('connection', { requestRejection: () => 401 } as never)
  await ctx.plugin(ResearchHost, { dbPath: join(root, 'research.sqlite'), childModelDefaults })
  const adapter = new FixtureModel()
  ctx.llm.registerAdapter(['fixture', 'alternate'], adapter)
  const parentId = SessionId('research-parent')
  // Child settlement wakes the controller; this test scripts child requests only.
  ctx.on('agent/pre-step', async ({ agent }, next) => agent.id === parentId ? { kind: 'reject' as const } : next())
  const options = { provider: 'fixture', model: 'first', reasoningEffort: ReasoningEffortId('low') }
  const parent = resumeParent
    ? (await ctx.agents.resume({ resumeSessionId: parentId, agentOptions: options })).agent
    : await ctx.agentLoop.create(parentId, options)
  const store = ctx.research.store
  const dispatcher = ctx.research.dispatcher!
  const signal = new AbortController().signal
  const settled = () => {
    const done = Promise.withResolvers<SubagentRunEndInfo>()
    const off = ctx.on('subagent/end', info => { off(); done.resolve(info) })
    return done.promise
  }
  return { ctx, store, dispatcher, parent, signal, adapter, settled }
}

test('role defaults select a child model on first dispatch and expose the policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-model-default-'))
  const f = await fixture(root, false, {
    scout: { provider: 'alternate', model: 'second' },
  })
  try {
    const request = f.store.submitRequest({ title: 'Use role default', message: 'Inspect evidence', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const work = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' })
    const done = f.settled()
    const started = await f.dispatcher.dispatch(work.id, f.parent, f.signal)
    await done

    assert.deepEqual(started.child_model, { provider: 'alternate', model: 'second' })
    assert.equal(f.adapter.requests[0].provider, 'alternate')
    assert.equal(f.adapter.requests[0].model, 'second')
    assert.deepEqual(f.dispatcher.listModelDefaults(), {
      scout: { provider: 'alternate', model: 'second' },
    })
  } finally { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('changing the model resumes the same persisted DSH child with history and keeps that model on later resumes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-model-'))
  let f = await fixture(root)
  try {
    const request = f.store.submitRequest({ title: 'Continue with another model', message: 'Inspect evidence', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const work = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' })
    let done = f.settled()
    const first = await f.dispatcher.dispatch(work.id, f.parent, f.signal)
    await done
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    assert.equal(f.ctx.agents.get(first.child_id as ReturnType<typeof SessionId>), undefined)
    assert.equal(f.adapter.requests[0].model, 'first')
    assert.ok(f.adapter.requests[0].tools?.some(tool => tool.name === 'research_source_capture'))
    assert.ok(f.adapter.requests[0].tools?.some(tool => tool.name === 'research_assignment_report'))
    await assert.rejects(f.dispatcher.dispatch(work.id, f.parent, f.signal), /Use research_assignment_resume/)
    assert.equal(f.adapter.requests.length, 1)

    const before = f.store.getAssignment(work.id)
    await assert.rejects(f.dispatcher.resume(work.id, 'Continue', f.parent, f.signal, { provider: 'fixture', model: 'missing' }), /Unknown fixture model/)
    await assert.rejects(f.dispatcher.resume(work.id, 'Continue', f.parent, f.signal, { model: 'second' }), /together/)
    await assert.rejects(f.dispatcher.resume(work.id, 'Continue', f.parent, f.signal, { provider: 'alternate', model: 'second', reasoning_effort: 'unsupported' }))
    assert.deepEqual(f.store.getAssignment(work.id), before)
    assert.equal(f.adapter.requests.length, 1)

    done = f.settled()
    const changed = await f.dispatcher.resume(work.id, 'Continue', f.parent, f.signal, { provider: 'alternate', model: 'second' })
    await done
    assert.equal(changed.child_id, first.child_id)
    assert.deepEqual(changed.child_model, { provider: 'alternate', model: 'second' })
    assert.equal(f.adapter.requests[1].provider, 'alternate')
    assert.equal(f.adapter.requests[1].model, 'second')
    assert.match(JSON.stringify(f.adapter.requests[1].messages), /saved evidence 1/)
    assert.match(JSON.stringify(f.adapter.requests[1].messages), /model changed/)
    assert.equal(f.parent.options.model, 'first')
    assert.equal(f.store.listDispatchEvents(request.id).filter(event => event.type === 'assignment-started').length, 2)

    done = f.settled()
    await f.dispatcher.resume(work.id, 'Continue again', f.parent, f.signal)
    await done
    assert.equal(f.adapter.requests[2].model, 'second')
    assert.match(JSON.stringify(f.adapter.requests[2].messages), /saved evidence 2/)
    const catalog = await f.dispatcher.listModels({ provider: 'fixture' }, f.signal)
    assert.deepEqual((catalog as {id: string}[]).map(item => item.id), ['first', 'second'])

    // Reopen both DSH and SQLite; no live model-selection object survives.
    await f.ctx.fiber.dispose()
    f = await fixture(root, true)
    const report = { task_id: null, run_ids: [], evidence: [], findings: 'Saved context read.' }
    f.adapter.nextToolCall = {
      type: 'tool-call', id: 'resume-report' as ToolCallBlock['id'], name: 'research_assignment_report',
      arguments: JSON.stringify({ id: work.id, status: 'waiting', report }),
    }
    f.adapter.finishReason = 'stop'
    done = f.settled()
    const reopened = await f.dispatcher.resume(work.id, 'Continue after reopening', f.parent, f.signal)
    await done
    assert.equal(reopened.child_id, first.child_id)
    assert.equal(f.adapter.requests[0].provider, 'alternate')
    assert.equal(f.adapter.requests[0].model, 'second')
    assert.match(JSON.stringify(f.adapter.requests[0].messages), /saved evidence 3/)
    assert.ok(f.adapter.requests[0].tools?.some(tool => tool.name === 'research_source_capture'))
    assert.ok(f.adapter.requests[0].tools?.some(tool => tool.name === 'research_assignment_report'))
    assert.equal(f.store.getAssignment(work.id)?.reported_status, 'waiting')
    assert.deepEqual(f.store.getAssignment(work.id)?.report, report)
  } finally { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('a paused resident child keeps queued evidence and changes model before the next request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-resident-'))
  const f = await fixture(root)
  try {
    const request = f.store.submitRequest({ title: 'Pause resident child', message: 'Inspect evidence', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const work = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' })
    f.adapter.blockUntilAborted = true
    const started = await f.dispatcher.dispatch(work.id, f.parent, f.signal)
    await f.adapter.entered.promise
    const child = f.ctx.agents.get(SessionId(started.child_id!))!
    child.inject(createUserMessage({ content: [{ type: 'text', text: 'Queued evidence must survive the pause' }], source: { kind: 'user' } }))

    const paused = await f.dispatcher.pause(work.id, f.parent)
    assert.equal(paused.status, 'waiting')
    assert.equal(child.status, 'idle')
    assert.equal(f.ctx.agents.get(child.id), child)
    assert.equal(child.inbox.nextStep.length, 1)

    f.adapter.blockUntilAborted = false
    const done = f.settled()
    const resumed = await f.dispatcher.resume(work.id, 'Continue', f.parent, f.signal, { provider: 'alternate', model: 'second' })
    await done
    assert.equal(resumed.child_id, child.id)
    assert.equal(f.adapter.requests[1].model, 'second')
    assert.match(JSON.stringify(f.adapter.requests[1].messages), /Queued evidence must survive/)
    assert.equal(f.parent.model.current()?.model, 'first')
  } finally { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})

test('an immediate resume ignores the previous activation result and accepts the new report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-rapid-resume-'))
  const f = await fixture(root)
  try {
    const request = f.store.submitRequest({ title: 'Continue promptly', message: 'Inspect evidence', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const work = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' })
    const done = f.settled()
    const initial = await f.dispatcher.dispatch(work.id, f.parent, f.signal)
    await done
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    f.adapter.blockUntilAborted = true
    f.adapter.entered = Promise.withResolvers<void>()
    // The DSH end notification arrives before the first activation's result.
    const resumed = await f.dispatcher.resume(work.id, 'Keep working', f.parent, f.signal)
    await f.adapter.entered.promise
    const child = f.ctx.agents.get(SessionId(initial.child_id!))!
    assert.equal(child.status, 'running')
    assert.equal(resumed.attempt, 2)
    assert.equal(f.store.getAssignment(work.id)?.status, 'running')
    const report = f.ctx.tools.get('research_assignment_report', child)!
    await report.execute({ id: work.id, status: 'waiting', report: { task_id: null, run_ids: [], evidence: [] } }, { agent: child, signal: f.signal } as never)
    assert.equal(f.store.getAssignment(work.id)?.reported_status, 'waiting')
  } finally {
    await f.ctx.subagents.drainDescendants([f.parent])
    await f.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('DSH child chat interrupt and continuation keep the paused assignment and its report tool in sync', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-native-continuation-'))
  const f = await fixture(root)
  try {
    const request = f.store.submitRequest({ title: 'Continue from child chat', message: 'Inspect evidence', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const work = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' })
    f.adapter.blockUntilAborted = true
    const started = await f.dispatcher.dispatch(work.id, f.parent, f.signal)
    await f.adapter.entered.promise
    const childId = SessionId(started.child_id!)
    const child = f.ctx.agents.get(childId)!
    const prompt = (text: string) => f.ctx.subagents.prompt({
      childSessionId: childId, delivery: 'queue',
      requestId: randomUUID() as Parameters<typeof f.ctx.subagents.prompt>[0]['requestId'],
      content: [{ type: 'text', text }],
    }, f.signal)
    await prompt('Keep the queued evidence')
    assert.equal(child.inbox.nextTurn.length, 1)
    f.ctx.subagents.interruptByUser(childId)
    await child.whenIdle()
    assert.equal(child.status, 'idle')
    assert.equal(f.store.getAssignment(work.id)?.status, 'waiting')
    assert.equal(f.store.getRequest(request.id)?.status, 'waiting')
    assert.equal(child.inbox.nextTurn.length, 1)

    f.adapter.entered = Promise.withResolvers<void>()
    await prompt('Continue the same assignment')
    await f.adapter.entered.promise
    const running = f.store.getAssignment(work.id)!
    assert.equal(running.child_id, childId)
    assert.equal(running.attempt, 2)
    assert.equal(running.status, 'running')
    assert.equal(f.store.getRequest(request.id)?.status, 'running')
    assert.match(JSON.stringify(f.adapter.requests[1].messages), /Keep the queued evidence/)
    assert.ok(f.adapter.requests[1].tools?.some(tool => tool.name === 'research_assignment_report'))
    const report = f.ctx.tools.get('research_assignment_report', child)!
    await report.execute({ id: work.id, status: 'waiting', report: { task_id: null, run_ids: [], evidence: [] } }, { agent: child, signal: f.signal } as never)
    assert.equal(f.store.getAssignment(work.id)?.reported_status, 'waiting')
  } finally {
    await f.ctx.subagents.drainDescendants([f.parent])
    await f.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('reopening a completed DSH runner cannot alter the run already cited by the controller', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-closed-runner-'))
  const f = await fixture(root)
  let finishTurn = Promise.withResolvers<void>()
  try {
    await f.ctx.agentPresets.register({ id: 'research-runner', plugins: [{
      name: new URL('../src/dsh/agent.ts', import.meta.url).href, config: { role: 'runner' },
    }] })
    const tools = createResearchTools(f.ctx.research)
    const request = f.store.submitRequest({ title: 'Lock the evidence', message: 'Record the measured cost', session_id: f.parent.id })
    f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
    const scout = f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Find a hypothesis' })
    f.store.startAssignment(scout.id, 'fixture-scout')
    const hypothesis = { mechanism: 'Reuse a cached result', minimal_experiment: { sample: 1 }, pass_gate: 'Cost falls', stop_gate: 'Cost increases' }
    const source = f.store.addSource({ request_id: request.id, assignment_id: scout.id, query: 'Fixture', url: 'https://example.org/cost',
      title: 'Cost fixture', source_type: 'documentation', claim: 'Costs may fall', applicability: 'Fixture only', limitations: 'Synthetic',
      mechanism_hypothesis: hypothesis.mechanism, minimal_experiment: hypothesis.minimal_experiment,
      pass_gate: hypothesis.pass_gate, stop_gate: hypothesis.stop_gate })
    const source_ids = [source.id]
    f.store.submitAssignmentReport(scout.id, 'fixture-scout', { status: 'completed', report: {
      task_id: null, run_ids: [], source_ids, evidence: [{ kind: 'url', path: source.url }], hypotheses: [{ ...hypothesis, source_ids }],
    } })
    f.store.reportAssignment(scout.id, { status: 'completed', child_id: 'fixture-scout' })
    const candidate = tools.research_candidate_create({
      request_id: request.id, title: 'Measure cost', question: request.message, ...hypothesis, source_ids,
    }, f.parent)
    const assignment = f.store.createAssignment({ request_id: request.id, role: 'runner', instruction: 'Measure cost' })
    tools.research_candidate_update({ id: candidate.id, runner_assignment_id: assignment.id }, f.parent)

    f.adapter.finishReason = 'stop'
    f.adapter.continueAfter = finishTurn.promise
    const active = await f.dispatcher.dispatch(assignment.id, f.parent, f.signal)
    await f.adapter.entered.promise
    const runnerId = SessionId(active.child_id!)
    const runner = f.ctx.agents.get(runnerId)!
    const run = tools.research_run_start({ candidate_id: candidate.id }, runner)
    tools.research_run_finalize({ id: run.id, status: 'succeeded', metrics: { cost: 5 } }, runner)
    tools.research_candidate_update({ id: candidate.id, status: 'succeeded' }, runner)
    f.dispatcher.report(assignment.id, { status: 'completed', report: {
      task_id: null, run_ids: [run.id], candidate_id: candidate.id, evidence: [{ kind: 'metric', path: 'cost' }],
    } }, runner)
    const settled = f.settled()
    finishTurn.resolve()
    await settled
    tools.research_request_update({ id: request.id, status: 'completed' })
    const record = tools.research_record_add({ kind: 'experiment', run_ids: [run.id], question: request.message,
      observations: { cost: 5 }, verdict: 'observed', conclusion: 'Measured 5 units', evidence: [{ kind: 'metric', path: 'cost' }],
      provenance: { source: 'test' }, parents: [] })

    finishTurn = Promise.withResolvers<void>()
    f.adapter.continueAfter = finishTurn.promise
    f.adapter.entered = Promise.withResolvers<void>()
    await f.ctx.subagents.prompt({
      childSessionId: runnerId, delivery: 'steer',
      requestId: randomUUID() as Parameters<typeof f.ctx.subagents.prompt>[0]['requestId'],
      content: [{ type: 'text', text: 'Review the saved evidence' }],
    }, f.signal)
    await f.adapter.entered.promise
    const reopened = f.ctx.agents.get(runnerId)!
    assert.notEqual(reopened, runner)
    const offered = f.adapter.requests.at(-1)?.tools?.map(tool => tool.name) ?? []
    assert.ok(offered.includes('research_runs'))
    for (const name of ['research_run_start', 'research_run_finalize', 'research_candidate_update', 'research_assignment_report']) {
      assert.equal(offered.includes(name), false, name)
    }
    const finalize = f.ctx.tools.get('research_run_finalize', reopened)!
    const execution = { agent: reopened, signal: f.signal } as never
    await assert.rejects(finalize.execute({ id: run.id, status: 'failed', metrics: { cost: 100 } }, execution), /already finalized/)
    assert.equal(f.store.getRequest(request.id)?.status, 'completed')
    assert.equal(f.store.getAssignment(assignment.id)?.attempt, 1)
    assert.deepEqual(f.store.getRun(run.id)?.metrics, { cost: 5 })
    assert.deepEqual(f.store.getRecord(record.id)?.observations, { cost: 5 })
  } finally {
    finishTurn.resolve()
    await f.ctx.subagents.drainDescendants([f.parent])
    await f.ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('stopping one research request leaves another request on the same main session running', async () => {
  const root = await mkdtemp(join(tmpdir(), 'research-stop-'))
  const f = await fixture(root)
  try {
    const create = (title: string) => {
      const request = f.store.submitRequest({ title, message: 'Inspect evidence', session_id: f.parent.id })
      f.store.claimRequest(request.id); f.store.acceptRequest(request.id, {})
      return { request, work: f.store.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Inspect evidence' }) }
    }
    f.adapter.blockUntilAborted = true
    const one = create('First request'), two = create('Independent request')
    const first = await f.dispatcher.dispatch(one.work.id, f.parent, f.signal)
    await f.adapter.entered.promise
    f.adapter.entered = Promise.withResolvers<void>()
    const second = await f.dispatcher.dispatch(two.work.id, f.parent, f.signal)
    await f.adapter.entered.promise

    await f.dispatcher.stop(one.request.id, f.parent)
    assert.equal(f.store.getAssignment(one.work.id)?.status, 'stopped')
    assert.equal(f.ctx.agents.get(SessionId(first.child_id!)), undefined)
    assert.equal(f.store.getAssignment(two.work.id)?.status, 'running')
    assert.equal(f.ctx.agents.get(SessionId(second.child_id!))?.status, 'running')
    await f.dispatcher.stop(two.request.id, f.parent)
  } finally { await f.ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) }
})
