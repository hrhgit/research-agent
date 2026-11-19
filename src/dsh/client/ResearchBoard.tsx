import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { BoardAgent, BoardDirection, BoardIncubation, BoardLine, BoardOutcome, ResearchBoard as Board } from '../board.ts'
import { boardStyles } from './board-styles.ts'
import { officeStyles, PixelOffice } from './PixelOffice.tsx'
import {
  ago, chartGeometry, decisionLabels, elapsed, groupAgents, incubationLabels, outcomeLabels, reasonSources, roleLabels, runLabels, statusLabels, times,
} from './board-view.ts'

export interface ResearchBoardProps {
  apiBase?: string
  /** False while the board is on a hidden tab; it stops reading until shown again. */
  visible?: boolean
  /** Rendered inside another scrolling panel instead of filling a side tab. */
  embedded?: boolean
}

const POLL_MS = 5000
const OUTCOMES: BoardOutcome[] = ['active', 'adopted', 'undecided', 'pending', 'abandoned']
const COLLAPSED_LINES = 6

/** Reads the board while it is on screen, so a hidden tab costs nothing. */
function useBoard(apiBase: string, visible: boolean, host: RefObject<HTMLElement | null>) {
  const [board, setBoard] = useState<Board>()
  const [error, setError] = useState<string>()
  useEffect(() => {
    if (!visible) return
    let stopped = false; let pending: AbortController | undefined
    const load = async () => {
      if (document.visibilityState !== 'visible' || host.current?.offsetParent === null) return
      pending?.abort(); const request = new AbortController(); pending = request
      try {
        const response = await fetch(`${apiBase}/board`, { headers: { accept: 'application/json' }, signal: request.signal })
        if (!response.ok) throw new Error(`研究状态读取失败（${response.status}）`)
        const next = await response.json() as Board
        if (!stopped) { setBoard(next); setError(undefined) }
      } catch (cause) { if (!stopped && !request.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)) }
    }
    void load()
    const timer = setInterval(() => void load(), POLL_MS)
    const onShow = () => { if (document.visibilityState === 'visible') void load() }
    document.addEventListener('visibilitychange', onShow)
    return () => { stopped = true; pending?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onShow) }
  }, [apiBase, visible])
  return { board, error }
}

/** A clock that only ticks while something on screen is counting. */
function useNow(ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!ticking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [ticking])
  return now
}

/** 一级：谁在工作。二级：孵化中的候选离对照还有多远。三级：走过的路线里哪些采纳、哪些放弃及原因。 */
export function ResearchBoard({ apiBase = '/research/api', visible = true, embedded = false }: ResearchBoardProps) {
  const host = useRef<HTMLElement>(null)
  const { board, error } = useBoard(apiBase, visible, host)
  const running = board?.agents.filter(agent => agent.status === 'running').length ?? 0
  const now = useNow(visible && running > 0)
  const total = (outcome: BoardOutcome) => board?.lines.reduce((sum, group) => sum + group.counts[outcome], 0) ?? 0
  const incubating = board?.incubations.filter(item => item.status === 'incubating' || item.status === 'paused').length ?? 0

  return <section ref={host} className={`rb${embedded ? ' rb--embedded' : ''}`} aria-label="研究状态">
    <style>{boardStyles}{officeStyles}</style>
    <header className="rb-head">
      <h2>研究状态</h2>
      {board && <span className={`rb-live${error ? ' rb-live--off' : ''}`} title="每 5 秒读取一次；面板隐藏时暂停"><i key={board.generated_at} />{new Date(board.generated_at).toLocaleTimeString('zh-CN', { hour12: false })}</span>}
    </header>
    {error && <p role="alert" className="rb-error">{error}{board ? '，显示的是上次读到的内容。' : '。'}</p>}
    {!board && !error && <p role="status" className="rb-empty">正在读取研究状态…</p>}
    {board && <>
      <div className="rb-tiles" aria-label="概况">
        <Tile tone="run" value={running} label="在工作" />
        <Tile tone="run" value={incubating} label="孵化中" />
        <Tile tone="ok" value={total('adopted')} label="已采纳" />
        <Tile tone="bad" value={total('abandoned')} label="已放弃" />
      </div>
      <div className="rb-grid">
        <div>
          <Agents board={board} now={now} />
          <Incubations items={board.incubations} />
        </div>
        <Routes groups={board.lines} />
      </div>
    </>}
  </section>
}

function Tile({ value, label, tone }: { value: number; label: string; tone?: 'run' | 'ok' | 'bad' }) {
  return <div className={`rb-tile${tone && value ? ` rb-tile--${tone}` : ''}`}><b>{value}</b><span title={label}>{label}</span></div>
}

