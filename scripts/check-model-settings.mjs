import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import { registerResearchHttp } from '../src/dsh/http.ts'

export class SettingsFixtureModel extends LlmAdapter {
  async listModels(provider) { return [{ provider, id: 'reasoning', name: 'Reasoning model' }, { provider, id: 'plain', name: 'Plain model' }] }
  async resolveModel(provider, model) {
    if (!['reasoning', 'plain'].includes(model)) throw new Error('Unknown fixture model')
    return { provider, id: model, name: model, ...(model === 'reasoning' ? { reasoning: { efforts: ['low', 'high'].map(id => ({ id: ReasoningEffortId(id), name: id })), defaultEffort: ReasoningEffortId('low') } } : {}) }
  }
  async *stream() { throw new Error('Settings validation must not send model requests') }
}

export async function checkModelSettings(ctx) {
  const research = ctx.research
  const dispatcher = research.dispatcher
  const settings = research.modelSettings
  assert.equal(settings.snapshot().editable, true)
  ctx.llm.registerAdapter(['settings-fixture'], new SettingsFixtureModel())
  const request = research.submitRequest({ title: 'Keep active work', message: 'No model call', session_id: 'settings-parent' })
  research.claimRequest(request.id); research.acceptRequest(request.id, {})
  const work = research.createAssignment({ request_id: request.id, role: 'scout', instruction: 'Keep running' })
  research.store.startAssignment(work.id, 'settings-child', { provider: 'settings-fixture', model: 'plain' })
  const beforeWork = research.store.getAssignment(work.id)
  const server = createServer()
  registerResearchHttp({ register(route) { server.on('request', route.handler); return () => {} } }, research,
    req => req.headers['x-settings-test'] === 'yes' ? undefined : 401)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/research/api`
  const call = (path, body) => fetch(`${base}/${path}`, { method: body === undefined ? 'GET' : 'PUT', headers: { 'x-settings-test': 'yes', 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const signal = new AbortController().signal
  const scout = { provider: 'settings-fixture', model: 'reasoning', reasoning_effort: 'high' }
  const runner = { provider: 'settings-fixture', model: 'plain' }
  try {
    assert.equal((await fetch(`${base}/model-defaults`, { method: 'PUT', body: '{}' })).status, 401)
    const catalog = await (await call('models?provider=settings-fixture')).json()
    assert.equal(catalog.length, 2)
    assert.equal((await (await call('models?provider=settings-fixture&model=plain')).json()).reasoning, null)
    const saved = await call('model-defaults', { scout })
    assert.equal(saved.status, 200, await saved.text())
    assert.equal(ctx.research, research, 'Saving volatile settings must not restart the research host')
    assert.equal(ctx.research.dispatcher, dispatcher)
    assert.deepEqual(research.store.getAssignment(work.id), beforeWork, 'Running child identity and model must stay unchanged')
    assert.deepEqual(dispatcher.listModelDefaults(), { scout })

    const beforeFile = await readFile(ctx.configEditor.documentPath, 'utf8')
    for (const invalid of [{ scout: { ...scout, reasoning_effort: 'unsupported' } }, { scout: { ...scout, model: 'missing' } }, { runner: {}, scout }, { fake: runner }]) {
      assert.equal((await call('model-defaults', invalid)).status, 400)
      assert.equal(await readFile(ctx.configEditor.documentPath, 'utf8'), beforeFile, 'Invalid settings must not be persisted')
    }
    await Promise.all([settings.save({ runner }, signal), settings.save({ auditor: scout }, signal)])
    assert.deepEqual(dispatcher.listModelDefaults(), { scout, runner, auditor: scout }, 'Concurrent role changes must merge')

    const parent = { session: { id: 'settings-parent', header: { origin: 'user' } } }
    const scope = createScope(ctx, parent)
    try {
      await ctx.agentPresets.mount(scope.ctx, 'research')
      const definition = ctx.tools.get('research_model_defaults', parent)
      const result = await definition.execute({ changes: { auditor: null } }, { agent: parent, signal })
      assert.deepEqual(result, { scout, runner })
    } finally { await scope.dispose() }
    const updated = await (await call('model-defaults')).json()
    assert.deepEqual(updated.defaults, { scout, runner })
    assert.equal(ctx.research, research)
    assert.deepEqual(research.store.getAssignment(work.id), beforeWork)
    return { scout, runner }
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}
