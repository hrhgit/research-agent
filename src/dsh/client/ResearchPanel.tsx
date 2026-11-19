import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ResearchDirection, ResearchOverview, ResearchRecord, ResearchRequest, ResearchAssignment, ResearchDispatchEvent } from '../../core/types.ts'
import { panelStyles } from './styles.ts'
import { ModelSettings } from './ModelSettings.tsx'
import { modelStyles } from './model-styles.ts'
import { modelZh, type ModelTranslate } from './model-copy.ts'
import { DEFAULT_START_PROMPT } from './start.ts'
import { ResearchBoard } from './ResearchBoard.tsx'
import { roleLabels as roles, statusLabels as statuses } from './board-view.ts'

export interface ResearchPanelProps {
  apiBase?: string; modelText?: ModelTranslate
  /** Opens a research-mode session with the prompt as its draft; false when DSH cannot open one from here. */
  onStart?: (prompt?: string) => boolean
}
interface Settings { dbPath?: string; projectRoot?: string | null; importOnStart?: boolean; toolNames?: string[]; startPrompt?: string | null }

async function get<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`研究数据读取失败（${response.status}），请刷新重试。`)
  return await response.json() as T
}


const verdicts = { supported: '支持', refuted: '未支持', inconclusive: '待确认', rejected: '未通过', observed: '观察' }

