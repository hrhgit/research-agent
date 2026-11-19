import { resolve } from 'node:path'
import { importArchitectureCandidates, importExperimentLog } from '../importer/experiment-log.ts'
import { ResearchApi, createResearchTools } from './api.ts'
import { registerResearchHttp, type DshWebServerLike } from './http.ts'
import { ResearchStore } from '../store/sqlite.ts'

export interface ResearchRuntimeOptions {
  dbPath: string
  projectRoot?: string
  busyTimeoutMs?: number
}

/** Runtime factory used by a DSH bundle. Importing is explicit so startup never silently changes facts. */
export function createResearchRuntime(options: ResearchRuntimeOptions) {
  const store = new ResearchStore(resolve(options.dbPath), { busyTimeoutMs: options.busyTimeoutMs ?? 5000 })
  const api = new ResearchApi(store)
  const recovered = store.recoverDispatch()
  return {
    store,
    api,
    recovered,
    tools: createResearchTools(api),
    mount(server: DshWebServerLike, authorize?: Parameters<typeof registerResearchHttp>[2], settings?: Parameters<typeof registerResearchHttp>[3]) { return registerResearchHttp(server, api, authorize, settings) },
    async importExisting() {
      if (!options.projectRoot) return { markdown: null, candidates: null }
      const markdown = await importExperimentLog(options.projectRoot, store)
      const candidates = await importArchitectureCandidates(options.projectRoot, store)
      return { markdown, candidates }
    },
    close() { store.close() },
  }
}
