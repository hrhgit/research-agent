/** Fixed limits for developing one structural candidate over several measured rounds. */
export interface IncubationPolicy {
  /** Key in run.metrics that holds the complete cost or score of the candidate. */
  metric: string
  effect_direction: 'higher_better' | 'lower_better'
  /** The control's value on the same metric and scale. */
  control_effect: number
  /** Gap ratio at or below which the candidate leaves incubation. 1 means parity with the control. */
  graduate_ratio: number
  /** Share of the remaining gap that must close within `patience` measured rounds. */
  min_gap_closure: number
  patience: number
  max_rounds: number
  max_total_cost_units: number
  max_failed_rounds: number
  /** Optional ceiling on the first measured gap ratio; a wider gap is not incubated. */
  max_entry_ratio?: number
}

export interface IncubationObservation {
  run_id: string
  valid: boolean
  effect?: number
  /** Control value for this round when the scale differs from the policy's. */
  control_effect?: number
  cost_units: number
}

export type IncubationAction = 'continue' | 'graduate' | 'stop'

export interface IncubationRecommendation {
  action: IncubationAction
  reason_code: 'no_round' | 'invalid_round' | 'too_many_failures' | 'graduated' | 'entry_gap' | 'cost_limit' | 'round_limit' | 'stalled' | 'closing'
  reason: string
  /** Latest measured gap ratio: above graduate_ratio means the candidate is still behind. */
  ratio?: number
  best_ratio?: number
  /** Share of the remaining gap closed by the best of the last `patience` measured rounds. */
  window_closure?: number
  rounds_used: number
  rounds_left: number
  cost_used: number
  evidence_run_ids: string[]
}

