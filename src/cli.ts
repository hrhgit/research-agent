import { resolve } from 'node:path'
import { ResearchStore } from './store/sqlite.ts'
import { importArchitectureCandidates, importExperimentLog } from './importer/experiment-log.ts'

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : fallback
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command !== 'import') {
    console.error('Usage: node --experimental-strip-types src/cli.ts import --root <project> [--db <path>]')
    process.exitCode = 2; return
  }
  const root = resolve(option('--root', process.cwd())!)
  const dbPath = resolve(option('--db', resolve(process.cwd(), 'research.sqlite'))!)
  const store = new ResearchStore(dbPath, { busyTimeoutMs: 5000 })
  const markdown = await importExperimentLog(root, store)
  const candidates = await importArchitectureCandidates(root, store)
  const overview = store.overview()
  console.log(JSON.stringify({ db: dbPath, markdown, candidates, overview: { ...overview, recent_records: overview.recent_records.map(record => ({ id: record.id, question: record.question, verdict: record.verdict, conclusion: record.conclusion })) } }, null, 2))
  store.close()
}

await main()
