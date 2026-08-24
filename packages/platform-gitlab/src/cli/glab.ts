import { execFile } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import { access, realpath, stat } from 'node:fs/promises'
import { delimiter, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { sanitizeGitLabSecrets } from '../review/sanitizer'
import type { GitLabCliRunner, GitLabCliRunOptions, GitLabCliRunResult, GitLabCliStatus } from './types'

export const defaultGitLabCliTimeoutMs = 30_000
export const gitLabCliMaxOutputBytes = 4 * 1024 * 1024

const blockedGitLabCliEnvironmentKeys = new Set([
  'GITLAB_TOKEN',
  'GITLAB_ACCESS_TOKEN',
  'OAUTH_TOKEN',
  'GITLAB_HOST',
  'GITLAB_URI',
  'GITLAB_API_HOST',
  'GITLAB_CLIENT_ID',
  'GL_HOST',
  'GLAB_TOKEN',
  'GLAB_HOST',
  'CI_JOB_TOKEN',
  'CI_BUILD_TOKEN',
  'CI_JOB_JWT',
  'CI_JOB_JWT_V2',
  'CI_DEPLOY_PASSWORD',
  'CI_REGISTRY_PASSWORD',
  'CI_REPOSITORY_URL',
  'GITLAB_CI',
  'GLAB_ENABLE_CI_AUTOLOGIN',
  'CI_SERVER_FQDN',
  'CI_SERVER_HOST',
  'CI_SERVER_URL',
  'CI_SERVER_PROTOCOL',
  'CI_SERVER_SHELL_SSH_HOST',
  'CI_API_V4_URL',
])

type GlabProcessResult = Omit<GitLabCliRunResult, 'command' | 'args'>

export type GlabProcessRequest = GitLabCliRunOptions & {
  executable: string
  args: string[]
  env: NodeJS.ProcessEnv
  timeoutMs: number
}

export type GlabRunnerDependencies = {
  env?: NodeJS.ProcessEnv
  execute?: (request: GlabProcessRequest) => Promise<GlabProcessResult>
}

export function createGlabRunner(dependencies: GlabRunnerDependencies = {}): GitLabCliRunner {
  const env = controlledGitLabCliEnvironment(dependencies.env ?? process.env)
  const execute = dependencies.execute ?? executeGlabProcess
  let executable: Promise<string> | undefined

  return async (args, options = {}) => {
    try {
      executable ??= resolveGlabExecutable(env, options.cwd)
      const executablePath = await executable
      if (options.cwd && isPathWithin(await canonicalDirectory(options.cwd), executablePath)) {
        throw executableNotFoundError()
      }
      const result = await execute({
        executable: executablePath,
        args,
        env,
        cwd: options.cwd,
        timeoutMs: options.timeoutMs ?? defaultGitLabCliTimeoutMs,
        signal: options.signal,
        stdin: options.stdin,
      })
      return { ...result, command: 'glab', args }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      return {
        stdout: '',
        stderr: err.message || '',
        exitCode: 1,
        command: 'glab',
        args,
        ...(err.code === 'ABORT_ERR' || options.signal?.aborted ? { cancelled: true } : {}),
      }
    }
  }
}

export const runGlab = createGlabRunner()

async function executeGlabProcess(request: GlabProcessRequest): Promise<GlabProcessResult> {
  return await new Promise<GlabProcessResult>((resolve) => {
    try {
      const child = execFile(request.executable, request.args, {
        cwd: request.cwd,
        timeout: request.timeoutMs,
        windowsHide: true,
        maxBuffer: gitLabCliMaxOutputBytes + 64 * 1024,
        signal: request.signal,
        env: request.env,
        encoding: 'utf8',
      }, (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code
        resolve({
          stdout: stdout ?? '',
          stderr: stderr || error?.message || '',
          exitCode: error ? typeof error.code === 'number' ? error.code : 1 : 0,
          ...(code === 'ABORT_ERR' || request.signal?.aborted ? { cancelled: true } : {}),
          ...(code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { outputTooLarge: true } : {}),
        })
      })
      child.stdin?.on('error', () => {})
      child.stdin?.end(request.stdin)
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      resolve({
        stdout: '',
        stderr: err.message || '',
        exitCode: 1,
        ...(err.code === 'ABORT_ERR' || request.signal?.aborted ? { cancelled: true } : {}),
      })
    }
  })
}

async function resolveGlabExecutable(env: NodeJS.ProcessEnv, cwd?: string) {
  const searchPath = environmentValue(env, 'PATH')
  if (!searchPath) throw executableNotFoundError()

  const excludedDirectory = cwd ? await canonicalDirectory(cwd) : undefined
  const names = process.platform === 'win32' ? ['glab.exe', 'glab.com'] : ['glab']
  for (const rawEntry of searchPath.split(delimiter)) {
    const entry = unquotePathEntry(rawEntry)
    if (!entry || !isAbsolute(entry)) continue

    const directory = await realpath(entry).catch(() => undefined)
    if (!directory || (excludedDirectory && isPathWithin(excludedDirectory, directory))) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (!await isExecutableFile(candidate)) continue
      const executable = await realpath(candidate)
      if (excludedDirectory && isPathWithin(excludedDirectory, executable)) continue
      return executable
    }
  }

  throw executableNotFoundError()
}

