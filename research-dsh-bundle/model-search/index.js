import { HarnessError } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { searchResponses } from './responses.js'

export const name = 'dsh-model-native-search'
export const inject = ['web', 'agents', 'llm', 'configEditor', 'credentials']
export const Config = z.object({
  providers: z.dict(z.array(z.string().required())).default({})
    .description('Model IDs with native web search, listed by Responses provider'),
})

function configuredRoute(ctx, providers, selection) {
  if (!selection || !providers.get(selection.provider)?.has(selection.model)) return
  const route = ctx.llm.listConfigurableProviders().find(item => item.provider === selection.provider && !item.error)
  const entry = ctx.configEditor.entries().find(item => item.options.id === route?.settingsNs)
  if (!route || !entry?.fiber || entry.options.name !== '@deepseek-ai/dsh-llm-pi-ai') return

  // Use the same active route, endpoint and credential reference as model settings.
  const profile = route.settingsPath.reduce((value, key) => value?.[key], entry.options.config)
  if (profile?.api !== 'openai-responses' || typeof profile.baseURL !== 'string'
    || typeof profile.apiKeyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(profile.apiKeyEnv)) return
  const endpoint = URL.parse(profile.baseURL)
  if (!endpoint || !['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) return
  endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/responses'
  return { endpoint, keyRef: profile.apiKeyEnv, headers: profile.headers }
}

export function apply(ctx, config) {
  const providers = new Map(Object.entries(config.providers).map(([id, models]) => [id, new Set(models)]))
  ctx.web.registerSearchProvider({
    id: 'model-native',
    title: '模型内置搜索',
    description: {
      en: 'Search with the session’s selected model when its route supports built-in search.',
      zh: '由当前模型执行网页搜索。支持内置搜索的已接入模型会显示该工具。',
    },
    available: () => true,
    async ready(provider) {
      const selection = ctx.agents.currentInitiator()?.model.current()
      if (selection?.provider !== provider) return false
      const route = configuredRoute(ctx, providers, selection)
      if (!route) return false
      try { return (await ctx.credentials.describe(route.keyRef)).configured }
      catch { return false }
    },
    async search(request, signal) {
      signal?.throwIfAborted()
      const selection = ctx.agents.currentInitiator()?.session.requestContext()
      const route = configuredRoute(ctx, providers, selection)
      if (!route || !selection?.model) {
        throw new HarnessError('Native web search needs a model on a configured Responses route', 'WEB_PROVIDER_UNAVAILABLE')
      }
      const key = (await ctx.credentials.resolve(route.keyRef))?.value.trim()
      if (!key) throw new HarnessError('The selected model route has no API credential for search', 'WEB_PROVIDER_CREDENTIAL_MISSING')
      return searchResponses(route, key, selection.model, request.query, signal)
    },
  })
}
