import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkModelSettings, SettingsFixtureModel } from './check-model-settings.mjs'
import { checkNativeModelSearch } from './check-native-model-search.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const require = createRequire(resolve(projectRoot, 'package.json'))
const cli = resolve(require.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')
const installed = createRequire(require.resolve('@deepseek-ai/dsh/package.json'))
const home = await mkdtemp(join(tmpdir(), 'research-dsh-profile-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = home
const originalLog = console.log
// The temporary Web app's connection URL is unnecessary for these checks.
console.log = (...args) => {
  if (!String(args[0]).startsWith('dsh web:')) originalLog(...args)
}
let shutdown

async function command(args) {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: projectRoot, env: process.env, stdio: ['ignore', 'ignore', 'pipe'],
    })
    let errors = ''
    child.stderr.on('data', chunk => { errors += chunk })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? done() : reject(new Error(`DSH ${args[0]} failed (${code}): ${errors}`)))
  })
}

try {
  await command(['--profile', 'validation', '--from-default-profile', 'web', '--dump-config'])
  await command(['plugin', '--profile', 'validation', 'add', projectRoot, '--ignore-scripts'])
  await command(['plugin', '--profile', 'validation', 'add', join(projectRoot, 'research-dsh-bundle', 'model-search'), '--ignore-scripts'])
  // Seed the owned test profile before boot. A command-line overlay intentionally
  // prevents ConfigEditor writes, so it cannot exercise the panel's save path.
  const profilePatch = join(home, 'profiles', 'validation', 'cordis.patch.yml')
  const initial = await readFile(profilePatch, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  await writeFile(profilePatch, initial.replace(/^\[\][ \t]*$/m, '') + `\n- id: dsh-research-agent
  config:
    dbPath: ${JSON.stringify(join(home, 'research.sqlite'))}
    importOnStart: false
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
`)
  const { loadLayeredEnv } = await import(pathToFileURL(installed.resolve('@deepseek-ai/dsh-app-boot')).href)
  const { runProfile } = await import('@deepseek-ai/dsh/profile-boot')
  const app = await runProfile({
    environment: loadLayeredEnv('dsh'), profile: 'validation',
    patchFiles: [], args: ['--no-open'],
  })
  shutdown = app.shutdown
  const { ctx } = app
  assert.ok(ctx.research, 'Research host must activate in the shipped Web profile')
  const { SessionId } = await import('@deepseek-ai/dsh-session')
  const modelSelection = { provider: 'profile-validation', model: 'plain' }
  ctx.llm.registerAdapter([modelSelection.provider], new SettingsFixtureModel())
  const counts = {}
  for (const id of ['standard', 'research', 'research-scout', 'research-runner', 'research-auditor', 'research-synthesizer', 'research-tool-engineer']) {
    const preset = await ctx.agentPresets.resolve(id)
    assert.equal(preset.broken, undefined, `${id}: ${JSON.stringify(preset.broken)}`)
    const handle = await ctx.agents.create({
      sessionId: SessionId(`validation-${id}`),
      meta: { agentPreset: id, cwd: projectRoot },
      agentOptions: modelSelection,
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, id) },
    })
    const key = handle.agent
    try {
      assert.equal(ctx.agentPresets.composedPreset(key.ctx), id)
      const allNames = ctx.tools.schemas(key).map(tool => tool.name)
      const names = allNames.filter(name => name.startsWith('research_'))
      counts[id] = names.length
      if (id === 'standard') assert.equal(names.length, 0)
      else if (id === 'research') {
        assert.equal(names.length, 43)
        assert.equal(names.includes('research_assignment_report'), false, 'Controller reads reports from research_assignment_list')
      }
      else {
        assert.ok(names.includes('research_assignment_report'), `${id} must submit reports`)
        assert.equal(names.includes('research_record_add'), false, `${id} must not write formal records`)
      }
      if (id === 'research') {
        assert.equal(allNames.includes('web_search'), false, 'Controller must delegate web research to scout')
        assert.equal(allNames.includes('web_fetch'), false, 'Controller must delegate web research to scout')
      }
      assert.equal(names.includes('research_source_capture'), id === 'research-scout', `${id}: source capture belongs only to scout`)
      if (id === 'research-scout') {
        assert.ok(allNames.includes('web_search'), 'Scout must have web search')
        assert.ok(allNames.includes('web_fetch'), 'Scout must have web fetch')
      }
      const toolSet = await ctx.tools.resolve({ agent: key, modelSelection, signal: new AbortController().signal })
      try {
        const offered = ctx.tools.schemas(key, toolSet).map(tool => tool.name)
        assert.equal(offered.includes('research_assignment_report'), false, `${id}: a session without a dispatch cannot report`)
        assert.equal(offered.includes('research_source_capture'), false, `${id}: a session without a dispatch cannot capture sources`)
        if (id === 'research-scout') {
          assert.equal(offered.includes('web_search'), await ctx.web.searchReady(modelSelection.provider))
          assert.equal(offered.includes('web_fetch'), await ctx.web.fetchReady(modelSelection.provider))
        }
      } finally { toolSet.dispose() }
    } finally { await handle.dispose() }
  }
  assert.equal(ctx.research.state().records, 0, 'Profile verification must not write research facts')
  await checkNativeModelSearch(ctx, projectRoot)
  const savedDefaults = await checkModelSettings(ctx)
  await shutdown.shutdown(0)
  shutdown = undefined
  const reopened = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'validation', patchFiles: [], args: ['--no-open'] })
  shutdown = reopened.shutdown
  assert.deepEqual(reopened.ctx.research.dispatcher.listModelDefaults(), savedDefaults, 'Role defaults survive a full profile restart')
  assert.deepEqual(reopened.ctx.web.listProviders().search.map(item => item.id), ['model-native'])
  originalLog(JSON.stringify({
    dsh: require('@deepseek-ai/dsh/package.json').version, presetResearchToolCounts: counts,
    modelSettings: 'save, validation, concurrency, live update, tool parity and restart passed',
    nativeModelSearch: 'normal and scout tool calls, source capture, and configuration across restart passed',
    modelRequests: 0,
  }, null, 2))
  if (process.argv.includes('--ui')) {
    reopened.ctx.llm.registerAdapter(['settings-fixture'], new SettingsFixtureModel())
    // A session needs a workspace, and adding one in the page opens the system folder picker; give the profile an empty one of its own.
    await mkdir(join(home, 'workspace'), { recursive: true })
    await reopened.ctx.workspaceRegistry.create(join(home, 'workspace'))
    // The profile's database is empty. RESEARCH_UI_BOARD names a JSON file to serve as the status board instead, so its non-empty states can be looked at.
    if (process.env.RESEARCH_UI_BOARD) {
      const sample = JSON.parse(await readFile(process.env.RESEARCH_UI_BOARD, 'utf8'))
      reopened.ctx.research.board = () => ({ ...sample, generated_at: new Date().toISOString() })
    }
    originalLog(reopened.ctx.connection.authenticatedUrl(reopened.ctx.webServer.getOrigin()))
    originalLog('Temporary UI verification is ready; press Enter to stop and remove its profile.')
    await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve) })
    process.stdin.pause()
  }
} finally {
  if (shutdown) await shutdown.shutdown(0)
  console.log = originalLog
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(home, { recursive: true, force: true })
}
