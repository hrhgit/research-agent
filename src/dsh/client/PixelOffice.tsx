import { memo, type CSSProperties } from 'react'
import type { BoardAgent } from '../board.ts'
import { HUB_CHARACTER, officeDesks, roleLabels, statusLabels } from './board-view.ts'
import { pixelSprites } from './pixel-sprites.ts'

/**
 * Styles for the pixel office. `--u` is the screen size of one sprite pixel, so every measure
 * below is in sprite pixels and the art always scales by a whole number. The table is drawn as a
 * nine-slice border image so a desk can be as wide as its cell without stretching its edges.
 */
export const officeStyles = `
.rb-office{--u:2px;display:grid;grid-template-columns:repeat(auto-fill,minmax(calc(48*var(--u)),1fr));align-items:end;gap:10px 14px;margin:2px 0 14px;padding:10px 14px 8px;border:1px solid var(--rb-rule);border-radius:8px;background:linear-gradient(var(--rb-soft) var(--u),transparent 0) 0 0/calc(16*var(--u)) calc(16*var(--u)),linear-gradient(90deg,var(--rb-soft) var(--u),transparent 0) 0 0/calc(16*var(--u)) calc(16*var(--u)),var(--rb-soft)}
.rb-desk{min-width:0;display:flex;flex-direction:column;align-items:center;gap:4px;animation:rb-enter .35s ease-out both}
.rb-say{position:relative;align-self:stretch;margin-bottom:calc(2*var(--u));padding:3px 5px;border:var(--u) solid #3b3b4f;background:#fff;color:#2b2b3a;font-size:10.5px;line-height:1.35;overflow-wrap:anywhere}
.rb-say span{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.rb-say b{font-weight:600;margin-right:4px}
.rb-say::after{content:"";position:absolute;left:calc(50% + 6*var(--u));bottom:calc(-3*var(--u));width:calc(2*var(--u));height:calc(2*var(--u));background:#fff;border:solid #3b3b4f;border-width:0 var(--u) var(--u) var(--u);box-sizing:content-box}
.rb-desk--running .rb-say,.rb-desk--running .rb-say::after{border-color:#2f5fb8}
.rb-desk--waiting .rb-say,.rb-desk--waiting .rb-say::after{border-color:#a26a0c}.rb-desk--waiting .rb-say b{color:#a26a0c}
.rb-desk--queued .rb-say{color:#6b6b78}.rb-desk--queued .rb-say,.rb-desk--queued .rb-say::after{border-color:#8a8a96}
.rb-desk--hub .rb-say::after{left:calc(50% - var(--u))}
.rb-desk__scene{position:relative;align-self:stretch;height:calc(60*var(--u))}
.rb-px{position:absolute;background-repeat:no-repeat;background-size:100% 100%;image-rendering:pixelated}
.rb-px--table{left:0;right:0;top:calc(20*var(--u));height:calc(40*var(--u));border-style:solid;border-color:transparent;border-width:calc(13*var(--u)) calc(3*var(--u)) calc(8*var(--u));border-image:url(${pixelSprites.table}) 13 3 8 fill stretch;z-index:2}
.rb-px--computer{left:calc(50% - 16*var(--u));top:calc(5*var(--u));width:calc(16*var(--u));height:calc(32*var(--u));background-image:url(${pixelSprites.computer});z-index:3}
.rb-px--whiteboard{left:calc(50% - 16*var(--u));top:calc(4*var(--u));width:calc(32*var(--u));height:calc(32*var(--u));background-image:url(${pixelSprites.whiteboard})}
.rb-px--who{left:calc(50% - var(--u));top:0;width:calc(16*var(--u));height:calc(32*var(--u));background-image:url(${pixelSprites.people});background-size:calc(112*var(--u)) calc(192*var(--u));background-position-x:calc(-16*var(--u));background-position-y:calc(-32*var(--u)*var(--who,0));z-index:1}
.rb-desk--type .rb-px--who{background-position-x:calc(-48*var(--u));animation:rb-px-type .6s step-end infinite;animation-delay:calc(var(--i,0)*-.23s)}
.rb-desk--read .rb-px--who{background-position-x:calc(-80*var(--u));animation:rb-px-read 1.1s step-end infinite;animation-delay:calc(var(--i,0)*-.23s)}
.rb-desk--hub .rb-px--who{left:calc(50% - 8*var(--u));top:calc(22*var(--u));z-index:4}
.rb-desk--queued .rb-px--who{opacity:.5;filter:grayscale(1)}
.rb-desk--queued .rb-px--computer{opacity:.6}
.rb-desk__topic{position:absolute;left:calc(4*var(--u));right:calc(4*var(--u));top:calc(38*var(--u));max-height:calc(12*var(--u));z-index:4;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;text-align:center;font-size:calc(4px + 3*var(--u));line-height:calc(6*var(--u));font-weight:600;color:#4a2a36}
.rb-desk__label{display:flex;align-items:center;gap:4px;font-size:11px;line-height:1.3;color:var(--rb-dim);white-space:nowrap}
.rb-desk__label i{width:6px;height:6px;border-radius:50%;background:var(--rb-dim)}
.rb-desk--running .rb-desk__label{color:inherit}.rb-desk--running .rb-desk__label i{background:var(--rb-run)}.rb-desk--waiting .rb-desk__label i{background:var(--rb-warn)}
.rb-desk--more{align-self:center;font-size:12px;color:var(--rb-dim)}
@container (min-width:820px){.rb-office{--u:3px;gap:12px 20px}.rb-say{font-size:12px}}
@keyframes rb-px-type{0%{background-position-x:calc(-48*var(--u))}50%,100%{background-position-x:calc(-64*var(--u))}}
@keyframes rb-px-read{0%{background-position-x:calc(-80*var(--u))}50%,100%{background-position-x:calc(-96*var(--u))}}
`

