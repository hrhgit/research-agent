import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { now } from '../core/ids.ts'
import type { EvidenceRef, JsonValue, ResearchRecord, ResearchRun } from '../core/types.ts'
import { ResearchStore } from '../store/sqlite.ts'
import { parseFrontmatter } from './frontmatter.ts'
import { extractQuantumMetrics } from '../adapters/quantum.ts'

const IMPORTER_VERSION = 'experiment-log/v1'

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  return value === undefined || value === '' ? [] : [String(value)]
}

function verdict(result: string): ResearchRecord['verdict'] {
  if (/未通过|失败|rejected|failed|淘汰/i.test(result)) return 'rejected'
  if (/不确定|无法判断|inconclusive/i.test(result)) return 'inconclusive'
  if (/复现成功|通过|成功|pass|confirmed|支持/i.test(result)) return 'supported'
  return 'observed'
}

async function hashFile(path: string): Promise<string | undefined> {
  try { return createHash('sha256').update(await readFile(path)).digest('hex') } catch { return undefined }
}

function evidence(root: string, values: string[], sourcePath: string): EvidenceRef[] {
  const refs: EvidenceRef[] = [{ kind: 'log', path: relative(root, sourcePath), label: 'experiment-log source' }]
  refs.push(...values.map(path => ({ kind: (path.endsWith('/') ? 'directory' : 'file') as EvidenceRef['kind'], path: relative(root, resolve(root, path)), label: path })))
  return refs
}

export interface ImportSummary { directions: number; records: number; runs: number; skipped: string[] }

/** Imports the existing Markdown experiment-log without replacing its files. */
export async function importExperimentLog(root: string, store: ResearchStore): Promise<ImportSummary> {
  const experiments = resolve(root, 'experiments')
  const summary: ImportSummary = { directions: 0, records: 0, runs: 0, skipped: [] }
  let directionNames: string[] = []
  try { directionNames = await readdir(experiments, { withFileTypes: true }).then(entries => entries.filter(entry => entry.isDirectory() && entry.name !== '_global').map(entry => entry.name)) }
  catch { return summary }
  for (const directoryName of directionNames) {
    const directory = join(experiments, directoryName)
    const directionPath = join(directory, 'DIRECTION.md')
    let frontmatter: Record<string, unknown>
    try { frontmatter = parseFrontmatter(await readFile(directionPath, 'utf8')) } catch { summary.skipped.push(directionPath); continue }
    const directionId = `direction-${directoryName}`
    const existingDirection = store.getDirection(directionId)
    const direction = existingDirection ?? store.createDirection({
      id: directionId, title: String(frontmatter.direction ?? directoryName), goal: String(frontmatter.goal ?? ''),
      status: frontmatter.status === 'completed' ? 'completed' : 'active',
    })
    if (!existingDirection) summary.directions += 1
    const runsDir = join(directory, 'runs')
    let files: string[] = []
    try { files = (await readdir(runsDir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.md')).map(entry => entry.name) } catch { continue }
    for (const file of files) {
      const sourcePath = join(runsDir, file)
      const raw = await readFile(sourcePath, 'utf8')
      const data = parseFrontmatter(raw)
      const externalId = String(data.id ?? file.replace(/\.md$/, ''))
      const recordId = `record-${directoryName}-${externalId}`
      if (store.getRecord(recordId)) continue
      const runId = `run-${directoryName}-${externalId}`
      const sourceHash = await hashFile(sourcePath)
      const did = String(data.did ?? '')
      const result = String(data.result ?? '')
      const numbers = data.numbers === undefined ? undefined : { raw: data.numbers as string }
      const importedRun: ResearchRun = store.startRun({ id: runId, direction_id: direction.id, worker: 'experiment-log-import', command: did, artifacts: [{ kind: 'log', path: relative(root, sourcePath), sha256: sourceHash }] })
      store.finalizeRun(importedRun.id, { status: verdict(result) === 'rejected' ? 'failed' : 'succeeded', metrics: numbers })
      const parents = list(data.follows).map(parent => `record-${directoryName}-${parent}`)
      store.addRecord({
        id: recordId, kind: 'experiment', direction_id: direction.id, run_ids: [runId], question: String(data.question ?? ''),
        protocol: { did }, observations: { result, numbers: data.numbers ?? null, tags: list(data.tags) } as unknown as JsonValue, verdict: verdict(result),
        conclusion: result, lesson: data.takeaway ? String(data.takeaway) : undefined, boundary: data.caveats ? String(data.caveats) : undefined,
        evidence: evidence(root, list(data.evidence), sourcePath), provenance: { source: IMPORTER_VERSION, source_id: externalId, source_path: relative(root, sourcePath), imported_at: now(), importer_version: IMPORTER_VERSION },
        parents,
      })
      summary.records += 1; summary.runs += 1
    }
  }
  return summary
}

export async function importArchitectureCandidates(root: string, store: ResearchStore): Promise<ImportSummary> {
  const base = resolve(root, 'outputs/experiments')
  const summary: ImportSummary = { directions: 0, records: 0, runs: 0, skipped: [] }
  let files: string[] = []
  try { files = (await readdir(base, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')).map(entry => join(entry.parentPath, entry.name)) } catch { return summary }
  const existingDirection = store.getDirection('direction-architecture-exploration')
  const direction = existingDirection ?? store.createDirection({ id: 'direction-architecture-exploration', title: 'Architecture exploration', goal: 'Compare reusable structural research ideas across tasks', tags: ['imported', 'architecture'] })
  if (!existingDirection) summary.directions += 1
  for (const sourcePath of files) {
    let data: Record<string, unknown>
    try { data = JSON.parse(await readFile(sourcePath, 'utf8')) as Record<string, unknown> } catch { summary.skipped.push(sourcePath); continue }
    const relativePath = relative(root, sourcePath)
    const sourceId = String(data.variant ?? data.schema ?? relativePath)
    const recordId = `record-architecture-${createHash('sha1').update(relativePath).digest('hex').slice(0, 12)}`
    if (store.getRecord(recordId)) continue
    const runId = `${recordId.replace('record-', 'run-')}`
    const importedRun = store.startRun({ id: runId, direction_id: direction.id, worker: 'architecture-json-import', input: data as unknown as JsonValue, artifacts: [{ kind: 'file', path: relativePath }] })
    const decision = String(data.decision ?? 'observed')
    const runStatus: ResearchRun['status'] = /reject|fail|skip/i.test(decision) ? 'failed' : 'succeeded'
    store.finalizeRun(importedRun.id, { status: runStatus, metrics: { ...extractQuantumMetrics(data as unknown as JsonValue), ...(data.build as Record<string, JsonValue> | undefined) } })
    store.addRecord({
      id: recordId, kind: 'experiment', direction_id: direction.id, run_ids: [runId], question: `What happened in architecture candidate ${sourceId}?`,
      protocol: { source: relativePath, config: data.config ?? null } as unknown as JsonValue, observations: data as unknown as JsonValue, verdict: runStatus === 'failed' ? 'rejected' : 'observed',
      conclusion: decision, boundary: 'Imported from a candidate JSON; this record does not claim leaderboard validity.', evidence: [{ kind: 'file', path: relativePath }],
      provenance: { source: 'architecture-candidate/v1', source_id: sourceId, source_path: relativePath, imported_at: now(), importer_version: IMPORTER_VERSION }, parents: [],
    })
    summary.records += 1; summary.runs += 1
  }
  return summary
}
