import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { runDsh, projectRoot } from './dsh.mjs'

const profile = resolve(process.env.DSH_HOME ?? resolve(homedir(), '.dsh'), 'profiles/research')
if (!existsSync(resolve(profile, 'package.json'))) {
  await runDsh(['--profile', 'research', '--from-default-profile', 'web', '--dump-config'], { quiet: true })
}
await runDsh(['plugin', '--profile', 'research', 'add', projectRoot])
const patchPath = resolve(profile, 'cordis.patch.yml')
const current = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
// Preserve later user changes, including model/account settings. Only configure a fresh empty profile.
const content = current.split('\n').filter(line => !line.trimStart().startsWith('#')).join('\n').trim()
if (content === '' || content === '[]') {
  const patch = `- id: dsh-research-agent\n  config:\n    dbPath: ${JSON.stringify(resolve(projectRoot, 'research.sqlite'))}\n    projectRoot: ${JSON.stringify(resolve(projectRoot, '../google'))}\n    importOnStart: true\n- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 5417\n`
  writeFileSync(patchPath, patch)
} else if (!current.includes('id: dsh-research-agent')) {
  throw new Error(`Profile already has custom settings; research entry must be added without replacing them: ${patchPath}`)
}
await runDsh(['--profile', 'research', '--dump-config'], { quiet: true })
console.log(`Research profile ready: ${profile}\nStart: pnpm start\nModel and account settings are left to the user.`)
