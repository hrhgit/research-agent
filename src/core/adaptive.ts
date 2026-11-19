import { id, now } from './ids.ts'
import type { JsonValue, ResearchToolChangeProposal } from './types.ts'

export interface ScaleStage {
  id: string
  label: string
  order: number
  scale: number
  max_cost_units?: number
}

export interface AdaptivePolicy {
  stages: ScaleStage[]
  effect_direction: 'higher_better' | 'lower_better'
  baseline_effect?: number
  min_effect_retention: number
  max_total_cost_units: number
  max_failed_runs: number
  min_marginal_gain_per_cost?: number
}

export interface AdaptiveObservation {
  run_id: string
  stage_id: string
  effect: number
  cost_units: number
  valid: boolean
  created_at?: string
  metrics?: Record<string, JsonValue>
}

export type ScaleAction = 'run_first' | 'retry' | 'expand' | 'stop' | 'review'

export interface ScaleRecommendation {
  action: ScaleAction
  next_stage_id?: string
  reason_code: 'no_observation' | 'invalid_run' | 'effect_floor' | 'cost_limit' | 'marginal_gain' | 'next_stage' | 'complete' | 'too_many_failures'
  reason: string
  retention?: number
  marginal_gain_per_cost?: number
  evidence_run_ids: string[]
}

function retention(policy: AdaptivePolicy, baseline: number, effect: number): number {
  if (baseline === 0 || effect === 0) return baseline === effect ? 1 : 0
  return policy.effect_direction === 'higher_better' ? effect / baseline : baseline / effect
}

function gain(policy: AdaptivePolicy, previous: number, current: number): number {
  return policy.effect_direction === 'higher_better' ? current - previous : previous - current
}

/** Recommends the next scale while keeping hard effect and cost gates outside the model. */
export function recommendNextScale(policy: AdaptivePolicy, observations: AdaptiveObservation[]): ScaleRecommendation {
  const stages = [...policy.stages].sort((a, b) => a.order - b.order)
  if (!stages.length) return { action: 'review', reason_code: 'complete', reason: 'No scale stages are configured.', evidence_run_ids: [] }
  if (!observations.length) return { action: 'run_first', next_stage_id: stages[0]!.id, reason_code: 'no_observation', reason: `Start with the smallest configured scale: ${stages[0]!.label}.`, evidence_run_ids: [] }
  const failed = observations.filter(item => !item.valid)
  const latest = observations.at(-1)!
  if (!latest.valid) {
    if (failed.length > policy.max_failed_runs) return { action: 'review', reason_code: 'too_many_failures', reason: 'The failure limit was reached; review the protocol before spending more resources.', evidence_run_ids: failed.map(item => item.run_id) }
    return { action: 'retry', next_stage_id: latest.stage_id, reason_code: 'invalid_run', reason: 'The latest run was invalid; retry the same scale before expanding.', evidence_run_ids: [latest.run_id] }
  }
  const baseline = policy.baseline_effect ?? observations.find(item => item.valid)?.effect ?? latest.effect
  const currentRetention = retention(policy, baseline, latest.effect)
  const totalCost = observations.reduce((sum, item) => sum + Math.max(0, item.cost_units), 0)
  if (totalCost >= policy.max_total_cost_units) return { action: 'stop', reason_code: 'cost_limit', reason: 'The cumulative experiment cost reached the configured limit.', retention: currentRetention, evidence_run_ids: observations.map(item => item.run_id) }
  if (currentRetention < policy.min_effect_retention) return { action: 'stop', reason_code: 'effect_floor', reason: 'The latest result fell below the allowed effect-retention floor.', retention: currentRetention, evidence_run_ids: [latest.run_id] }
  const currentIndex = stages.findIndex(stage => stage.id === latest.stage_id)
  const next = stages[currentIndex + 1]
  if (!next) return { action: 'stop', reason_code: 'complete', reason: 'All configured scale stages have been tested.', retention: currentRetention, evidence_run_ids: observations.map(item => item.run_id) }
  const previous = [...observations].reverse().find(item => item.valid && item.stage_id !== latest.stage_id)
  if (previous && policy.min_marginal_gain_per_cost !== undefined) {
    const costDelta = latest.cost_units - previous.cost_units
    const marginal = costDelta > 0 ? Math.max(0, gain(policy, previous.effect, latest.effect)) / costDelta : Number.POSITIVE_INFINITY
    if (marginal < policy.min_marginal_gain_per_cost) return { action: 'stop', reason_code: 'marginal_gain', reason: 'The measured improvement per added cost is below the configured threshold.', retention: currentRetention, marginal_gain_per_cost: marginal, evidence_run_ids: [previous.run_id, latest.run_id] }
    return { action: 'expand', next_stage_id: next.id, reason_code: 'next_stage', reason: `Effect retention is acceptable and marginal gain is ${marginal.toPrecision(4)} per cost unit.`, retention: currentRetention, marginal_gain_per_cost: marginal, evidence_run_ids: [previous.run_id, latest.run_id] }
  }
  return { action: 'expand', next_stage_id: next.id, reason_code: 'next_stage', reason: 'Effect retention is above the floor; test the next scale.', retention: currentRetention, evidence_run_ids: [latest.run_id] }
}

export function proposeToolChange(input: Omit<ResearchToolChangeProposal, 'schema' | 'id' | 'created_at' | 'updated_at' | 'status'> & { id?: string }): ResearchToolChangeProposal {
  const timestamp = now()
  return { schema: 'research-tool-change/v1', id: input.id ?? id('tool-change'), status: 'proposed', created_at: timestamp, updated_at: timestamp, ...input }
}