/** Long text shown as two lines; click or press Enter to read all of it. */
function Clamp({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setOpen(value => !value) } }
  return <p className="rb-clamp" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(value => !value)} onKeyDown={onKey}>{text}</p>
}

function Elbow() {
  return <svg className="rb-elbow" width="16" height="21" viewBox="0 0 16 21" aria-hidden><path d="M.75 0v11.5a8 8 0 0 0 8 8H16" /></svg>
}

function Agents({ board, now }: { board: Board; now: number }) {
  const groups = groupAgents(board.agents)
  const busy = new Set(groups.map(group => group.request_id))
  const idle = board.requests.filter(request => !busy.has(request.id))
  const running = board.agents.filter(agent => agent.status === 'running').length
  return <section className="rb-section" aria-label="智能体">
    <h3>智能体<span>{board.agents.length ? `${running} 个在跑 · ${board.agents.length - running} 个等待` : '空闲'}</span></h3>
    {!groups.length && <p className="rb-empty">现在没有子智能体在工作。在研究模式的会话里提出问题后，这里会显示总控派了谁、各自在做什么。</p>}
    <PixelOffice agents={board.agents} />
    {!!groups.length && <div>
      <div className="rb-hub"><b>总控</b><span>主会话 · 正在推进 {groups.length} 个请求</span></div>
      {groups.map(group => <div className="rb-request" key={group.request_id}>
        <Elbow />
        <div className="rb-request__head"><strong>{group.title}</strong></div>
        <ul>{group.agents.map(agent => <AgentRow key={agent.assignment_id} agent={agent} now={now} />)}</ul>
      </div>)}
    </div>}
    {!!idle.length && <details className="rb-more"><summary>另有 {idle.length} 个未结案的请求，目前没有派出子智能体</summary>
      <ul>{idle.map(request => <li key={request.id}><span>{request.title}</span><span className={`rb-chip rb-chip--${request.status}`}>{statusLabels[request.status]}</span><time>{ago(request.updated_at, now)}</time></li>)}</ul>
    </details>}
  </section>
}

function AgentRow({ agent, now }: { agent: BoardAgent; now: number }) {
  const running = agent.status === 'running'
  return <li className={`rb-agent rb-agent--${agent.status}`}>
    <Elbow /><span className="rb-node" aria-hidden />
    <div className="rb-agent__head">
      <b>{roleLabels[agent.role]}</b><span className={`rb-chip rb-chip--${agent.status}`}>{statusLabels[agent.status]}</span>
      <time title={running ? '已运行' : '最近更新'}>{running ? elapsed(agent.started_at ?? agent.updated_at, now) : ago(agent.updated_at, now)}</time>
    </div>
    {agent.candidate && <p className="rb-agent__what">{agent.candidate.title}</p>}
    <Clamp text={agent.instruction} />
    <div className="rb-tags">
      {agent.incubation && <span className="rb-tag" title={agent.incubation.title}>孵化第 {agent.incubation.round} 轮</span>}
      {agent.run && <span className={`rb-tag${agent.run.status === 'running' ? ' rb-tag--run' : ''}`} title={agent.run.id}>运行{runLabels[agent.run.status] ?? agent.run.status}{agent.run.scale_stage_id ? ` · ${agent.run.scale_stage_id}` : ''}</span>}
      {agent.sources !== undefined && <span className="rb-tag">已登记来源 {agent.sources}</span>}
      {agent.attempt > 1 && <span className="rb-tag">第 {agent.attempt} 次执行</span>}
      {agent.model && <span className="rb-tag" title={agent.model}>{agent.model}</span>}
    </div>
  </li>
}

function Incubations({ items }: { items: BoardIncubation[] }) {
  return <section className="rb-section" aria-label="孵化">
    <h3>孵化<span>结构性候选与对照的差距</span></h3>
    {!items.length && <p className="rb-empty">还没有立项孵化的结构性候选。总控立项后，这里按轮画出它与对照的差距，以及还剩多少轮次和成本。</p>}
    {items.map(item => <IncubationCard key={item.id} item={item} />)}
  </section>
}