/** 一级：请求进展与记录搜索。二级：方向和统计。三级：展开派工、证据、事件和接入配置。 */
export function ResearchPanel({ apiBase = '/research/api', modelText = key => modelZh[key], onStart }: ResearchPanelProps) {
  const [view, setView] = useState<'overview' | 'board' | 'models'>('overview')
  const [modelsOpened, setModelsOpened] = useState(false)
  const [overview, setOverview] = useState<ResearchOverview>()
  const [directions, setDirections] = useState<ResearchDirection[]>([])
  const [records, setRecords] = useState<ResearchRecord[]>([])
  const [requests, setRequests] = useState<ResearchRequest[]>([])
  const [settings, setSettings] = useState<Settings>({})
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [error, setError] = useState<string>()
  const [loading, setLoading] = useState(true)
  const pending = useRef<AbortController>()

  const load = async (search = '') => {
    pending.current?.abort()
    const request = new AbortController(); pending.current = request
    setLoading(true); setError(undefined)
    try {
      const [state, directionList, recordList, requestList, config] = await Promise.all([
        get<ResearchOverview>(`${apiBase}/state`, request.signal), get<ResearchDirection[]>(`${apiBase}/directions`, request.signal),
        get<ResearchRecord[]>(`${apiBase}/${search ? `recall?q=${encodeURIComponent(search)}` : 'records?limit=20'}`, request.signal),
        get<ResearchRequest[]>(`${apiBase}/requests?limit=20`, request.signal),
        get<Settings>(`${apiBase}/config`, request.signal),
      ])
      if (request.signal.aborted) return
      setOverview(state); setDirections(directionList); setRecords(recordList); setRequests(requestList); setSettings(config); setAppliedQuery(search)
    } catch (cause) { if (!request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { if (!request.signal.aborted) setLoading(false) }
  }

  useEffect(() => { void load(); return () => pending.current?.abort() }, [apiBase])
  const submit = (event: FormEvent) => { event.preventDefault(); void load(query.trim()) }
  const startPrompt = settings.startPrompt?.trim() || DEFAULT_START_PROMPT
  const start = () => { if (!onStart?.(startPrompt)) setError('这里不能直接开新会话。请新建会话，在模式菜单选择“研究模式”后再开始。') }

  return <section className="research-panel" aria-labelledby="research-panel-title">
    <style>{panelStyles}</style>
    <style>{modelStyles}</style>
    <header className="research-panel__header">
      <div><p className="research-panel__eyebrow">RESEARCH</p><h1 id="research-panel-title">研究调度与记录</h1><p className="research-panel__hint">“启动研究”会用研究模式开一个新会话，并把预置提示词放进输入框；发送后照常对话。</p></div>
      <div className="research-panel__actions">
        {view === 'overview' && <button type="button" onClick={() => void load(appliedQuery)} disabled={loading}>刷新</button>}
        <button className="research-panel__primary" type="button" onClick={start} title={startPrompt}>启动研究</button>
      </div>
    </header>
    <nav className="research-panel__tabs" aria-label="研究面板">
      <button type="button" aria-pressed={view === 'overview'} onClick={() => setView('overview')}>{modelText('overview')}</button>
      <button type="button" aria-pressed={view === 'board'} onClick={() => setView('board')}>研究状态</button>
      <button type="button" aria-pressed={view === 'models'} onClick={() => { setModelsOpened(true); setView('models') }}>{modelText('title')}</button>
    </nav>
    {view === 'board' && <ResearchBoard apiBase={apiBase} embedded />}
    {modelsOpened && <div hidden={view !== 'models'}><ModelSettings apiBase={apiBase} t={modelText} /></div>}
    <div hidden={view !== 'overview'}>
    <form className="research-panel__search" onSubmit={submit}>
      <label className="research-panel__sr" htmlFor="research-query">搜索记录</label>
      <input id="research-query" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索问题、结论或教训" />
      <button className="research-panel__primary" type="submit" disabled={loading}>搜索</button>
    </form>
    {error && <p role="alert" className="research-panel__error">{error}</p>}
    {overview && <div className="research-panel__stats" aria-label="研究统计">
      <Stat label="研究方向" value={overview.directions} /><Stat label="任务" value={overview.tasks} />
      <Stat label="运行中" value={overview.active_runs} /><Stat label="排队请求" value={overview.queued_requests} /><Stat label="处理中" value={overview.active_requests} />
      <Stat label="记录" value={overview.records} /><Stat label="洞见" value={overview.insights} />
    </div>}
    <details className="research-panel__config"><summary>接入配置 · {settings.toolNames?.length ?? 0} 个研究工具</summary>
      <p>研究工具仅在“研究模式”中加载。主会话里的请求会进入持久队列，总控负责判断、派工、恢复和收口；不会接入 GitHub 或飞书。会话开始后模式固定；已有会话请新建后选择。正式结论仍由总控确认，这里的记录在所有模式下均可查看。</p>
      <dl><dt>数据库</dt><dd><code>{settings.dbPath}</code></dd><dt>历史记录来源</dt><dd><code>{settings.projectRoot || '未配置'}</code></dd><dt>启动时导入</dt><dd>{settings.importOnStart ? '开启（已有记录不重复写入）' : '关闭'}</dd><dt>模型</dt><dd>主会话使用 DSH 中选择的模型；各角色默认值在“子智能体模型”中设置。</dd><dt>启动提示词</dt><dd>{startPrompt}{!settings.startPrompt?.trim() && '（默认；可在插件配置的 startPrompt 中改写）'}</dd></dl>
      <details><summary>工具列表</summary><ul>{settings.toolNames?.map(name => <li key={name}><code>{name}</code></li>)}</ul></details>
    </details>
    <div className="research-panel__columns">
      <aside><h2>研究方向</h2>{directions.length ? <ul>{directions.map(direction => <li key={direction.id}><strong>{direction.title}</strong><p>{direction.goal || direction.status}</p></li>)}</ul> : <p>选择“研究模式”后描述研究问题，AI 可在这里建立方向。</p>}</aside>
      <section aria-busy={loading}><h2>{appliedQuery ? '搜索结果' : '最近记录'}</h2>
        {loading && <p role="status">正在读取记录…</p>}
        {!loading && !records.length && <p>{appliedQuery ? '没有找到匹配记录。' : '还没有研究记录。'}</p>}
        <ul className="research-panel__records">{records.map(record => <li key={record.id}>
          <details><summary><span className="research-panel__record-meta"><span>{verdicts[record.verdict]}</span><time>{record.created_at.slice(0, 10)}</time></span><strong>{record.question || record.conclusion}</strong><p>{record.conclusion}</p><span className="research-panel__details-label">查看详情</span></summary>
            <div className="research-panel__detail">
              {record.lesson && <p><b>教训</b>{record.lesson}</p>}{record.boundary && <p><b>适用边界</b>{record.boundary}</p>}
              <p><b>记录编号</b><code>{record.id}</code></p>
              {!!record.parents.length && <p><b>承接记录</b>{record.parents.join(' · ')}</p>}
              {!!record.evidence.length && <div><b>证据</b><ul>{record.evidence.map((item, index) => <li key={index}><code>{item.path}</code>{item.label && <span> · {item.label}</span>}</li>)}</ul></div>}
              <details><summary>原始记录</summary><pre>{JSON.stringify(record, null, 2)}</pre></details>
            </div>
          </details>
        </li>)}</ul>
      </section>
    </div>
    <section className="research-panel__queue"><h2>主会话请求队列</h2>
      {!requests.length && <p>还没有进入队列的研究请求。请在研究模式的主会话中描述研究问题。</p>}
      {!!requests.length && <ul>{requests.map(request => <li key={request.id}>
        <span className={`research-panel__status research-panel__status--${request.status}`}>{statuses[request.status]}</span><strong>{request.title}</strong><time>{request.updated_at.slice(0, 16).replace('T', ' ')}</time>
        <RequestDetails key={`${request.id}:${request.updated_at}`} request={request} apiBase={apiBase} />
      </li>)}</ul>}
    </section>
    </div>
  </section>
}

function Stat({ label, value }: { label: string; value: number }) { return <div><strong>{value}</strong><span>{label}</span></div> }

function RequestDetails({ request, apiBase }: { request: ResearchRequest; apiBase: string }) {
  const [open, setOpen] = useState(false)
  const [assignments, setAssignments] = useState<ResearchAssignment[]>()
  const [events, setEvents] = useState<ResearchDispatchEvent[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!open) return
    const abort = new AbortController()
    void Promise.all([
      get<ResearchAssignment[]>(`${apiBase}/assignments?request_id=${encodeURIComponent(request.id)}`, abort.signal),
      get<ResearchDispatchEvent[]>(`${apiBase}/dispatch?request_id=${encodeURIComponent(request.id)}`, abort.signal),
    ]).then(([work, trace]) => { setAssignments(work); setEvents(trace) }).catch(cause => { if (!abort.signal.aborted) setError(String(cause)) })
    return () => abort.abort()
  }, [open, request.id, apiBase])
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>查看分工与报告</summary><p>{request.message}</p>
    {request.last_error && <p role="status">{request.last_error}</p>}
    {error && <p role="alert">{error}</p>}
    {open && !assignments && !error && <p role="status">正在读取分工…</p>}
    {assignments && !assignments.length && <p>尚未派工。</p>}
    <ul>{assignments?.map(assignment => <li key={assignment.id}>
      <strong>{roles[assignment.role]}</strong> · <span>{statuses[assignment.status]}</span><p>{assignment.instruction}</p>
      {assignment.error && <p>{assignment.error}</p>}
      <dl><dt>子会话</dt><dd><code>{assignment.child_id || '尚未启动'}</code></dd><dt>执行次数</dt><dd>{assignment.attempt}</dd></dl>
      {assignment.report !== undefined && <details><summary>证据报告</summary><pre>{JSON.stringify(assignment.report, null, 2)}</pre></details>}
    </li>)}</ul>
    <details><summary>请求与事件详情</summary><p>请求 <code>{request.id}</code></p><p>主会话 <code>{request.session_id}</code></p><pre>{JSON.stringify(events, null, 2)}</pre></details>
  </details>
}
