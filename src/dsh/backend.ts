import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'

export interface DispatchBackend extends Pick<SubagentRuntime, 'startActivation' | 'sendMessage' | 'interrupt'> {
  hasChild(parent: SessionId, child: SessionId, signal: AbortSignal): Promise<boolean>
  stopChild(parent: Agent, child: SessionId): Promise<void>
}

/** Keep request-local cancellation separate from DSH's whole-tree shutdown. */
export function createDispatchBackend(ctx: Context): DispatchBackend {
  return {
    startActivation: ctx.subagents.startActivation.bind(ctx.subagents),
    sendMessage: ctx.subagents.sendMessage.bind(ctx.subagents),
    interrupt: ctx.subagents.interrupt.bind(ctx.subagents),
    async hasChild(parent, child, signal) {
      const rows = await ctx.subagents.listDescendants(parent, signal)
      if (rows.some(row => row.kind === 'child' && row.id === child)) return true
      if (rows.some(row => row.kind === 'diagnostic')) {
        throw new Error('DSH child history is unavailable; cannot safely start a replacement')
      }
      return false
    },
    async stopChild(parent, child) {
      const resident = ctx.agents.get(child)
      ctx.subagents.interrupt(child, { kind: 'ancestor', agent: parent })
      // Interrupt is fire-and-return. Wait before closing the shared fact store.
      await resident?.whenIdle()
    },
  }
}