const who = (character: number, index: number) => ({ '--who': character, '--i': index }) as CSSProperties

/**
 * The open agents as a small pixel office: the controller at the whiteboard and one desk per agent.
 * A running agent types or reads; a waiting or queued one sits still. The bubble over each says what
 * it is working on and the desk carries the direction that work advances.
 * It repeats what the rows below say, so it is hidden from assistive technology.
 */
export const PixelOffice = memo(function PixelOffice({ agents }: { agents: BoardAgent[] }) {
  if (!agents.length) return null
  const { desks, hidden } = officeDesks(agents)
  const running = agents.filter(agent => agent.status === 'running').length
  const requests = new Set(agents.map(agent => agent.request_id)).size
  return <div className="rb-office" aria-hidden="true">
    <div className={`rb-desk rb-desk--hub rb-desk--running${running ? ' rb-desk--read' : ''}`} title="总控：主会话，负责派工和确认结论">
      <div className="rb-say"><span>{running ? `盯着 ${requests} 个请求，${running} 个在跑` : `${requests} 个请求在等下一步`}</span></div>
      <div className="rb-desk__scene"><i className="rb-px rb-px--whiteboard" /><i className="rb-px rb-px--who" style={who(HUB_CHARACTER, 0)} /></div>
      <span className="rb-desk__label">总控</span>
    </div>
    {desks.map((desk, index) => <div key={desk.id} className={`rb-desk rb-desk--${desk.state} rb-desk--${desk.pose}`} title={desk.title}>
      <div className="rb-say"><span>{desk.state !== 'running' && <b>{statusLabels[desk.state]}</b>}{desk.work}</span></div>
      <div className="rb-desk__scene">
        <i className="rb-px rb-px--who" style={who(desk.character, index + 1)} />
        <i className="rb-px rb-px--table" /><i className="rb-px rb-px--computer" />
        <span className="rb-desk__topic">{desk.direction}</span>
      </div>
      <span className="rb-desk__label"><i />{roleLabels[desk.role] ?? desk.role}</span>
    </div>)}
    {hidden > 0 && <div className="rb-desk rb-desk--more" title={`另有 ${hidden} 个子智能体，见下方列表`}>+{hidden}</div>}
  </div>
})
