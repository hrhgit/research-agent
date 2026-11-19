import { HarnessError } from '@deepseek-ai/dsh-llm'

function searchError(message) {
  return new HarnessError(message, 'WEB_PROVIDER_ERROR')
}

async function* streamEvents(body) {
  let pending = ''
  let data = []
  for await (const chunk of body.pipeThrough(new TextDecoderStream())) {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop()
    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '')
      if (line.startsWith('data:')) {
        data.push(line.slice(5).replace(/^ /, ''))
      } else if (line === '' && data.length) {
        const payload = data.join('\n')
        data = []
        if (payload !== '[DONE]') yield JSON.parse(payload)
      }
    }
  }
}

export async function readSearchSources(response) {
  const sources = new Map()
  const cited = new Set()
  let searched = false

  function addSource(source) {
    if (typeof source?.url !== 'string') return
    const url = URL.parse(source.url)
    if (!url || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    const title = typeof source.title === 'string' ? source.title.trim() : ''
    if (!sources.has(url.href) || (title && !sources.get(url.href).title)) {
      sources.set(url.href, title ? { url: url.href, title } : { url: url.href })
    }
    return url.href
  }

  function addCitation(annotation) {
    if (annotation?.type !== 'url_citation') return
    const url = addSource(annotation)
    if (url) cited.add(url)
  }

  function addItem(item) {
    if (item?.type === 'web_search_call' && item.status === 'completed') {
      searched = true
      for (const source of item.action?.sources ?? []) addSource(source)
    }
    if (item?.type === 'message') {
      for (const part of item.content ?? []) {
        for (const annotation of part.annotations ?? []) addCitation(annotation)
      }
    }
  }

  function complete(result) {
    if (result?.status && result.status !== 'completed') throw searchError('Native web search did not complete')
    for (const item of result?.output ?? []) addItem(item)
    if (!searched) throw searchError('The model did not execute its built-in web search')
    if (!sources.size) throw searchError('The model returned no verifiable search links')
    return {
      sources: [...cited].map(url => sources.get(url)).concat([...sources.values()].filter(source => !cited.has(source.url))),
      truncated: false,
    }
  }

  if (response.headers.get('content-type')?.includes('application/json')) return complete(await response.json())
  if (!response.body) throw searchError('Native web search returned an empty response')
  for await (const event of streamEvents(response.body)) {
    switch (event.type) {
      case 'response.output_item.done':
        addItem(event.item)
        break
      case 'response.output_text.annotation.added':
        addCitation(event.annotation)
        break
      case 'response.web_search_call.completed':
        searched = true
        break
      case 'response.completed':
        return complete(event.response)
      case 'response.failed':
      case 'response.incomplete':
      case 'error':
        throw searchError('The model provider could not complete native web search')
    }
  }
  throw searchError('The model ended the search response before completing it')
}

export async function searchResponses(route, key, model, query, signal) {
  const headers = new Headers(route.headers)
  headers.set('authorization', `Bearer ${key}`)
  headers.set('content-type', 'application/json')
  headers.set('accept', 'text/event-stream')
  const response = await fetch(route.endpoint, {
    method: 'POST',
    headers,
    redirect: 'error',
    signal,
    body: JSON.stringify({
      model,
      instructions: 'Search the public web using the input as a query. Cite the sources you used.',
      input: query,
      tools: [{ type: 'web_search' }],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      stream: true,
      store: false,
    }),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw searchError(`The selected model provider rejected native web search (HTTP ${response.status})`)
  }
  return readSearchSources(response)
}
