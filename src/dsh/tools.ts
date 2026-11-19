import { defineTool, type InferArgs, type ParameterSchemaSpec, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '../core/types.ts'
import { createResearchTools, type ResearchApi } from './api.ts'
import type { ResearchRole } from './agent.ts'

const text = { type: 'string' } as const
const requiredText = { ...text, required: true } as const
const strings = { type: 'array', items: text } as const
const json = { type: 'json' } as const
const metrics = { type: 'object', additionalProperties: true } as const
const evidence = {
  type: 'array', items: { type: 'object', additionalProperties: false, properties: {
    kind: { type: 'string', enum: ['file', 'directory', 'url', 'log', 'metric', 'other'], required: true },
    path: requiredText, label: text, sha256: text, media_type: text, notes: text,
  } },
} as const
const provenance = { type: 'object', additionalProperties: false, properties: {
  source: requiredText, source_id: text, imported_at: text, importer_version: text, source_path: text,
} } as const

/** Remove absent optional fields, while rejecting non-JSON measured values. */
function jsonResult(value: unknown): JsonValue {
  if (value === undefined) throw new Error('Research item not found')
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Research result contains a non-finite number')
    return item
  })) as JsonValue
}

function tool<const S extends ParameterSchemaSpec>(name: string, description: string, parameters: S, run: (args: InferArgs<S>, agent?: Agent, signal?: AbortSignal) => unknown, readOnly = false): ToolDefinition {
  return defineTool({ name, description, parameters,
    output: { schema: json, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    isConcurrencySafe: () => readOnly,
    execute: async (args, exec) => { exec.signal.throwIfAborted(); return jsonResult(await run(args, exec.agent, exec.signal)) },
  })
}

/** Real DSH definitions: validated parameters and canonical results, with no model dependency. */
export function defineResearchTools(api: ResearchApi, role?: ResearchRole): ToolDefinition[] {
  const calls = createResearchTools(api)
  const controller = role === 'controller'
  const runner = role === 'runner'
  const runnerStatuses = ['proposed', 'running', 'succeeded', 'refuted', 'inconclusive'] as const
  const controllerStatuses = ['cancelled'] as const
  const candidateStatuses = [...runnerStatuses, ...controllerStatuses] as const
  return [
    tool('research_request_submit', '把主会话中的研究请求写入持久队列。主会话是唯一入口，不使用 GitHub 或飞书来源。每项新研究先调用此工具。', {
      title: requiredText, message: requiredText, priority: { type: 'integer' },
    }, (args, agent) => {
      if (!agent?.session || agent.session.header.origin === 'subagent') throw new Error('Research requests require a main session')
      return calls.research_request_submit({ ...args, session_id: agent.session.id })
    }),
    tool('research_request_queue', '查看持久研究请求队列和状态。主机重启后先用此工具恢复上下文。', {
      status: { type: 'string', enum: ['queued', 'assessing', 'accepted', 'running', 'waiting', 'blocked', 'failed', 'completed', 'stopped'] }, limit: { type: 'integer' },
    }, args => calls.research_request_queue(args), true),
    tool('research_request_show', '读取一项研究请求的完整状态。', { id: requiredText }, calls.research_request_show, true),
    tool('research_request_claim', '主会话开始处理一项排队、失败或等待中的研究请求。', { id: requiredText }, (args, agent) => { api.dispatcher!.owner(args.id, agent); return calls.research_request_claim(args) }),
    tool('research_request_accept', '确认研究请求对应的方向和任务，进入可派工状态。', { id: requiredText, direction_id: text, task_id: text }, (args, agent) => { api.dispatcher!.owner(args.id, agent); return calls.research_request_accept(args) }),
    tool('research_request_update', '更新研究请求状态和原因。方向与任务可在派工开始前调整。', {
      id: requiredText, status: { type: 'string', enum: ['queued', 'assessing', 'accepted', 'running', 'waiting', 'blocked', 'failed', 'completed', 'stopped'] },
      direction_id: text, task_id: text, last_error: text,
      current_assignment_id: { ...text, description: '请求的可变状态指针；不能用它找回某个子任务的正式派工编号。' },
    }, (args, agent) => {
      api.dispatcher!.owner(args.id, agent)
      if (args.status === 'stopped') return api.dispatcher!.stop(args.id, agent)
      return calls.research_request_update(args)
    }),
    tool('research_assignment_create', '保存一项派工及前置依赖，返回派工对象；其 id 就是正式 assignment_id，后续派发、恢复和查询均沿用此编号。随后调用 research_assignment_dispatch 启动子会话。相互独立的派工可并行启动。', {
      request_id: requiredText, role: { type: 'string', enum: ['scout', 'runner', 'auditor', 'synthesizer', 'tool-engineer'], required: true }, instruction: requiredText, depends_on: strings,
    }, (args, agent) => { api.dispatcher!.owner(args.request_id, agent); return calls.research_assignment_create(args) }),
    tool('research_assignment_dispatch', '启动派工对应的 DSH 子智能体，自动选取角色、绑定子会话并跟踪完成状态。模型使用该角色的默认值，未配置时继承主会话；工作目录继承主会话。结果由 DSH 自动送回主会话。', { id: requiredText },
      (args, agent, signal) => api.dispatcher!.dispatch(args.id, agent, signal!)),
    tool('research_models', '查看可用模型：不传参数列服务商，传 provider 列模型，再传 model 查看思考强度选项。', { provider: text, model: text },
      (args, _agent, signal) => api.dispatcher!.listModels(args, signal!), true),
    tool('research_model_defaults', '查看各角色默认模型；传 changes 保存用户指定的角色默认值，新派工立即生效。已有派工保留原模型。单次派工可通过恢复工具覆盖。', {
      changes: { ...json, description: '仅提供需要修改的角色，值为 {provider, model, reasoning_effort?}；null 表示跟随主会话。' },
    }, async (args, agent, signal) => {
      if (args.changes === undefined) return api.dispatcher!.listModelDefaults()
      if (!agent?.session || agent.session.header.origin === 'subagent') throw new Error('只有主会话可以修改角色默认模型。')
      if (!api.modelSettings) throw new Error('模型设置服务不可用。')
      return (await api.modelSettings.save(args.changes, signal!)).defaults
    }),
    tool('research_assignment_resume', '继续原子会话。可同时指定 provider 和 model 换模型；已有派工省略则沿用已保存模型，首次派工省略则使用角色默认值。运行中先暂停。', {
      id: requiredText, message: requiredText, provider: text, model: text, reasoning_effort: text,
    }, (args, agent, signal) => api.dispatcher!.resume(args.id, args.message, agent, signal!, args)),
    tool('research_assignment_pause', '请求暂停运行中的派工；真实停止后自动保存等待状态，稍后可恢复。', { id: requiredText },
      (args, agent) => api.dispatcher!.pause(args.id, agent)),
    tool('research_request_stop', '停止请求和它的子智能体，保留已有运行、报告和实验记录。', { id: requiredText },
      (args, agent) => api.dispatcher!.stop(args.id, agent)),
    tool('research_assignment_report', '提交当前派工的报告。填写 task_id、run_ids 和 evidence。侦察完成时附已保存的 source_ids 和假设；执行完成时附已测 candidate_id。派工结束时采纳报告。', {
      id: requiredText, status: { type: 'string', enum: ['waiting', 'completed', 'failed'], required: true },
      report: { ...json, required: true }, error: text,
    }, (args, agent) => api.dispatcher!.report(args.id, args, agent)),
    tool('research_assignment_list', '读取请求下的全部派工、正式 id、角色、任务说明、子会话编号和报告，用于找回并继续原派工。', { request_id: text }, calls.research_assignment_list, true),
    tool('research_dispatch_trace', '读取请求的持久调度事件，用于重启恢复和审计。', { request_id: requiredText }, calls.research_dispatch_trace, true),
    tool('research_state', 'List research directions, counts and the incubations still in progress. Use this to discover existing direction IDs and unfinished structural work.', {}, () => ({
      ...api.state(), directions: api.directions(),
      incubating: api.incubations({ status: 'incubating' }).map(item => ({
        id: item.id, direction_id: item.direction_id, title: item.title, rounds: item.rounds.length,
        ratio: item.decision.ratio ?? null, best_ratio: item.decision.best_ratio ?? null, rounds_left: item.decision.rounds_left,
        bottleneck: item.rounds.at(-1)?.bottleneck ?? null, next_change: item.rounds.at(-1)?.next_change ?? null,
      })),
    }), true),
    tool('research_tasks', 'List tasks, optionally in one research direction.', { direction_id: text }, args => api.tasks(args.direction_id), true),
    tool('research_runs', 'Read recorded runs, metrics, durations and pinned tool versions for a direction or task.', { direction_id: text, task_id: text, limit: { type: 'integer' } }, args => api.runs(args), true),
    tool('research_direction_new', 'Create a research direction with its goal.', {
      id: text, title: requiredText, goal: text, status: { type: 'string', enum: ['active', 'paused', 'completed', 'archived'] }, tags: strings,
    }, calls.research_direction_new),
    tool('research_task_create', 'Record the question, independent hypothesis and experimental protocol before running an experiment.', {
      id: text, direction_id: requiredText, title: requiredText, question: requiredText, hypothesis: text, protocol: json,
      status: { type: 'string', enum: ['draft', 'ready', 'running', 'blocked', 'completed', 'cancelled'] }, priority: { type: 'integer' },
    }, calls.research_task_create),
    tool('research_run_start', 'Record the start of an experiment and pin its tool versions and scale. This does not execute a command; use DSH execution tools for that.', {
      id: text, direction_id: text, task_id: text,
      ...(controller ? {} : { candidate_id: runner ? requiredText : text }),
      scale_stage_id: text, tool_version_ids: strings, worker: text, command: text, input: json, artifacts: evidence,
    }, calls.research_run_start),
    tool('research_run_finalize', 'Save the actual outcome, metrics, artifacts and errors once. Include duration_seconds and cost_units when known. An identical retry returns the saved result.', {
      id: requiredText, status: { type: 'string', enum: ['succeeded', 'failed', 'cancelled', 'timed_out'], required: true },
      metrics, artifacts: evidence, error: text, finished_at: text,
    }, calls.research_run_finalize),
    tool('research_record_add', 'Append a research conclusion with its evidence, limits and parent records. Preserve failed and inconclusive experiments; correct earlier conclusions with supersedes.', {
      id: text, kind: { type: 'string', enum: ['experiment', 'observation', 'decision', 'review', 'correction'], required: true },
      direction_id: text, task_id: text, run_ids: { ...strings, required: true }, question: requiredText, hypothesis: text,
      protocol: json, observations: { ...json, required: true }, verdict: { type: 'string', enum: ['supported', 'refuted', 'inconclusive', 'rejected', 'observed'], required: true },
      conclusion: requiredText, lesson: text, boundary: text, evidence: { ...evidence, required: true },
      provenance: { ...provenance, required: true }, parents: { ...strings, required: true }, supersedes: text,
    }, calls.research_record_add),
    tool('research_source_capture', '保存当前侦察派工找到的联网来源及其对应的机制假设和最小实验。', {
      assignment_id: { ...requiredText, description: '本 scout 派工上下文中的 assignment_id；不要使用请求的 current_assignment_id。' }, query: requiredText, url: requiredText, title: requiredText,
      source_type: { type: 'string', enum: ['search_result', 'fetched_page', 'paper', 'repository', 'documentation', 'other'], required: true },
      provider: text, claim: requiredText, applicability: requiredText, limitations: requiredText,
      mechanism_hypothesis: requiredText, minimal_experiment: { ...json, required: true },
      pass_gate: requiredText, stop_gate: requiredText,
    }, (args, agent) => {
      if (!agent) throw new Error('Source capture requires the assigned scout agent')
      return calls.research_source_capture(args, agent)
    }),
    tool('research_sources', '读取已记录的联网来源和它们绑定的机制假设，按请求、派工或关键词筛选。', {
      request_id: text, assignment_id: text, query: text, limit: { type: 'integer' },
    }, calls.research_sources, true),
    tool('research_candidate_create', '由 controller 把一个有来源的机制假设提升为待验证候选。候选必须引用 scout source，并包含可执行的最小实验、通过门槛和停止门槛。', {
      request_id: requiredText, direction_id: text, task_id: text, title: requiredText, question: requiredText,
      mechanism: requiredText, source_ids: { ...strings, required: true }, minimal_experiment: { ...json, required: true },
      pass_gate: requiredText, stop_gate: requiredText,
      incubation_id: { ...text, description: '该候选作为哪条孵化线的一轮。' },
      based_on_run_id: { ...text, description: '孵化线第二轮起填写上一轮已登记的运行编号，可不再引用新来源。' },
    }, (args, agent) => {
      if (!agent) throw new Error('Candidate creation requires the controller session')
      return calls.research_candidate_create(args, agent)
    }),
    tool('research_candidates', '读取研究请求的候选及其状态、来源和已绑定运行。', {
      request_id: text, direction_id: text, task_id: text,
      status: { type: 'string', enum: candidateStatuses }, limit: { type: 'integer' },
    }, calls.research_candidates, true),
    tool('research_candidate_show', '读取一个候选的完整机制、来源、最小实验和运行状态。', { id: requiredText }, calls.research_candidate_show, true),
    tool('research_candidate_update', runner ? '更新自己负责的候选状态。记录结论时提交已结束的运行编号。'
      : '用 runner_assignment_id 绑定待执行的派工，或用 cancelled 撤回候选。撤回前先暂停正在运行的派工。', {
      id: requiredText,
      status: { type: 'string', enum: controller ? controllerStatuses : runner ? runnerStatuses : candidateStatuses },
      ...(runner ? {} : { runner_assignment_id: text }),
      ...(controller ? {} : { run_ids: strings }),
    }, (args, agent) => {
      if (!agent) throw new Error('Candidate updates require the assigned research session')
      return calls.research_candidate_update(args, agent)
    }),
    tool('research_incubation_open', '为一个结构性候选开一条孵化线：登记对照组的实测值和证据，以及此后不可更改的轮数、累计成本、失败次数和差距收敛门槛。每个方向同时最多两条。', {
      id: text, direction_id: requiredText, task_id: text, title: requiredText,
      architecture: { ...requiredText, description: '新的数据流、表示或算法，以及它与对照组的结构差别。' },
      control_description: requiredText, control_evidence: { ...evidence, required: true },
      policy: { type: 'object', additionalProperties: false, required: true, properties: {
        metric: { ...requiredText, description: '运行指标中表示完整成本或分数的键名。' },
        effect_direction: { type: 'string', enum: ['higher_better', 'lower_better'], required: true },
        control_effect: { type: 'number', required: true },
        graduate_ratio: { type: 'number', required: true, description: '差距比降到此值即毕业；1 表示与对照持平。' },
        min_gap_closure: { type: 'number', required: true, description: '最近 patience 轮内必须收回的剩余差距比例，0 到 1 之间。' },
        patience: { type: 'integer', required: true }, max_rounds: { type: 'integer', required: true },
        max_total_cost_units: { type: 'number', required: true }, max_failed_rounds: { type: 'integer', required: true },
        max_entry_ratio: { type: 'number', description: '首轮差距比超过此值则不孵化。' },
      } },
    }, calls.research_incubation_open),
    tool('research_incubation_round', '把本轮候选的已结束运行登记为孵化线的一轮。实测值和成本取自该运行的指标；返回继续、毕业或停止的判定，停止和毕业立即生效。', {
      id: requiredText, run_id: requiredText,
      bottleneck: { ...requiredText, description: '成本账中占剩余差距最大的一项及其数值。' },
      next_change: { ...text, description: '下一轮针对该项要改的结构。' },
      control_effect: { type: 'number', description: '本轮规模与登记的对照不同时，填同规模对照值。' },
    }, calls.research_incubation_round),
    tool('research_incubation_update', '暂停、恢复或停止一条孵化线并写明原因。首版落后于对照不构成停止原因。', {
      id: requiredText, status: { type: 'string', enum: ['incubating', 'paused', 'stopped'], required: true }, reason: requiredText,
    }, calls.research_incubation_update),
    tool('research_incubations', '读取孵化线的结构说明、对照、门槛、各轮差距比和瓶颈，以及当前判定。', {
      id: text, direction_id: text, status: { type: 'string', enum: ['incubating', 'paused', 'graduated', 'stopped'] }, limit: { type: 'integer' },
    }, calls.research_incubations, true),
    tool('research_record_show', 'Read a complete research record, including evidence and scope.', { id: requiredText }, calls.research_record_show, true),
    tool('research_recall', 'Find previous experiments by literal text in their question, observations or conclusion. Empty query lists recent records; this is not semantic search.', { query: requiredText, limit: { type: 'integer' } }, calls.research_recall, true),
    tool('research_trace', 'Follow a record and its parent records to recover the exploration history.', { id: requiredText }, calls.research_trace, true),
    tool('research_digest', 'Collect recorded conclusions and recurring tags for review, optionally scoped to a direction. This does not establish statistical significance.', { direction_id: text }, calls.research_digest, true),
    tool('research_insight_add', 'Record a reusable hypothesis or finding with explicit scope and supporting or contradicting record IDs.', {
      id: text, direction_id: text, claim: requiredText, scope: requiredText,
      status: { type: 'string', enum: ['hypothesis', 'supported', 'established', 'refuted', 'superseded'], required: true },
      confidence: { type: 'string', enum: ['low', 'medium', 'high'] }, supports: { ...strings, required: true }, contradicts: { ...strings, required: true }, related: { ...strings, required: true },
    }, calls.research_insight_add),
    tool('research_scale_recommend', 'Recommend the next experiment scale from measured outcomes and an explicit policy. Read prior runs first; retain run IDs and use one consistent cost unit. The recommendation does not launch or enforce an experiment.', {
      policy: { type: 'object', additionalProperties: false, required: true, properties: {
        stages: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
          id: requiredText, label: requiredText, order: { type: 'number', required: true }, scale: { type: 'number', required: true }, max_cost_units: { type: 'number' },
        } } },
        effect_direction: { type: 'string', enum: ['higher_better', 'lower_better'], required: true }, baseline_effect: { type: 'number' },
        min_effect_retention: { type: 'number', required: true }, max_total_cost_units: { type: 'number', required: true }, max_failed_runs: { type: 'integer', required: true }, min_marginal_gain_per_cost: { type: 'number' },
      } },
      observations: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
        run_id: requiredText, stage_id: requiredText, effect: { type: 'number', required: true }, cost_units: { type: 'number', required: true }, valid: { type: 'boolean', required: true }, created_at: text, metrics,
      } } },
    }, calls.research_scale_recommend, true),
    tool('research_tool_versions', 'List registered experiment tool versions, optionally by tool name.', { tool_name: text }, args => api.store.listToolVersions(args.tool_name), true),
    tool('research_tool_changes', 'List experiment tool change proposals, optionally by tool name.', { tool_name: text }, args => api.store.listToolChanges(args), true),
    tool('research_tool_version_register', 'Register a new immutable tool snapshot, including source hash, environment and validation evidence. Does not edit or install code.', {
      id: text, tool_name: requiredText, version: requiredText, source_hash: requiredText, environment: { ...json, required: true }, input_schema: json, output_schema: json, validation: json,
      status: { type: 'string', enum: ['candidate', 'verified', 'active', 'retired'] },
    }, calls.research_tool_version_register),
    tool('research_tool_change_propose', 'Propose an experiment tool change with an independent shadow validation plan.', {
      id: text, tool_name: requiredText, base_version_id: requiredText, candidate_version_id: text, reason: requiredText, expected_impact: requiredText, validation_plan: { ...json, required: true },
    }, calls.research_tool_change_propose),
    tool('research_tool_change_review', 'Record shadow validation or review of a tool change. This does not deploy the tool or change existing runs.', {
      id: requiredText, status: { type: 'string', enum: ['shadow', 'accepted', 'rejected', 'superseded'], required: true },
    }, calls.research_tool_change_review),
  ]
}
