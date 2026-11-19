import type { IncomingMessage, ServerResponse } from 'node:http'
import { ResearchApi } from './api.ts'

type RouteHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
export interface DshWebServerLike { register(route: { kind: 'prefix'; path: string; handler: RouteHandler }): () => void }

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  response.end(JSON.stringify(value))
}

async function body(request: IncomingMessage, limit = 512 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk); if (size > limit) throw new Error('Request body is too large')
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown } catch { throw new Error('Request body is not JSON') }
}

function query(url: URL, key: string): string | undefined { const value = url.searchParams.get(key); return value === null ? undefined : value }

/** Mounts the Research panel's transport under /research/api in DSH's loopback web server. */
export function registerResearchHttp(server: DshWebServerLike, api: ResearchApi, authorize?: (request: IncomingMessage) => number | undefined, settings?: Record<string, unknown>): () => void {
  return server.register({ kind: 'prefix', path: '/research', handler: async (request, response) => {
    const rejection = authorize?.(request)
    if (rejection !== undefined) { writeJson(response, rejection, { error: 'Authentication required' }); return }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith('/research/api/')) { writeJson(response, 404, { error: 'Not found' }); return }
    try {
      const path = url.pathname.slice('/research/api/'.length).replace(/\/$/, '')
      const method = request.method ?? 'GET'
      let result: unknown
      const abort = new AbortController()
      response.once('close', () => { if (!response.writableEnded) abort.abort() })
      if (method === 'GET' && path === 'state') result = api.state()
      else if (method === 'GET' && path === 'board') result = api.board()
      else if (method === 'GET' && path === 'models') {
        if (!api.dispatcher) throw new Error('模型服务不可用。')
        result = await api.dispatcher.listModels({ provider: query(url, 'provider'), model: query(url, 'model') }, abort.signal)
      }
      else if (method === 'GET' && path === 'model-defaults') {
        if (!api.modelSettings) throw new Error('模型设置服务不可用。')
        result = api.modelSettings.snapshot()
      }
      else if (method === 'PUT' && path === 'model-defaults') {
        if (!api.modelSettings) throw new Error('模型设置服务不可用。')
        result = await api.modelSettings.save(await body(request), abort.signal)
      }
      else if (method === 'GET' && path === 'config') result = settings ?? {}
      else if (method === 'GET' && path === 'directions') result = api.directions()
      else if (method === 'GET' && path === 'tasks') result = api.tasks(query(url, 'direction_id'))
      else if (method === 'GET' && path === 'runs') result = api.runs({ direction_id: query(url, 'direction_id'), task_id: query(url, 'task_id'), status: query(url, 'status') as never, limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'records') result = api.records({ direction_id: query(url, 'direction_id'), kind: query(url, 'kind') as never, query: query(url, 'q'), limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'insights') result = api.insights(query(url, 'direction_id'))
      else if (method === 'GET' && path === 'sources') result = api.sources({ request_id: query(url, 'request_id'), assignment_id: query(url, 'assignment_id'), query: query(url, 'q'), limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'candidates') result = api.candidates({ request_id: query(url, 'request_id'), direction_id: query(url, 'direction_id'), task_id: query(url, 'task_id'), status: query(url, 'status') as never, limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'incubations') result = api.incubations({ id: query(url, 'id'), direction_id: query(url, 'direction_id'), status: query(url, 'status') as never, limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'requests') result = api.requests({ status: query(url, 'status') as never, limit: Number(query(url, 'limit') ?? 100) })
      else if (method === 'GET' && path === 'assignments') result = api.assignments(query(url, 'request_id'))
      else if (method === 'GET' && path === 'dispatch') result = api.dispatchEvents(query(url, 'request_id'))
      else if (method === 'GET' && path === 'recall') result = api.recall(query(url, 'q') ?? '', Number(query(url, 'limit') ?? 20))
      else if (method === 'GET' && path === 'tools/versions') result = api.store.listToolVersions(query(url, 'tool_name'))
      else if (method === 'GET' && path === 'tools/changes') result = api.store.listToolChanges({ tool_name: query(url, 'tool_name'), status: query(url, 'status') as never })
      else if (method === 'POST' && path === 'directions') result = api.createDirection(await body(request) as Parameters<ResearchApi['createDirection']>[0])
      else if (method === 'POST' && path === 'tasks') result = api.createTask(await body(request) as Parameters<ResearchApi['createTask']>[0])
      else if (method === 'POST' && path === 'runs') result = api.startRun(await body(request) as Parameters<ResearchApi['startRun']>[0])
      else if (method === 'POST' && path.startsWith('runs/') && path.endsWith('/finalize')) {
        const runId = path.slice('runs/'.length, -'/finalize'.length); result = api.finalizeRun(runId, await body(request) as Parameters<ResearchApi['finalizeRun']>[1])
      } else if (method === 'POST' && path === 'records') result = api.addRecord(await body(request) as Parameters<ResearchApi['addRecord']>[0])
      else if (method === 'POST' && path === 'insights') result = api.addInsight(await body(request) as Parameters<ResearchApi['addInsight']>[0])
      else if (method === 'POST' && path === 'recommendations/scale') { const input = await body(request) as { policy: Parameters<ResearchApi['recommendScale']>[0]; observations: Parameters<ResearchApi['recommendScale']>[1] }; result = api.recommendScale(input.policy, input.observations) }
      else if (method === 'POST' && path === 'tools/versions') result = api.registerToolVersion(await body(request) as Parameters<ResearchApi['registerToolVersion']>[0])
      else if (method === 'POST' && path === 'tools/changes') result = api.proposeToolChange(await body(request) as Parameters<ResearchApi['proposeToolChange']>[0])
      else if (method === 'POST' && path.startsWith('tools/changes/') && path.endsWith('/review')) { const proposalId = path.slice('tools/changes/'.length, -'/review'.length); const input = await body(request) as { status: Parameters<ResearchApi['reviewToolChange']>[1] }; result = api.reviewToolChange(proposalId, input.status) }
      else { writeJson(response, 404, { error: 'Route not found' }); return }
      writeJson(response, 200, result)
    } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) }) }
  }})
}
