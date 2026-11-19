import type { JsonValue } from '../core/types.ts'

const METRIC_KEYS = new Set([
  'qubits', 'toffoli', 'toffolis', 'ops', 'bits', 'reaction_depth', 'score', 'shots',
  'phase_errors', 'value_errors', 'lambda_eff', 'build_seconds', 'static_toffoli',
])

/** Extracts stable quantum resource/error fields from nested verifier or build JSON. */
export function extractQuantumMetrics(value: JsonValue): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {}
  const visit = (current: JsonValue, depth: number): void => {
    if (depth > 8 || current === null || typeof current !== 'object') return
    if (Array.isArray(current)) { for (const item of current) visit(item, depth + 1); return }
    for (const [key, item] of Object.entries(current)) {
      if (METRIC_KEYS.has(key) && (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean' || item === null) && result[key] === undefined) result[key] = item
      visit(item, depth + 1)
    }
  }
  visit(value, 0)
  return result
}

export function isQuantumCandidate(value: JsonValue): boolean {
  const metrics = extractQuantumMetrics(value)
  return metrics.qubits !== undefined || metrics.toffoli !== undefined || metrics.static_toffoli !== undefined
}
