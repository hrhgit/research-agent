import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { SessionId } from '@deepseek-ai/dsh-session'

const selection = { provider: 'magpie-responses', model: 'codex/gpt-6-luna' }
const citation = { type: 'url_citation', url: 'https://www.iana.org/help/example-domains', title: 'Example Domains' }

export async function checkNativeModelSearch(ctx, cwd) {
  assert.deepEqual(ctx.web.listProviders().search.map(item => item.id), ['model-native'])
  assert.ok(ctx.web.listProviders().fetch.some(item => item.id === 'http'))
  const requests = []
  const gateway = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'response.web_search_call.completed' },
      { type: 'response.output_text.annotation.added', annotation: citation },
      { type: 'response.completed', response: { status: 'completed', output: [] } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve))
  const keyRef = 'DSH_NATIVE_SEARCH_FIXTURE_KEY'
  try {
    const llm = ctx.configEditor.entries().find(entry => entry.options.id === 'llm-pi-ai')
    assert.ok(llm)
    await ctx.configEditor.edit(llm, current => ({ ...current, providers: { ...current.providers, [selection.provider]: {
      api: 'openai-responses',
      baseURL: `http://127.0.0.1:${gateway.address().port}/v1`,
      apiKeyEnv: keyRef,
      models: [{ id: selection.model, name: 'Native search fixture', contextWindow: 8192, maxTokens: 1024 }],
    } } }))
    const request = ctx.research.submitRequest({ title: 'Native search provenance', message: 'Probe source capture', session_id: 'native-search-parent' })
    ctx.research.claimRequest(request.id)
    ctx.research.acceptRequest(request.id, {})
    const assignment = ctx.research.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Save an actual tool source.' })

    const signal = new AbortController().signal
    for (const preset of ['standard', 'research-scout']) {
      const scout = preset === 'research-scout'
      const handle = await ctx.agents.create({
        sessionId: SessionId(`native-search-${preset}`),
        meta: { agentPreset: preset, cwd, ...(scout ? { origin: 'subagent', parentSession: SessionId('native-search-parent') } : {}) },
        agentOptions: selection,
        setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
      })
      const { agent } = handle
      try {
        if (scout) ctx.research.store.startAssignment(assignment.id, agent.id)
        agent.session.append('request/context', selection)
        if (!scout) {
          assert.equal(await ctx.agents.withInitiator(agent, () => ctx.web.searchReady(selection.provider)), false)
          await ctx.credentials.set(keyRef, 'local-search-fixture')
          assert.equal(await ctx.agents.withInitiator(agent, () => ctx.web.searchReady(selection.provider)), true)
          assert.equal(await ctx.agents.withInitiator(agent, () => ctx.web.searchReady('deepseek-official')), false)
          const unsupported = { ...selection, model: 'yuyu/grok-4.6' }
          agent.model.select(unsupported)
          const unsupportedTools = await ctx.agents.withInitiator(agent, () => ctx.tools.resolve({ agent, modelSelection: unsupported, signal }))
          try {
            const offered = ctx.tools.schemas(agent, unsupportedTools).map(tool => tool.name)
            assert.equal(offered.includes('web_search'), false)
            assert.ok(offered.includes('web_fetch'))
          } finally { unsupportedTools.dispose() }
          agent.model.select(selection)
        }
        const toolSet = await ctx.agents.withInitiator(agent, () => ctx.tools.resolve({ agent, modelSelection: selection, signal }))
        try {
          const invoke = async (name, parameters) => {
            const batch = await ctx.agents.withInitiator(agent, () => ctx.tools.execute({
              agent, toolSet, signal,
              calls: [{ type: 'tool-call', id: `native-fixture-${name}`, name, arguments: JSON.stringify(parameters) }],
            }))
            const result = batch.results[0].result
            assert.equal(result.isError, false, JSON.stringify(result.content))
            return result.content[0].text
          }
          const offered = ctx.tools.schemas(agent, toolSet).map(tool => tool.name)
          assert.ok(offered.includes('web_search') && offered.includes('web_fetch'))
          const query = 'Official IANA page for example domains'
          const search = await invoke('web_search', { queries: [query] })
          assert.ok(search.includes(citation.url))
          if (scout) {
            await invoke('research_source_capture', {
              assignment_id: assignment.id, query, url: citation.url, title: citation.title,
              source_type: 'search_result', provider: 'model-native', claim: 'IANA documents reserved example domains.',
              applicability: 'Public examples only', limitations: 'No measurement from this lookup',
              mechanism_hypothesis: 'Examples need no live service', minimal_experiment: { sample: 'example.com' },
              pass_gate: 'IANA lists the name', stop_gate: 'The source is unavailable',
            })
          }
        } finally { toolSet.dispose() }
      } finally { await handle.dispose() }
    }
    assert.deepEqual(ctx.research.store.listSources({ assignment_id: assignment.id }).map(source => source.url), [citation.url])
    assert.equal(requests.length, 2)
    for (const query of requests) {
      assert.equal(query.url, '/v1/responses')
      assert.equal(query.authorization, 'Bearer local-search-fixture')
      assert.equal(query.body.model, selection.model)
      assert.deepEqual(query.body.tools, [{ type: 'web_search' }])
    }
  } finally {
    gateway.closeAllConnections()
    await new Promise(resolve => gateway.close(resolve))
  }
}
