import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from './service.ts'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-config-editor'
import { ResearchDispatcher } from './dispatcher.ts'
import { ResearchChildModels, type ChildModelDefaults } from './child-model.ts'
import { createDispatchBackend } from './backend.ts'
import { isAbsolute } from 'node:path'
import { createResearchRuntime } from './runtime.ts'
import { ResearchModelSettings } from './model-settings.ts'
import { defineResearchTools } from './tools.ts'

export const name = 'dsh-research-agent'
export const inject = ['webServer', 'connection', 'subagents', 'agents', 'llm']

export type Config = Schemastery.TypeT<typeof Config>

const childModel = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  reasoning_effort: z.string(),
})
const optionalChildModel = z.union([childModel, z.const(undefined)])
const childModelDefaults: z<ChildModelDefaults, ChildModelDefaults, 'volatile-defined'> = z.object({
  scout: optionalChildModel,
  runner: optionalChildModel,
  auditor: optionalChildModel,
  synthesizer: optionalChildModel,
  'tool-engineer': optionalChildModel,
}).default({}).volatile().description('按角色指定子智能体的默认模型；单次派工可覆盖')

export const Config = z.object({
  dbPath: z.string().required().description('研究数据库的绝对路径'),
  projectRoot: z.string().description('已有实验记录的项目目录；不限制新研究方向'),
  importOnStart: z.boolean().default(false).description('启动时增量导入已有实验记录'),
  startPrompt: z.string().description('面板“启动研究”放进新会话输入框的提示词；不填使用内置默认'),
  childModelDefaults,
})

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.dbPath)) throw new Error('research dbPath must be an absolute path')
  if (config.projectRoot && !isAbsolute(config.projectRoot)) throw new Error('research projectRoot must be an absolute path')
  if (config.importOnStart && !config.projectRoot) throw new Error('research importOnStart requires projectRoot')
  const runtime = createResearchRuntime(config)
  const models = new ResearchChildModels(ctx, runtime.store, () => config.childModelDefaults.get())
  runtime.api.modelSettings = new ResearchModelSettings(ctx, models)
  const dispatcher = new ResearchDispatcher(runtime.store, createDispatchBackend(ctx), error => ctx.logger.warn(String(error)), models)
  runtime.api.dispatcher = dispatcher
  ctx.on('subagent/start', info => dispatcher.subagentStarted(info, ctx.agents.get(info.id), ctx.agents.get(info.parentSessionId)))
  ctx.on('agent/status', ({ agent, status }) => {
    try { dispatcher.childStatusChanged(agent, status) } catch (error) { ctx.logger.warn(String(error)) }
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') dispatcher.childTurnEnded(session, event.data.reason.kind)
  })
  ctx.on('subagent/end', info => dispatcher.subagentEnded(info))
  ctx.effect(() => async () => { await dispatcher.close(); runtime.close() }, 'research: dispatcher and database')
  if (runtime.recovered.requests || runtime.recovered.assignments) {
    ctx.logger.info('research dispatch recovery: %s', JSON.stringify(runtime.recovered))
  }
  if (config.importOnStart) {
    const result = await runtime.importExisting()
    ctx.logger.info('research import: %s', JSON.stringify(result))
  }
  ctx.provide('research', runtime.api)
  const definitions = defineResearchTools(runtime.api)
  ctx.effect(() => runtime.mount(ctx.webServer, request => ctx.connection.requestRejection(request), {
    dbPath: config.dbPath, projectRoot: config.projectRoot ?? null,
    importOnStart: config.importOnStart ?? false, toolNames: definitions.map(item => item.name),
    startPrompt: config.startPrompt?.trim() || null,
  }), 'research: authenticated API')
  ctx.logger.info('research ready: %s mode-scoped tools; %s records', definitions.length, runtime.api.state().records)
}
