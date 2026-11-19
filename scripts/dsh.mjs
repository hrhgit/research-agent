import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const projectRoot = resolve(import.meta.dirname, '..')
// Run the same published release used by the plugin's build and tests.
// An explicit checkout remains available for DSH development.
export const dshRoot = process.env.RESEARCH_DSH_ROOT ? resolve(process.env.RESEARCH_DSH_ROOT) : undefined

export function runDsh(args, options = {}) {
  const require = createRequire(resolve(dshRoot ?? projectRoot, 'package.json'))
  const launchArgs = dshRoot
    ? ['--import', pathToFileURL(require.resolve('tsx/esm')).href, resolve(dshRoot, 'apps/cli/src/bin.ts')]
    : [resolve(require.resolve('@deepseek-ai/dsh/package.json'), '..', 'lib/bin.js')]
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [...launchArgs, ...args], {
      cwd: projectRoot, stdio: options.quiet ? ['ignore', 'ignore', 'inherit'] : 'inherit',
      env: { ...process.env, ...(dshRoot ? { TSX_TSCONFIG_PATH: resolve(dshRoot, 'tsconfig.json') } : {}) },
    })
    const interrupt = () => child.kill('SIGINT')
    const terminate = () => child.kill('SIGTERM')
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') done()
      else reject(new Error(`DSH exited with ${code ?? signal}`))
    })
  })
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runDsh(process.argv.slice(2))
}