function IncubationCard({ item }: { item: BoardIncubation }) {
  const chart = chartGeometry(item)
  const live = item.status === 'incubating'
  const measured = chart.slots.filter(slot => slot.state === 'measured')
  const latest = measured.at(-1)
  const last = item.rounds.at(-1)
  const used = item.rounds.length
  const costShare = Math.min(1, item.cost_used / item.max_total_cost_units)
  return <article className="rb-card">
    <div className="rb-card__head"><strong>{item.title}</strong><span className={`rb-chip rb-chip--${item.status}`}>{incubationLabels[item.status]}</span></div>
    <p className="rb-card__sub">{item.direction_title} · 指标 {item.metric}</p>
    <svg className="rb-chart" viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`各轮与对照的差距倍数${latest ? `，最近一轮 ${times(latest.ratio!)}` : '，还没有有效测量'}，毕业线 ${times(item.graduate_ratio)}`}>
      <rect className="rb-chart__zone" x={chart.left - 8} y={chart.graduateY} width={chart.right - chart.left + 16} height={Math.max(0, chart.baseline - chart.graduateY)} />
      <line className="rb-chart__axis" x1={chart.left - 8} x2={chart.right + 8} y1={chart.baseline} y2={chart.baseline} />
      <line className="rb-chart__grad" x1={chart.left - 8} x2={chart.right + 8} y1={chart.graduateY} y2={chart.graduateY} />
      <text x={chart.left - 12} y={chart.graduateY + 3} textAnchor="end" opacity=".75">{times(item.graduate_ratio)}</text>
      <text x={chart.right + 8} y={chart.graduateY - 4} textAnchor="end" opacity=".6">毕业线</text>
      {chart.top.y < chart.graduateY - 12 && <text x={chart.left - 12} y={chart.top.y + 3} textAnchor="end" opacity=".5">{times(chart.top.ratio)}</text>}
      {chart.path && <path className="rb-chart__path" d={chart.path} pathLength={1} />}
      {chart.slots.map(slot => <g key={slot.round}>
        {slot.state === 'open' && <circle className="rb-chart__slot" cx={slot.x} cy={chart.baseline} r="2.6" />}
        {slot.state === 'failed' && <path className="rb-chart__miss" d={`M${slot.x - 3} ${chart.baseline - 3}l6 6m0 -6l-6 6`}><title>第 {slot.round} 轮没有有效测量</title></path>}
        {slot.state === 'measured' && <circle className="rb-chart__dot" cx={slot.x} cy={slot.y} r="3"><title>第 {slot.round} 轮 {times(slot.ratio!)}</title></circle>}
        <text x={slot.x} y={chart.height - 5} textAnchor="middle" opacity=".5">{slot.round}</text>
      </g>)}
      {latest && live && <circle className="rb-chart__ping" cx={latest.x} cy={latest.y} r="7" />}
      {latest && <text x={Math.min(latest.x, chart.right - 8)} y={latest.y! - 8} textAnchor="middle" fontWeight="600">{times(latest.ratio!)}</text>}
    </svg>
    <div className="rb-gap">
      {item.ratio !== undefined ? <><b>{times(item.ratio)}</b><span>当前是对照的倍数 · 毕业线 {times(item.graduate_ratio)}{item.best_ratio !== undefined && item.best_ratio < item.ratio ? ` · 最好 ${times(item.best_ratio)}` : ''}</span></> : <span>还没有有效测量</span>}
    </div>
    <div className="rb-meters">
      <div className={`rb-meter${item.rounds_left <= 1 ? ' rb-meter--tight' : ''}`}><div><span>轮次</span><span>{used} / {item.max_rounds}</span></div><i><u style={{ width: `${Math.min(100, used / item.max_rounds * 100)}%` }} /></i></div>
      <div className={`rb-meter${costShare >= 0.8 ? ' rb-meter--tight' : ''}`}><div><span>累计成本</span><span>{Number(item.cost_used.toFixed(2))} / {item.max_total_cost_units}</span></div><i><u style={{ width: `${costShare * 100}%` }} /></i></div>
    </div>
    <dl className="rb-facts">
      <dt>判定</dt><dd>{decisionLabels[item.reason_code]}{item.window_closure !== undefined ? `（最近窗口缩小了剩余差距的 ${(item.window_closure * 100).toFixed(0)}%）` : ''}</dd>
      {last && <><dt>当前瓶颈</dt><dd>{last.bottleneck}</dd></>}
      {last?.next_change && <><dt>下一步改动</dt><dd>{last.next_change}</dd></>}
      {item.status_reason && <><dt>状态说明</dt><dd>{item.status_reason}</dd></>}
    </dl>
  </article>
}

