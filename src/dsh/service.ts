import type { ResearchApi } from './api.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** One shared fact store owned by the host, independent of session modes. */
    research: ResearchApi
  }
}
