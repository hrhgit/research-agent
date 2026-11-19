import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { ResolvedToolSet, ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { ResearchStore } from '../src/store/sqlite.ts'
import { ResearchApi } from '../src/dsh/api.ts'
import * as ResearchHost from '../src/dsh/plugin.ts'
import { apply as applyResearchMode, type ResearchRole } from '../src/dsh/agent.ts'
import { registerResearchHttp } from '../src/dsh/http.ts'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function executeTool(ctx: Context, input: ToolExecutionInput, toolSet?: ResolvedToolSet) {
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent, signal: input.signal, toolSet,
  })
  return batch.results[0].result
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'research-mode-'))
  const ctx = new Context()
  ctx.baseUrl = new URL('../', import.meta.url).href
  await ctx.plugin(Loader)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LlmRuntime)
  ctx.provide('subagents', {
    startActivation: () => { throw new Error('No live model in tests') },
    sendMessage: () => { throw new Error('No live model in tests') },
    interrupt() {},
  } as never)
  ctx.provide('webServer', { register: () => () => {} } as never)
  ctx.provide('connection', { requestRejection: () => 401 } as never)
  const host = await ctx.plugin(ResearchHost, { dbPath: join(directory, 'research.sqlite') })
  const store = ctx.research.store
  await ctx.plugin(AgentPresets, { default: 'standard' })
  const unregister = await ctx.agentPresets.register({ id: 'research', plugins: [{ name: new URL('../src/dsh/agent.ts', import.meta.url).href }] })
  await ctx.agentPresets.register({ id: 'standard', plugins: [] })
  assert.equal((await ctx.agentPresets.resolve('research')).broken, undefined)
  const agent = { session: { id: 'main-test', header: { origin: 'user' } } } as unknown as NonNullable<ToolExecutionInput['agent']>
  const scope = createScope(ctx, agent)
  await ctx.agentPresets.mount(scope.ctx, 'research')
  let next = 0
  const execute = (name: string, args: unknown, signal = new AbortController().signal) => executeTool(ctx, {
    callId: `test-${++next}` as ToolExecutionInput['callId'], name, arguments: args, signal, agent,
  })
  const call = async (name: string, args: unknown) => {
    const result = await execute(name, args)
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const content = result.content[0]
    assert.ok(content?.type === 'text')
    return JSON.parse(content.text)
  }
  return { ctx, store, agent, scope, host, unregister, execute, call, async close() { await ctx.fiber.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

test('DSH registry exposes research tools and executes record/trace/scale workflow without a model', async () => {
  const f = await fixture()
  try {
    const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    assert.equal(prompt.tools.filter(t => t.name.startsWith('research_')).length, 43)
    const direction = await f.call('research_direction_new', { title: 'General research smoke test' })
    const task = await f.call('research_task_create', { direction_id: direction.id, title: 'Small first', question: 'Does the small run retain quality?' })
    const run = await f.call('research_run_start', { direction_id: direction.id, task_id: task.id, scale_stage_id: 'small' })
    await f.call('research_run_finalize', { id: run.id, status: 'succeeded', metrics: { effect: 0.98, duration_seconds: 0.12, cost_units: 1 } })
    const record = await f.call('research_record_add', { kind: 'experiment', direction_id: direction.id, task_id: task.id, run_ids: [run.id], question: task.question, observations: { effect: 0.98 }, verdict: 'supported', conclusion: 'Fixture retained 98 percent.', boundary: 'Integration fixture only.', evidence: [], provenance: { source: 'test' }, parents: [] })
    const correction = await f.call('research_record_add', { kind: 'correction', run_ids: [], question: task.question, observations: {}, verdict: 'inconclusive', conclusion: 'A fixture does not establish real quality.', evidence: [], provenance: { source: 'test' }, parents: [record.id], supersedes: record.id })
    assert.equal((await f.call('research_recall', { query: 'Fixture retained' }))[0].id, record.id)
    assert.deepEqual((await f.call('research_trace', { id: correction.id })).map((r: {id: string}) => r.id), [correction.id, record.id])
    assert.equal((await f.call('research_runs', { task_id: task.id }))[0].metrics.duration_seconds, 0.12)
    const recommendation = await f.call('research_scale_recommend', { policy: { stages: [{ id: 'small', label: 'Small', order: 0, scale: 10 }, { id: 'full', label: 'Full', order: 1, scale: 100 }], effect_direction: 'higher_better', baseline_effect: 1, min_effect_retention: 0.95, max_total_cost_units: 10, max_failed_runs: 2 }, observations: [{ run_id: run.id, stage_id: 'small', effect: 0.98, cost_units: 1, valid: true }] })
    assert.equal(recommendation.next_stage_id, 'full')
    assert.equal(f.store.overview().records, 2)
  } finally { await f.close() }
})

test('research mode exposes the main-session dispatch queue without an external IM source', async () => {
  const f = await fixture()
  try {
    const request = await f.call('research_request_submit', { title: 'Queue smoke', message: 'Use the main session as the research intake.' })
    assert.equal(request.channel, 'main-session')
    assert.equal((await f.call('research_request_queue', {}))[0].id, request.id)
    await f.call('research_request_claim', { id: request.id })
    const direction = await f.call('research_direction_new', { title: 'Queue direction' })
    const task = await f.call('research_task_create', { direction_id: direction.id, title: 'Queue task', question: 'Can the queue persist?' })
    await f.call('research_request_accept', { id: request.id, direction_id: direction.id, task_id: task.id })
    const assignment = await f.call('research_assignment_create', { request_id: request.id, role: 'scout', instruction: 'Inspect the existing records.' })
    assert.equal((await f.execute('research_assignment_report', { id: assignment.id, status: 'completed', report: { task_id: task.id, run_ids: [], evidence: [] } })).isError, true)
    f.store.reportAssignment(assignment.id, { status: 'completed', report: { exact_ids: [] } })
    assert.equal((await f.call('research_request_show', { id: request.id })).status, 'accepted')
    assert.ok((await f.call('research_dispatch_trace', { request_id: request.id })).length >= 5)
  } finally { await f.close() }
})

test('research preset isolates tools and guidance, shares facts, and releases contributions without closing the host database', async () => {
  const f = await fixture()
  try {
    const ordinaryKey = {} as NonNullable<ToolExecutionInput['agent']>
    const ordinary = createScope(f.ctx, ordinaryKey)
    await f.ctx.agentPresets.mount(ordinary.ctx, 'standard')
    for (const key of [undefined, ordinaryKey]) {
      const prompt = await f.ctx.systemPrompt.assemble({ scope: key })
      assert.equal(prompt.tools.some(tool => tool.name.startsWith('research_')), false)
      assert.equal(prompt.sections.some(section => section.name === 'research:workflow'), false)
      const result = await executeTool(f.ctx, { callId: 'ordinary' as ToolExecutionInput['callId'], name: 'research_direction_new', arguments: { title: 'Denied' }, signal: new AbortController().signal, agent: key })
      assert.equal(result.isError, true)
    }
    assert.equal(f.store.overview().directions, 0)
    assert.throws(() => applyResearchMode(f.ctx), /inside an agent preset/)
    const researchPrompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    assert.equal(researchPrompt.tools.filter(tool => tool.name.startsWith('research_')).length, 43)
    assert.match(researchPrompt.sections.find(section => section.name === 'research:workflow')!.text, /small informative test/)

    const secondKey = {} as NonNullable<ToolExecutionInput['agent']>
    const second = createScope(f.ctx, secondKey)
    await f.ctx.agentPresets.mount(second.ctx, 'research')
    const direction = await f.call('research_direction_new', { title: 'Shared research' })
    const state = await executeTool(f.ctx, { callId: 'second' as ToolExecutionInput['callId'], name: 'research_state', arguments: {}, signal: new AbortController().signal, agent: secondKey })
    assert.equal(state.isError, false)
    assert.ok(state.content[0]?.type === 'text')
    assert.equal(JSON.parse(state.content[0].text).directions[0].id, direction.id)

    await f.scope.dispose()
    await f.unregister()
    assert.equal(f.ctx.tools.schemas(secondKey).filter(tool => tool.name.startsWith('research_')).length, 43)
    await second.dispose()
    assert.equal(f.ctx.tools.schemas(secondKey).filter(tool => tool.name.startsWith('research_')).length, 0)
    assert.equal((await f.ctx.systemPrompt.assemble({ scope: secondKey })).sections.some(section => section.name === 'research:workflow'), false)
    assert.equal(f.ctx.research.state().directions, 1)
    await f.host.dispose()
    assert.equal(f.ctx.get('research'), undefined)
    assert.throws(() => f.store.overview())
  } finally { await f.close() }
})

test('DSH rejects incomplete inputs and cancelled writes before changing the database', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.execute('research_direction_new', {})).isError, true)
    const controller = new AbortController(); controller.abort()
    assert.equal((await f.execute('research_direction_new', { title: 'Cancelled' }, controller.signal)).isError, true)
    assert.equal(f.store.overview().directions, 0)
    assert.equal((await f.execute('research_record_show', { id: 'missing' })).isError, true)
    assert.equal((await f.execute('research_record_add', { kind: 'invented', question: 'Invalid' })).isError, true)
    assert.equal(f.store.overview().records, 0)
  } finally { await f.close() }
})

