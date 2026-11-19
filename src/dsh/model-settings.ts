import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type { ResearchChildModel } from '../core/types.ts'
import type { ResearchChildModels, ChildModelDefaults } from './child-model.ts'

export const childRoles = ['scout', 'runner', 'auditor', 'synthesizer', 'tool-engineer'] as const
export type ChildRole = typeof childRoles[number]
export type ModelDefaultChanges = Partial<Record<ChildRole, ResearchChildModel | null>>
export interface ModelSettingsSnapshot { defaults: ChildModelDefaults; editable: boolean }

/** One operation for the panel and controller; the official editor owns persistence. */
export class ResearchModelSettings {
  private ctx: Context
  private models: ResearchChildModels
  constructor(ctx: Context, models: ResearchChildModels) { this.ctx = ctx; this.models = models }

  snapshot(): ModelSettingsSnapshot {
    const editor = this.ctx.get('configEditor')
    const entry = this.ctx.fiber.entry
    return { defaults: this.models.listDefaults(), editable: !!editor && !!entry && editor.entries().includes(entry) }
  }

  async save(changes: unknown, signal: AbortSignal): Promise<ModelSettingsSnapshot> {
    signal.throwIfAborted()
    const editor = this.ctx.get('configEditor')
    const entry = this.ctx.fiber.entry
    if (!editor || !entry || !editor.entries().includes(entry)) throw new Error('当前运行环境无法保存配置。请从已安装此插件的 DSH 配置启动。')
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw new Error('模型设置必须按角色提供。')
    const validated: ModelDefaultChanges = {}
    for (const [role, value] of Object.entries(changes)) {
      if (!childRoles.includes(role as ChildRole)) throw new Error(`未知子智能体角色：${role}`)
      if (value === null) { validated[role as ChildRole] = null; continue }
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['provider', 'model', 'reasoning_effort'].includes(key))
        || typeof value.provider !== 'string' || typeof value.model !== 'string'
        || (value.reasoning_effort !== undefined && typeof value.reasoning_effort !== 'string')) throw new Error(`请为 ${role} 选择服务商、模型及可用的思考强度。`)
      validated[role as ChildRole] = await this.models.resolve(value, signal)
    }
    signal.throwIfAborted()
    if (!Object.keys(validated).length) return this.snapshot()
    await editor.edit(entry, current => {
      const defaults = { ...(current.childModelDefaults as ChildModelDefaults | undefined) }
      for (const [role, model] of Object.entries(validated)) {
        if (model === null) delete defaults[role as ChildRole]
        else defaults[role as ChildRole] = model
      }
      return { ...current, childModelDefaults: defaults }
    })
    return this.snapshot()
  }
}
