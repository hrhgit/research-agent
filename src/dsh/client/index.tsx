import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ResearchPanel } from './ResearchPanel.tsx'
import { ResearchBoard } from './ResearchBoard.tsx'
import { useSyncExternalStore } from 'react'
import { modelZh, modelEn } from './model-copy.ts'
import { startResearch, type SessionStarter } from './start.ts'

type ClientContext = Context
const PANEL_ID = 'dsh-research-agent' as MainPanelId
const BOARD_ID = 'dsh-research-agent/board'

/** The parts of DSH's right sidebar this plugin uses; the sidebar package is not a direct dependency. */
interface BoardTabProps { useTabInfo(): { tab: { visible: boolean } } }
interface SidebarRightTabs {
  register(definition: {
    id: string; kind: string; title: () => string
    guide: Array<{ id: string; order: number; title: () => string; description: () => string; icon: typeof FlaskIcon }>
  }): () => void
}
interface TabSlots {
  inject(name: string, register: () => () => void): () => void
  register(slot: { name: string; key: string }, component: (props: BoardTabProps) => unknown): () => void
}
interface SidebarScope { sidebarRightTabs: SidebarRightTabs; slots: TabSlots; effect(run: () => () => void, label?: string): void }

function BoardTab({ useTabInfo }: BoardTabProps) {
  return <ResearchBoard visible={useTabInfo().tab.visible} />
}

function FlaskIcon({ size }: SidebarPanelIconOwnerProps) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9 3h6M10 3v6.2L4.8 18a2 2 0 0 0 1.7 3h11a2 2 0 0 0 1.7-3L14 9.2V3" />
    <path d="M7.2 16h9.6M8.5 13.5h7" />
  </svg>
}

export const inject = ['slots', 'locale']

/** Register the research panel in DSH's shared main and sidebar slots. */
export function apply(ctx: ClientContext): void {
  ctx.locale.register('research.models', { zh: modelZh, en: modelEn })
  const translate = ctx.locale.bind('research.models')
  // The Workspace service is read when clicked, so the panel still loads in a DSH build without it.
  const start = (prompt?: string) => startResearch((ctx as unknown as { get(name: string): unknown }).get('uiWorkspace') as SessionStarter | undefined, prompt)
  function LocalizedResearchPanel() {
    useSyncExternalStore(callback => ctx.locale.subscribe(callback), () => ctx.locale.getSnapshot())
    return <ResearchPanel modelText={translate} onStart={start} />
  }
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, LocalizedResearchPanel))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: '研究' }, FlaskIcon))
  // The status board is a page in the right sidebar of any session; a DSH build without that sidebar simply has no such page.
  ;(ctx as unknown as { inject(services: string[], run: (scope: SidebarScope) => void): void }).inject(['sidebarRightTabs'], scope => {
    scope.effect(() => scope.sidebarRightTabs.register({
      id: BOARD_ID, kind: 'research-board', title: () => '研究状态',
      guide: [{ id: 'board', order: 60, title: () => '研究状态', description: () => '谁在工作、孵化进展、采纳和放弃的路线', icon: FlaskIcon }],
    }), 'research-agent: board type')
    scope.effect(() => scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({ name: 'sidebar.right.pane.tab', key: BOARD_ID }, BoardTab)), 'research-agent: board body')
  })
}
