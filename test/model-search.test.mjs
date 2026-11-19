import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../research-dsh-bundle/model-search/index.js'
import { readSearchSources } from '../research-dsh-bundle/model-search/responses.js'

const citation = { type: 'url_citation', url: 'https://www.iana.org/help/example-domains', title: 'Example Domains' }
const found = { type: 'url', url: 'https://www.iana.org/domains/reserved' }
const nativeCall = { type: 'web_search_call', status: 'completed', action: { type: 'search', sources: [found] } }

function eventResponse(events) {
  const stream = new TextEncoder().encode(events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''))
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(stream.slice(0, 15))
      controller.enqueue(stream.slice(15))
      controller.close()
    },
  }), { headers: { 'content-type': 'text/event-stream' } })
}

test('native search collects streamed citations when the completed response has an empty output', async () => {
  const response = eventResponse([
    { type: 'response.output_item.done', item: nativeCall },
    { type: 'response.output_text.annotation.added', annotation: citation },
    { type: 'response.output_text.annotation.added', annotation: citation },
    { type: 'response.output_text.annotation.added', annotation: { ...citation, url: 'file:///bad' } },
    { type: 'response.completed', response: { status: 'completed', output: [] } },
  ])
  assert.deepEqual(await readSearchSources(response), {
    sources: [{ url: citation.url, title: citation.title }, { url: found.url }],
    truncated: false,
  })
})

test('native search reads structured citations in a complete JSON result', async () => {
  const response = Response.json({ status: 'completed', output: [
    nativeCall,
    { type: 'message', content: [{ type: 'output_text', annotations: [citation], text: 'Example domain documentation' }] },
  ] })
  assert.deepEqual((await readSearchSources(response)).sources.map(source => source.url), [citation.url, found.url])
})

test('native search rejects unexecuted, incomplete and uncited answers', async () => {
  await assert.rejects(readSearchSources(eventResponse([
    { type: 'response.output_text.annotation.added', annotation: citation },
    { type: 'response.completed' },
  ])), /did not execute/)
  await assert.rejects(readSearchSources(eventResponse([
    { type: 'response.output_item.done', item: nativeCall },
  ])), /before completing/)
  await assert.rejects(readSearchSources(eventResponse([
    { type: 'response.web_search_call.completed' },
    { type: 'response.output_text.done', text: 'See https://example.net/guessed' },
    { type: 'response.completed' },
  ])), /no verifiable search links/)
})

test('native search reuses the selected model route and never calls another backend', async t => {
  let selection = { provider: 'magpie-responses', model: 'codex/gpt-6-luna' }
  let key = 'test-credential'
  const entry = {
    fiber: {},
    options: {
      id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers: { 'magpie-responses': {
        api: 'openai-responses', baseURL: 'http://127.0.0.1:8080/v1/', apiKeyEnv: 'TEST_NATIVE_SEARCH',
      } } },
    },
  }
  let provider
  const ctx = {
    web: { registerSearchProvider: value => { provider = value } },
    agents: { currentInitiator: () => ({ session: { requestContext: () => selection }, model: { current: () => selection } }) },
    llm: { listConfigurableProviders: () => [{ provider: 'magpie-responses', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'magpie-responses'] }] },
    configEditor: { entries: () => [entry] },
    credentials: {
      describe: async () => ({ configured: !!key }),
      resolve: async () => key ? { value: key } : undefined,
    },
  }
  const requests = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url: url.href, options, request: JSON.parse(options.body) })
    return eventResponse([
      { type: 'response.web_search_call.completed' },
      { type: 'response.output_text.annotation.added', annotation: citation },
      { type: 'response.completed' },
    ])
  })
  apply(ctx, { providers: { 'magpie-responses': ['codex/gpt-6-luna', 'codex/gpt-6.2-sol'] } })
  assert.equal(await provider.ready('magpie-responses'), true)
  const { signal } = new AbortController()
  const query = { query: 'IANA example domain documentation' }
  assert.equal((await provider.search(query, signal)).sources[0].url, citation.url)
  assert.equal(requests[0].url, 'http://127.0.0.1:8080/v1/responses')
  assert.equal(requests[0].options.signal, signal)
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(requests[0].request.tools, [{ type: 'web_search' }])
  assert.equal(requests[0].request.model, selection.model)
  assert.equal(requests[0].request.input, query.query)
  assert.equal(requests[0].request.store, false)
  assert.equal(requests[0].options.headers.get('authorization'), 'Bearer test-credential')

  selection = { ...selection, model: 'codex/gpt-6.2-sol' }
  entry.options.config.providers['magpie-responses'].baseURL = 'http://127.0.0.1:8081/v1'
  key = 'rotated-test-credential'
  await provider.search(query, signal)
  assert.equal(requests[1].request.model, selection.model)
  assert.equal(requests[1].url, 'http://127.0.0.1:8081/v1/responses')
  assert.equal(requests[1].options.headers.get('authorization'), 'Bearer rotated-test-credential')

  key = ''
  assert.equal(await provider.ready(selection.provider), false)
  await assert.rejects(provider.search(query, signal), /no API credential/)
  key = 'test-credential'
  selection = { provider: 'magpie-responses', model: 'yuyu/grok-4.6' }
  assert.equal(await provider.ready(selection.provider), false)
  await assert.rejects(provider.search(query, signal), /configured Responses route/)
  selection = { provider: 'deepseek-official', model: 'other' }
  assert.equal(await provider.ready(selection.provider), false)
  await assert.rejects(provider.search(query, signal), /configured Responses route/)
  assert.equal(requests.length, 2)
})
