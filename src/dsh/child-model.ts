import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ResearchAssignmentRole, ResearchChildModel } from '../core/types.ts'
import type { ResearchStore } from '../store/sqlite.ts'

export type ChildModelRequest = Partial<ResearchChildModel>
export type ChildModelDefaults = Partial<Record<ResearchAssignmentRole, ResearchChildModel>>

export function childModelOptions(model: ResearchChildModel): ModelSelection {
  return { provider: model.provider, model: model.model,
    ...(model.reasoning_effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoning_effort) }) }
}

/** Apply saved research choices through DSH's model selection, including cold resumes. */
export class ResearchChildModels {
  private bindings = new Map<Agent, () => void>()
  private ctx: Context
  private store: ResearchStore
  private defaults: () => ChildModelDefaults

  constructor(ctx: Context, store: ResearchStore, defaults: ChildModelDefaults | (() => ChildModelDefaults) = {}) {
    this.ctx = ctx; this.store = store; this.defaults = typeof defaults === 'function' ? defaults : () => defaults
    ctx.on('agent/created', ({ agent }) => { this.bind(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.bindings.get(agent)?.(); this.bindings.delete(agent) })
    ctx.effect(() => () => { for (const dispose of this.bindings.values()) dispose(); this.bindings.clear() })
    for (const agent of ctx.agents.list()) this.bind(agent)
  }

  private bind(agent: Agent): void {
    if (this.bindings.has(agent) || agent.session.header.origin !== 'subagent') return
    const assignment = this.store.findAssignmentByChild(agent.session.id)
    if (!assignment || this.store.getRequest(assignment.request_id)?.session_id !== agent.session.header.parentSession) return
    this.bindings.set(agent, installModelSelection(agent.ctx))
    if (assignment.child_model) agent.model.select(childModelOptions(assignment.child_model))
  }

  /** Select before waking a resident child; cold children are selected on creation. */
  applyToLiveChild(id: SessionId): void {
    const agent = this.ctx.agents.get(id)
    if (!agent) return
    const assignment = this.store.findAssignmentByChild(id)
    if (!assignment?.child_model || agent.session.header.origin !== 'subagent'
      || this.store.getRequest(assignment.request_id)?.session_id !== agent.session.header.parentSession) return
    agent.model.select(childModelOptions(assignment.child_model))
  }

  async resolve(input: ChildModelRequest, signal: AbortSignal): Promise<ResearchChildModel | undefined> {
    if (input.provider === undefined && input.model === undefined && input.reasoning_effort === undefined) return undefined
    if (!input.provider?.trim() || !input.model?.trim()) throw new Error('Supply provider and model together')
    if (input.reasoning_effort !== undefined && !input.reasoning_effort.trim()) throw new Error('reasoning_effort must be non-empty')
    const selected: ResearchChildModel = { provider: input.provider.trim(), model: input.model.trim(),
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort.trim() }) }
    const resolved = await this.ctx.llm.resolveCallConfig(childModelOptions(selected), signal)
    signal.throwIfAborted()
    return { provider: resolved.provider, model: resolved.model,
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: String(resolved.reasoningEffort ?? input.reasoning_effort) }) }
  }

  async defaultFor(role: ResearchAssignmentRole, signal: AbortSignal): Promise<ResearchChildModel | undefined> {
    const configured = this.defaults()[role]
    return configured ? this.resolve(configured, signal) : undefined
  }

  listDefaults(): ChildModelDefaults {
    return Object.fromEntries(Object.entries(this.defaults()).filter(([, model]) => model !== undefined).map(([role, model]) => [role, { ...model }])) as ChildModelDefaults
  }

  async list(input: { provider?: string; model?: string }, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (input.model !== undefined && input.provider === undefined) throw new Error('model requires provider')
    if (input.provider === undefined) return this.ctx.llm.listProviders().map(({ id, name }) => ({ id, name }))
    if (input.model === undefined) return this.ctx.llm.listModels(input.provider)
    const model = await this.ctx.llm.resolveModelInfo(input.provider, input.model, signal)
    return { provider: input.provider, model: input.model, reasoning: model.reasoning ?? null }
  }
}