function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`)
  return value
}

/** Rejects policies that could not stop an incubation. */
export function validateIncubationPolicy(policy: IncubationPolicy): IncubationPolicy {
  if (!policy || typeof policy !== 'object') throw new Error('Incubation policy is required')
  if (typeof policy.metric !== 'string' || !policy.metric.trim()) throw new Error('Incubation policy metric is required')
  if (policy.effect_direction !== 'higher_better' && policy.effect_direction !== 'lower_better') throw new Error('Incubation policy effect_direction must be higher_better or lower_better')
  positive(policy.control_effect, 'Incubation control_effect')
  positive(policy.graduate_ratio, 'Incubation graduate_ratio')
  positive(policy.max_total_cost_units, 'Incubation max_total_cost_units')
  if (!(positive(policy.min_gap_closure, 'Incubation min_gap_closure') < 1)) throw new Error('Incubation min_gap_closure must be below 1')
  if (!Number.isInteger(policy.patience) || policy.patience < 1) throw new Error('Incubation patience must be a positive integer')
  if (!Number.isInteger(policy.max_rounds) || policy.max_rounds <= policy.patience) throw new Error('Incubation max_rounds must be an integer above patience')
  if (!Number.isInteger(policy.max_failed_rounds) || policy.max_failed_rounds < 0) throw new Error('Incubation max_failed_rounds must be a non-negative integer')
  if (policy.max_entry_ratio !== undefined && !(positive(policy.max_entry_ratio, 'Incubation max_entry_ratio') > policy.graduate_ratio)) {
    throw new Error('Incubation max_entry_ratio must be above graduate_ratio')
  }
  return { ...policy, metric: policy.metric.trim() }
}

/** Gap ratio of a measured effect against its control: 1 is parity, above 1 is behind. */
export function gapRatio(policy: IncubationPolicy, effect: number, control = policy.control_effect): number {
  positive(effect, 'Incubation effect'); positive(control, 'Incubation control_effect')
  return policy.effect_direction === 'lower_better' ? effect / control : control / effect
}

/**
 * Judges a structural candidate by whether its gap to the control keeps closing,
 * and keeps the round, cost and failure limits outside the model.
 */
export function recommendIncubation(policy: IncubationPolicy, observations: IncubationObservation[]): IncubationRecommendation {
  const cost_used = observations.reduce((sum, item) => sum + Math.max(0, item.cost_units), 0)
  const base = { rounds_used: observations.length, rounds_left: Math.max(0, policy.max_rounds - observations.length), cost_used }
  if (!observations.length) return { ...base, action: 'continue', reason_code: 'no_round', reason: 'No round has been measured; build and measure the first version.', evidence_run_ids: [] }

  const measured = observations.filter(item => item.valid).map(item => ({ run_id: item.run_id, ratio: gapRatio(policy, item.effect!, item.control_effect) }))
  const failed = observations.filter(item => !item.valid)
  const latest = observations.at(-1)!
  const ratios = measured.map(item => item.ratio)
  const stats = measured.length ? { ratio: ratios.at(-1)!, best_ratio: Math.min(...ratios) } : {}

  if (failed.length > policy.max_failed_rounds) {
    return { ...base, ...stats, action: 'stop', reason_code: 'too_many_failures', reason: 'The failed-round limit was reached.', evidence_run_ids: failed.map(item => item.run_id) }
  }
  if (latest.valid && stats.ratio! <= policy.graduate_ratio) {
    return { ...base, ...stats, action: 'graduate', reason_code: 'graduated', reason: `The gap ratio ${stats.ratio!.toPrecision(4)} reached the graduation threshold ${policy.graduate_ratio}; continue with scale-up and full verification.`, evidence_run_ids: [latest.run_id] }
  }
  if (measured.length === 1 && latest.valid && policy.max_entry_ratio !== undefined && stats.ratio! > policy.max_entry_ratio) {
    return { ...base, ...stats, action: 'stop', reason_code: 'entry_gap', reason: `The first measured gap ratio ${stats.ratio!.toPrecision(4)} is above the entry ceiling ${policy.max_entry_ratio}.`, evidence_run_ids: [latest.run_id] }
  }
  if (cost_used >= policy.max_total_cost_units) {
    return { ...base, ...stats, action: 'stop', reason_code: 'cost_limit', reason: 'The cumulative incubation cost reached the configured limit.', evidence_run_ids: observations.map(item => item.run_id) }
  }
  if (observations.length >= policy.max_rounds) {
    return { ...base, ...stats, action: 'stop', reason_code: 'round_limit', reason: 'All configured incubation rounds were used without reaching the control.', evidence_run_ids: observations.map(item => item.run_id) }
  }
  if (!latest.valid) {
    return { ...base, ...stats, action: 'continue', reason_code: 'invalid_round', reason: 'The latest round produced no valid measurement; repair it before changing the design.', evidence_run_ids: [latest.run_id] }
  }
  if (measured.length > policy.patience) {
    const window = measured.slice(-policy.patience)
    const bestBefore = Math.min(...measured.slice(0, -policy.patience).map(item => item.ratio))
    const bestWindow = Math.min(...window.map(item => item.ratio))
    const window_closure = (bestBefore - bestWindow) / (bestBefore - policy.graduate_ratio)
    if (window_closure < policy.min_gap_closure) {
      return { ...base, ...stats, window_closure, action: 'stop', reason_code: 'stalled', reason: `The last ${policy.patience} measured round(s) closed ${(window_closure * 100).toFixed(1)}% of the remaining gap; ${(policy.min_gap_closure * 100).toFixed(1)}% is required.`, evidence_run_ids: window.map(item => item.run_id) }
    }
    return { ...base, ...stats, window_closure, action: 'continue', reason_code: 'closing', reason: `The gap ratio is ${stats.ratio!.toPrecision(4)} and the last ${policy.patience} measured round(s) closed ${(window_closure * 100).toFixed(1)}% of the remaining gap.`, evidence_run_ids: window.map(item => item.run_id) }
  }
  return { ...base, ...stats, action: 'continue', reason_code: 'closing', reason: `The gap ratio is ${stats.ratio!.toPrecision(4)}; a first version behind the control is expected. Target the dominant remaining cost next.`, evidence_run_ids: [latest.run_id] }
}