test('research HTTP rejects unauthenticated reads and writes using the host guard', async () => {
  const store = new ResearchStore()
  const server = createServer()
  registerResearchHttp({ register(route) { server.on('request', route.handler); return () => { server.off('request', route.handler) } } }, new ResearchApi(store), request => request.headers['x-test-auth'] === 'fixture' ? undefined : 401, { toolNames: ['research_state'] })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/research/api`
  try {
    assert.equal((await fetch(`${url}/state`)).status, 401)
    assert.equal((await fetch(`${url}/board`)).status, 401)
    assert.equal((await fetch(`${url}/directions`, { method: 'POST', body: JSON.stringify({ title: 'Denied' }) })).status, 401)
    assert.equal(store.overview().directions, 0)
    const response = await fetch(`${url}/config`, { headers: { 'x-test-auth': 'fixture' } })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { toolNames: ['research_state'] })
    const board = await (await fetch(`${url}/board`, { headers: { 'x-test-auth': 'fixture' } })).json() as Record<string, unknown>
    assert.deepEqual([board.requests, board.agents, board.incubations, board.lines], [[], [], [], []])
    assert.equal((await fetch(`${url}/candidates`, {
      method: 'POST', headers: { 'x-test-auth': 'fixture', 'content-type': 'application/json' }, body: '{}',
    })).status, 404)
    assert.equal(store.overview().candidates, 0)
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); store.close() }
})

test('controller hides child-only writes and guides recovery by the original assignment id', async () => {
  const f = await fixture()
  try {
    const prompt = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    for (const name of ['research_source_capture', 'research_assignment_report']) {
      assert.equal(prompt.tools.some(tool => tool.name === name), false)
      assert.equal(f.ctx.tools.get(name, f.agent), undefined)
      const result = await f.execute(name, {})
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(result.content), /unknown tool/i)
    }
    assert.ok(prompt.tools.some(tool => tool.name === 'research_sources'))
    assert.ok(prompt.tools.some(tool => tool.name === 'research_assignment_list'))
    assert.equal(f.store.listSources().length, 0)

    const guidance = prompt.sections.find(section => section.name === 'research:workflow')!.text
    assert.match(guidance, /returned id from research_assignment_create as the assignment_id/)
    assert.match(guidance, /research_assignment_list.*recover the original assignment/)
    assert.match(guidance, /Do not use request.current_assignment_id/)
    assert.match(guidance, /resume that same scout/)
    assert.match(guidance, /reuse its existing search results and saved sources/)
    assert.doesNotMatch(guidance, /research_assignment_report/)
    const definitions = f.ctx.tools.schemas(f.agent)
    assert.match(definitions.find(tool => tool.name === 'research_assignment_create')!.description, /id.*assignment_id/)
    assert.match(definitions.find(tool => tool.name === 'research_assignment_list')!.description, /找回并继续原派工/)
  } finally { await f.close() }
})

test('research worker roles receive bounded tools and a role contract', async () => {
  const f = await fixture()
  try {
    const expected: Record<string, string[]> = {
      scout: ['research_recall', 'research_digest', 'research_source_capture'],
      runner: ['research_run_start', 'research_run_finalize'],
      auditor: ['research_record_show', 'research_trace'],
      synthesizer: ['research_digest'],
      'tool-engineer': ['research_tool_version_register', 'research_tool_change_propose'],
    }
    for (const [role, required] of Object.entries(expected)) {
      const key = {} as NonNullable<ToolExecutionInput['agent']>
      const scope = createScope(f.ctx, key)
      const presetId = `role-${role}`
      const unregister = await f.ctx.agentPresets.register({ id: presetId, plugins: [{ name: new URL('../src/dsh/agent.ts', import.meta.url).href, config: { role: role as ResearchRole } }] })
      await f.ctx.agentPresets.mount(scope.ctx, presetId)
      const names = f.ctx.tools.schemas(key).map(tool => tool.name)
      for (const name of required) assert.ok(names.includes(name), `${role} missing ${name}`)
      assert.equal(names.includes('research_record_add'), false)
      assert.equal(names.includes('research_source_capture'), role === 'scout')
      const prompt = await f.ctx.systemPrompt.assemble({ scope: key })
      assert.equal(prompt.sections.some(section => section.name === `research:workflow:${role}`), true)
      await scope.dispose()
      await unregister()
    }
  } finally { await f.close() }
})

test('model steps admit assignment tools only for the role bound to active work', async () => {
  const f = await fixture()
  const signal = new AbortController().signal
  const roles = ['scout', 'runner', 'auditor', 'synthesizer', 'tool-engineer'] as const
  try {
    const request = await f.call('research_request_submit', { title: 'Check worker access', message: 'Inspect evidence.' })
    await f.call('research_request_claim', { id: request.id })
    await f.call('research_request_accept', { id: request.id })
    for (const role of roles) {
      const child = { session: { id: `child-${role}`, header: { origin: 'subagent' } } } as unknown as NonNullable<ToolExecutionInput['agent']>
      const standalone = { session: { id: `standalone-${role}`, header: {} } } as unknown as NonNullable<ToolExecutionInput['agent']>
      const childScope = createScope(f.ctx, child)
      const mainScope = createScope(f.ctx, standalone)
      const presetId = `role-${role}`
      await f.ctx.agentPresets.register({ id: presetId, plugins: [{ name: new URL('../src/dsh/agent.ts', import.meta.url).href, config: { role } }] })
      await f.ctx.agentPresets.mount(childScope.ctx, presetId)
      await f.ctx.agentPresets.mount(mainScope.ctx, presetId)
      const writes = ['research_assignment_report', ...(role === 'scout' ? ['research_source_capture']
        : role === 'runner' ? ['research_run_start', 'research_run_finalize', 'research_candidate_update'] : [])]
      const assignment = f.store.createAssignment({ request_id: request.id, role, instruction: 'Inspect evidence' })
      const report = { id: assignment.id, status: 'waiting', report: { task_id: null, run_ids: [], evidence: [] } }
      const check = async (key: typeof child, active: boolean) => {
        const toolSet = await f.ctx.tools.resolve({ agent: key, modelSelection: { provider: 'fixture', model: 'fixture' }, signal })
        try {
          const prompt = await f.ctx.systemPrompt.assemble({ scope: key, toolSet })
          const names = prompt.tools.map(tool => tool.name)
          assert.ok(names.includes('research_request_show'))
          for (const name of writes) {
            assert.equal(names.includes(name), active, `${role}: ${name}`)
            assert.equal(!!f.ctx.tools.executable(name, key, toolSet), active, `${role}: ${name} execution`)
          }
          const guide = prompt.sections.find(section => section.name === `research:workflow:${role}`)!.text
          assert.equal(guide.includes('research_assignment_report'), active)
          if (role === 'scout') assert.doesNotMatch(guide, /web_search|web_fetch/)
          const result = await executeTool(f.ctx, { callId: 'report' as ToolExecutionInput['callId'], agent: key, name: 'research_assignment_report', arguments: report, signal }, toolSet)
          assert.equal(result.isError, !active, JSON.stringify(result.content))
        } finally { toolSet.dispose() }
      }
      await check(standalone, false)
      await check(child, false)
      f.store.startAssignment(assignment.id, child.session.id)
      await check(child, true)
      f.store.reportAssignment(assignment.id, { status: 'waiting', child_id: child.session.id })
      await check(child, false)
      f.store.startAssignment(assignment.id, child.session.id)
      await check(child, true)
      f.store.reportAssignment(assignment.id, { status: 'completed', child_id: child.session.id })
      await check(child, false)
      await childScope.dispose()
      await mainScope.dispose()
    }
  } finally { await f.close() }
})

test('candidate update offers only the operations each role can perform', async () => {
  const f = await fixture()
  try {
    const controllerTools = f.ctx.tools.schemas(f.agent)
    const controller = controllerTools.find(tool => tool.name === 'research_candidate_update')!
    const controllerFields = controller.parameters.properties as Record<string, { enum?: string[] }>
    assert.deepEqual(controllerFields.status.enum, ['cancelled'])
    assert.ok(controllerFields.runner_assignment_id)
    assert.equal(controllerFields.run_ids, undefined)
    const controllerStart = controllerTools.find(tool => tool.name === 'research_run_start')!
    assert.equal((controllerStart.parameters.properties as Record<string, unknown>).candidate_id, undefined)

    await f.ctx.agentPresets.register({ id: 'runner', plugins: [{ name: new URL('../src/dsh/agent.ts', import.meta.url).href, config: { role: 'runner' } }] })
    const key = {}
    const scope = createScope(f.ctx, key)
    await f.ctx.agentPresets.mount(scope.ctx, 'runner')
    const runnerTools = f.ctx.tools.schemas(key)
    const runner = runnerTools.find(tool => tool.name === 'research_candidate_update')!
    const runnerFields = runner.parameters.properties as Record<string, { enum?: string[] }>
    assert.ok(runnerFields.status.enum?.includes('succeeded'))
    assert.equal(runnerFields.status.enum?.includes('cancelled'), false)
    assert.ok(runnerFields.run_ids)
    assert.equal(runnerFields.runner_assignment_id, undefined)
    const runnerStart = runnerTools.find(tool => tool.name === 'research_run_start')!
    assert.ok((runnerStart.parameters.required as string[]).includes('candidate_id'))
  } finally { await f.close() }
})
