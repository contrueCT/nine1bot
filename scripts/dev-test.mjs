import { spawn } from 'node:child_process'
import { delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..')
const workspaceBinDirs = new Set([
  resolve(repoRoot, 'node_modules', '.bin').toLowerCase(),
  resolve(repoRoot, 'web', 'node_modules', '.bin').toLowerCase(),
])

function cleanPath(value) {
  return (value || '')
    .split(delimiter)
    .filter((entry) => {
      if (!entry) return false
      return !workspaceBinDirs.has(resolve(entry).toLowerCase())
    })
    .join(delimiter)
}

const env = {
  ...process.env,
  PATH: cleanPath(process.env.PATH),
  Path: cleanPath(process.env.Path),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER:
    process.env.OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER || 'true',
}

function runBun(args) {
  return new Promise((resolveRun) => {
    const child = spawn('bun', args, {
      cwd: repoRoot,
      env,
      shell: process.platform === 'win32',
      stdio: 'inherit',
    })
    child.on('exit', (code, signal) => resolveRun({ code, signal }))
    child.on('error', (error) => {
      console.error(error)
      resolveRun({ code: 1 })
    })
  })
}

const rebuild = await runBun(['run', 'rebuild'])
if (rebuild.code !== 0 || rebuild.signal) {
  process.exit(rebuild.code || 1)
}

const app = await runBun(['run', 'nine1bot'])
process.exit(app.code || (app.signal ? 1 : 0))