function Routes({ groups }: { groups: BoardDirection[] }) {
  const [filter, setFilter] = useState<BoardOutcome | 'all'>('all')
  const totals = Object.fromEntries(OUTCOMES.map(outcome => [outcome, groups.reduce((sum, group) => sum + group.counts[outcome], 0)])) as Record<BoardOutcome, number>
  const all = OUTCOMES.reduce((sum, outcome) => sum + totals[outcome], 0)
  const shown = groups.filter(group => filter === 'all' || group.counts[filter] > 0)
  return <section className="rb-section" aria-label="路线">
    <h3>路线<span>试过的候选，采纳或放弃及原因</span></h3>
    {!all && <p className="rb-empty">还没有立过候选。侦察提出候选、执行验证之后，这里会留下每条路线的去向。</p>}
    {!!all && <div className="rb-filters" role="group" aria-label="按去向筛选">
      <button type="button" className="rb-filter" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>全部 {all}</button>
      {OUTCOMES.filter(outcome => totals[outcome] > 0).map(outcome => <button type="button" key={outcome} className="rb-filter" aria-pressed={filter === outcome} onClick={() => setFilter(outcome)}>{outcomeLabels[outcome]} {totals[outcome]}</button>)}
    </div>}
    {shown.map((group, index) => <RouteGroup key={group.direction_id ?? ''} group={group} filter={filter} open={index < 3} />)}
  </section>
}

function RouteGroup({ group, filter, open }: { group: BoardDirection; filter: BoardOutcome | 'all'; open: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const items = filter === 'all' ? group.items : group.items.filter(item => item.outcome === filter)
  const shown = expanded ? items : items.slice(0, COLLAPSED_LINES)
  return <details className="rb-route" open={open}>
    <summary>
      <div className="rb-route__title"><strong>{group.direction_title}</strong><span>{group.items.length} 条</span></div>
      <div className="rb-stack" aria-hidden>{OUTCOMES.filter(outcome => group.counts[outcome] > 0).map(outcome => <i key={outcome} className={`rb-c--${outcome}`} style={{ flexGrow: group.counts[outcome] }} />)}</div>
      <div className="rb-legend">{OUTCOMES.filter(outcome => group.counts[outcome] > 0).map(outcome => <span key={outcome} className={`rb-c--${outcome}`}>{outcomeLabels[outcome]} {group.counts[outcome]}</span>)}</div>
    </summary>
    <ol className="rb-lines">{shown.map(line => <RouteLine key={line.id} line={line} />)}</ol>
    {items.length > COLLAPSED_LINES && <button type="button" className="rb-showall" onClick={() => setExpanded(value => !value)}>{expanded ? '收起' : `展开其余 ${items.length - COLLAPSED_LINES} 条`}</button>}
  </details>
}

/** How a line leaves the trunk: adopted and active ones stay on it, the rest branch off and end. */
function Glyph({ outcome }: { outcome: BoardOutcome }) {
  return <svg className="rb-glyph" width="30" height="22" viewBox="0 0 30 22" aria-hidden>
    {outcome === 'adopted' && <><circle className="rb-fill" cx="9" cy="10" r="5.5" /><path d="M6.4 10.2l1.8 1.8 3.4-3.7" stroke="#fff" /></>}
    {outcome === 'active' && <><circle className="rb-fill" cx="9" cy="10" r="4.5" /><circle className="rb-ping" cx="9" cy="10" r="8" /></>}
    {outcome === 'abandoned' && <><circle className="rb-fill" cx="9" cy="1.5" r="1.8" /><path d="M9 1.5c0 6 4.5 8.5 12 8.5" /><path d="M21.5 6v8" strokeWidth="2.2" /></>}
    {outcome === 'undecided' && <><circle className="rb-fill" cx="9" cy="1.5" r="1.8" /><path d="M9 1.5c0 6 4 8.5 9.5 8.5" /><circle cx="21.8" cy="10" r="3.2" /></>}
    {outcome === 'pending' && <><path d="M9 1.5c0 6 4 8.5 9.5 8.5" strokeDasharray="2 3" /><circle cx="21.8" cy="10" r="3.2" strokeDasharray="2 2.2" /></>}
  </svg>
}

function RouteLine({ line }: { line: BoardLine }) {
  const meta = [
    line.kind === 'incubation' ? `孵化 ${line.runs} 轮` : `${line.runs} 次运行`,
    line.reason_source ? `原因来自${reasonSources[line.reason_source]}` : line.outcome === 'abandoned' || line.outcome === 'undecided' ? '没有记录原因' : undefined,
    line.updated_at.slice(0, 10),
  ].filter(Boolean).join(' · ')
  return <li className={`rb-line rb-line--${line.outcome} rb-c--${line.outcome}`}>
    <Glyph outcome={line.outcome} />
    <div className="rb-line__head"><strong>{line.title}</strong><span>{outcomeLabels[line.outcome]}</span></div>
    {line.reason && <Clamp text={line.reason} />}
    <p className="rb-line__meta" title={line.record_id}>{meta}</p>
  </li>
}