async function canonicalDirectory(input: string) {
  return await realpath(input).catch(() => resolvePath(input))
}

async function isExecutableFile(input: string) {
  try {
    if (!(await stat(input)).isFile()) return false
    if (process.platform !== 'win32') await access(input, fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

function environmentValue(env: NodeJS.ProcessEnv, key: string) {
  const entry = Object.entries(env).find(([candidate]) => candidate.toUpperCase() === key)
  return entry?.[1]
}

function unquotePathEntry(input: string) {
  const trimmed = input.trim()
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed
}

function samePath(left: string, right: string) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function isPathWithin(directory: string, candidate: string) {
  if (samePath(directory, candidate)) return true
  const relation = relative(directory, candidate)
  return relation !== '..'
    && !relation.startsWith(`..${sep}`)
    && !isAbsolute(relation)
}

function executableNotFoundError() {
  return Object.assign(new Error('GitLab CLI executable was not found in trusted PATH.'), { code: 'ENOENT' })
}

function controlledGitLabCliEnvironment(source: NodeJS.ProcessEnv) {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    const normalized = key.toUpperCase()
    if (blockedGitLabCliEnvironmentKeys.has(normalized)) continue
    if (/^(?:GITLAB|GLAB)_.*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/.test(normalized)) continue
    if (/^CI_.*(?:TOKEN|PASSWORD|JWT|CREDENTIAL|AUTH)/.test(normalized)) continue
    env[key] = value
  }
  return env
}

export async function getGitLabCliStatus(input: {
  runner?: GitLabCliRunner
  cwd?: string
  host?: string
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<GitLabCliStatus> {
  const runner = input.runner ?? runGlab
  const timeoutMs = input.timeoutMs ?? 10_000
  const version = await runner(['--version'], { cwd: input.cwd, timeoutMs, signal: input.signal })
  if (version.exitCode !== 0) {
    return {
      available: false,
      authenticated: false,
      message: statusMessage('GitLab CLI is not available.', version),
    }
  }

  const authArgs = input.host
    ? ['auth', 'status', '--hostname', input.host]
    : ['auth', 'status']
  const auth = await runner(authArgs, { cwd: input.cwd, timeoutMs, signal: input.signal })
  if (auth.exitCode !== 0) {
    return {
      available: true,
      version: parseGlabVersion(version.stdout || version.stderr),
      authenticated: false,
      message: statusMessage('GitLab CLI is installed but not authenticated.', auth),
    }
  }

  const authText = `${auth.stdout}\n${auth.stderr}`
  const parsed = parseGlabAuthStatus(authText)
  return {
    available: true,
    version: parseGlabVersion(version.stdout || version.stderr),
    authenticated: true,
    host: parsed.host,
    user: parsed.user,
    message: parsed.host
      ? `GitLab CLI is authenticated for ${parsed.host}${parsed.user ? ` as ${parsed.user}` : ''}.`
      : 'GitLab CLI is authenticated.',
  }
}

export function parseGlabVersion(output: string): string | undefined {
  const normalized = output.trim()
  const match = /glab\s+version\s+([^\s]+)/i.exec(normalized)
    ?? /version\s+([^\s]+)/i.exec(normalized)
  return boundedIdentity(match?.[1] ?? normalized.split(/\s+/).find((part) => /^\d+\.\d+/.test(part)), 128)
}

export function parseGlabAuthStatus(output: string): { host?: string; user?: string } {
  const host = boundedIdentity(
    /(?:Logged in to|gitlab host:|host:)\s+([^\s,]+)/i.exec(output)?.[1]
      ?? /([a-z0-9.-]*gitlab[a-z0-9.-]*)/i.exec(output)?.[1],
    255,
  )
  const user = boundedIdentity(/(?:as|user:|username:)\s+@?([A-Za-z0-9_.-]+)/i.exec(output)?.[1], 256)
  return { host, user }
}

function boundedIdentity(input: string | undefined, maxBytes: number) {
  if (!input || Buffer.byteLength(input, 'utf8') > maxBytes) return undefined
  return input
}

function statusMessage(prefix: string, result: GitLabCliRunResult) {
  const detail = sanitizeGitLabSecrets(result.stderr || result.stdout, {
    maxInputCodeUnits: 2_000,
    maxInputUtf8Bytes: 4_000,
    maxOutputCodeUnits: 500,
    maxOutputUtf8Bytes: 1_000,
  }).replace(/\s+/g, ' ').trim()
  return detail ? `${prefix} ${detail}` : prefix
}
