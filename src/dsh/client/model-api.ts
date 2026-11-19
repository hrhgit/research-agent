import type { ResearchChildModel } from '../../core/types.ts'
import type { ChildModelDefaults } from '../child-model.ts'
import type { ModelSettingsSnapshot, ModelDefaultChanges } from '../model-settings.ts'

export const modelRoles = ['scout', 'runner', 'auditor', 'synthesizer', 'tool-engineer'] as const
export type ModelRole = typeof modelRoles[number]
export interface ModelOption { id: string; name: string }
export interface ModelDetail { reasoning: { efforts: ModelOption[]; defaultEffort?: string } | null }

export function sameModel(a?: ResearchChildModel | null, b?: ResearchChildModel | null): boolean {
  return a?.provider === b?.provider && a?.model === b?.model && a?.reasoning_effort === b?.reasoning_effort
}
export function changedModels(saved: ChildModelDefaults, draft: ChildModelDefaults): ModelDefaultChanges {
  return Object.fromEntries(modelRoles.filter(role => !sameModel(saved[role], draft[role])).map(role => [role, draft[role] ?? null]))
}

/** Catalog requests are shared across the five rows and cancelled on unmount. Failed reads can retry. */
export class ModelSettingsClient {
  private abort = new AbortController()
  private cache = new Map<string, Promise<unknown>>()
  private base: string
  private failureMessage: string
  constructor(base: string, failureMessage: string) { this.base = base; this.failureMessage = failureMessage }
  dispose() { this.abort.abort() }
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.base}/${path}`, { ...init, signal: this.abort.signal,
      headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } })
    const result = await response.json()
    if (!response.ok) throw new Error(result?.error || this.failureMessage)
    return result as T
  }
  private cached<T>(path: string): Promise<T> {
    if (!this.cache.has(path)) this.cache.set(path, this.request<T>(path).catch(error => { this.cache.delete(path); throw error }))
    return this.cache.get(path) as Promise<T>
  }
  settings() { return this.request<ModelSettingsSnapshot>('model-defaults') }
  providers() { return this.cached<ModelOption[]>('models') }
  models(provider: string) { return this.cached<ModelOption[]>(`models?provider=${encodeURIComponent(provider)}`) }
  detail(provider: string, model: string) { return this.cached<ModelDetail>(`models?provider=${encodeURIComponent(provider)}&model=${encodeURIComponent(model)}`) }
  save(changes: ModelDefaultChanges) { return this.request<ModelSettingsSnapshot>('model-defaults', { method: 'PUT', body: JSON.stringify(changes) }) }
}
