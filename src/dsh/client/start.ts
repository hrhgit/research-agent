/** Agent preset id of the main research mode. */
export const RESEARCH_PRESET = 'research'

/** Draft placed in a new research session when the user starts without a specific question. */
export const DEFAULT_START_PROMPT = '启动研究。先用 research_state 查看当前方向、进行中的孵化、未结案的请求和派工：有没做完的就接着做，优先进行中的孵化和等待继续的请求；都没有，就按各方向的目标和最近的记录选一项最值得做的下一步，说明依据后直接开始。只有需要我决定的事才停下来问我。'

/** The part of DSH's Workspace service this panel uses. */
export interface SessionStarter {
  startSession(workspaceId: undefined, options: { agentPreset: string; prompt: string; whenDraftExists: 'replace' }): void
}

/**
 * Opens a blank session in research mode with the preset prompt as its draft.
 * The user sends it; nothing reaches a model from here.
 * @returns false when this DSH build offers no session navigation.
 */
export function startResearch(starter: SessionStarter | undefined, prompt?: string): boolean {
  if (typeof starter?.startSession !== 'function') return false
  starter.startSession(undefined, { agentPreset: RESEARCH_PRESET, prompt: prompt?.trim() || DEFAULT_START_PROMPT, whenDraftExists: 'replace' })
  return true
}
