import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'

export type FeishuCliRunResult = {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
}

export type FeishuCliRunOptions = {
  env: Record<string, string | undefined>
  timeoutMs: number
  cwd?: string
}

export type FeishuCliRunner = (
  command: string,
  args: string[],
  options: FeishuCliRunOptions,
) => Promise<FeishuCliRunResult>

export type FeishuCliContext = {
  cliPath?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
  runner?: FeishuCliRunner
}

export type FeishuAuthState = 'authenticated' | 'need_config' | 'need_login' | 'unknown'

export type FeishuAuthStatus = {
  state: FeishuAuthState
  identity?: string
  tokenStatus?: string
  userName?: string
  expiresAt?: string
  refreshExpiresAt?: string
  raw?: Record<string, unknown>
  result: FeishuCliRunResult
}

export type FeishuCliJsonResult = FeishuCliRunResult & {
  json?: unknown
}

export function resolveFeishuCliPath(
  cliPathSetting: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (cliPathSetting?.trim()) {
    const value = cliPathSetting.trim()
    if (hasPathSeparator(value) || isAbsolute(value)) return existsSync(value) ? value : undefined
    return findCommandOnPath(value, env)
  }

  return findCommandOnPath('lark-cli', env)
}

function findCommandOnPath(
  commandName: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? process.env.PATH
  if (!pathValue) return undefined
  const names = commandNames(commandName, env)
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function commandNames(commandName: string, env: Record<string, string | undefined>) {
  if (!isWindowsEnv(env) || hasFileExtension(commandName)) return [commandName]
  return [`${commandName}.cmd`, `${commandName}.exe`, `${commandName}.bat`, commandName]
}

function hasFileExtension(commandName: string) {
  for (let index = commandName.length - 1; index >= 0; index--) {
    const char = commandName[index]
    if (char === '/' || char === '\\') return false
    if (char === '.') return index < commandName.length - 1
  }
  return false
}

function isWindowsEnv(env: Record<string, string | undefined>) {
  return process.platform === 'win32' || env.OS === 'Windows_NT'
}

export async function getFeishuCliVersion(ctx: FeishuCliContext): Promise<FeishuCliJsonResult & { version?: string }> {
  const result = await runFeishuCli(ctx.cliPath ?? 'lark-cli', ['--version'], {
    env: effectiveEnv(ctx.env),
    timeoutMs: ctx.timeoutMs ?? 2_000,
    runner: ctx.runner,
  })
  return {
    ...result,
    version: parseVersion(result.stdout || result.stderr),
  }
}

export async function getFeishuAuthStatus(ctx: FeishuCliContext): Promise<FeishuAuthStatus> {
  const result = await runFeishuCli(ctx.cliPath ?? 'lark-cli', ['auth', 'status'], {
    env: effectiveEnv(ctx.env),
    timeoutMs: ctx.timeoutMs ?? 3_000,
    runner: ctx.runner,
  })
  const parsed = parseCliJson(result.stdout, result.stderr)
  const raw = asRecord(parsed)
  return {
    state: authStateFrom(raw, result),
    identity: stringValue(raw?.identity),
    tokenStatus: stringValue(raw?.tokenStatus),
    userName: stringValue(raw?.userName),
    expiresAt: stringValue(raw?.expiresAt),
    refreshExpiresAt: stringValue(raw?.refreshExpiresAt),
    raw,
    result,
  }
}

export async function runFeishuCliJsonWithFile(input: {
  cliPath: string
  args: string[]
  fileFlag: '--params' | '--data'
  fileName: string
  payload: unknown
  env?: Record<string, string | undefined>
  timeoutMs: number
  runner?: FeishuCliRunner
}): Promise<FeishuCliJsonResult> {
  const cwd = await mkdtemp(join(tmpdir(), 'nine1bot-feishu-'))
  try {
    await writeFile(join(cwd, input.fileName), JSON.stringify(input.payload), 'utf8')
    const result = await runFeishuCli(input.cliPath, [
      ...input.args,
      input.fileFlag,
      `@${input.fileName}`,
      '--as',
      'user',
      '--format',
      'json',
    ], {
      env: effectiveEnv(input.env),
      timeoutMs: input.timeoutMs,
      cwd,
      runner: input.runner,
    })
    return {
      ...result,
      json: parseCliJson(result.stdout, result.stderr),
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined)
  }
}

export function parseCliJson(stdout: string, stderr = ''): unknown | undefined {
  const candidates = [stdout, stderr, `${stdout}\n${stderr}`]
  for (const candidate of candidates) {
    const parsed = parseFirstJson(candidate)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function sanitizeCliError(input: unknown): Record<string, unknown> | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  const error = asRecord(record.error)
  if (!error) return pick(record, ['code', 'msg', 'message'])
  return dropUndefined({
    type: stringValue(error.type),
    code: numberOrString(error.code),
    message: stringValue(error.message),
  })
}

export function runFeishuCli(
  command: string,
  args: string[],
  options: FeishuCliRunOptions & { runner?: FeishuCliRunner },
): Promise<FeishuCliRunResult> {
  if (options.runner) return options.runner(command, args, options)
  return new Promise((resolve) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: effectiveEnv(options.env),
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    }, (error, stdout, stderr) => {
      const errorRecord = error && typeof error === 'object' ? error as Record<string, unknown> : undefined
      const code = errorRecord?.code
      const exitCode = typeof code === 'number' ? code : error ? 1 : 0
      resolve({
        exitCode,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        timedOut: Boolean(errorRecord?.killed) || code === 'ETIMEDOUT',
      })
    })
  })
}

export function authStateFrom(
  parsed: Record<string, unknown> | undefined,
  result: Pick<FeishuCliRunResult, 'exitCode' | 'stdout' | 'stderr' | 'timedOut'>,
): FeishuAuthState {
  const tokenStatus = stringValue(parsed?.tokenStatus)?.toLowerCase()
  const identity = stringValue(parsed?.identity)
  if (result.exitCode === 0 && identity && (tokenStatus === 'valid' || tokenStatus === 'needs_refresh')) {
    return 'authenticated'
  }
  if (
    tokenStatus === 'expired'
    || tokenStatus === 'invalid'
    || tokenStatus === 'revoked'
    || tokenStatus === 'unauthorized'
    || tokenStatus === 'login_required'
  ) return 'need_login'

  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
  if (output.includes('config') || output.includes('app id') || output.includes('app secret')) return 'need_config'
  if (output.includes('login') || output.includes('unauthorized') || output.includes('auth')) return 'need_login'
  return 'unknown'
}

export function parseVersion(stdout: string): string | undefined {
  const firstLine = firstNonEmptyLine(stdout)
  if (!firstLine) return undefined
  return findVersionToken(firstLine) ?? firstLine
}

function firstNonEmptyLine(input: string): string | undefined {
  let start = 0
  for (let index = 0; index <= input.length; index++) {
    const isEnd = index === input.length
    const char = isEnd ? '' : input[index]
    if (!isEnd && char !== '\n' && char !== '\r') continue
    const line = input.slice(start, index).trim()
    if (line) return line
    if (char === '\r' && input[index + 1] === '\n') index++
    start = index + 1
  }
  return undefined
}

function findVersionToken(input: string): string | undefined {
  for (let index = 0; index < input.length; index++) {
    if (!isDigit(input[index])) continue
    const end = consumeSemverToken(input, index)
    if (end > index) return input.slice(index, end)
  }
  return undefined
}

function consumeSemverToken(input: string, start: number): number {
  let index = consumeDigits(input, start)
  if (input[index] !== '.') return -1
  index = consumeDigits(input, index + 1)
  if (input[index] !== '.') return -1
  index = consumeDigits(input, index + 1)
  if (index <= start) return -1
  if (input[index] !== '-' && input[index] !== '+') return index
  const suffixStart = index
  index++
  while (index < input.length && isVersionSuffixChar(input[index])) index++
  return index > suffixStart + 1 ? index : suffixStart
}

function consumeDigits(input: string, start: number): number {
  let index = start
  while (index < input.length && isDigit(input[index])) index++
  return index > start ? index : -1
}

function isDigit(char: string | undefined) {
  return char !== undefined && char >= '0' && char <= '9'
}

function isVersionSuffixChar(char: string | undefined) {
  if (!char) return false
  return isDigit(char)
    || (char >= 'a' && char <= 'z')
    || (char >= 'A' && char <= 'Z')
    || char === '_'
    || char === '.'
    || char === '-'
    || char === '+'
}

function parseFirstJson(input: string): unknown | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {}

  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const starts = [objectStart, arrayStart].filter((value) => value >= 0)
  if (starts.length === 0) return undefined
  const start = Math.min(...starts)
  const end = trimmed.lastIndexOf(trimmed[start] === '[' ? ']' : '}')
  if (end <= start) return undefined
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function effectiveEnv(env?: Record<string, string | undefined>) {
  const output: Record<string, string> = {}
  for (const source of [process.env, env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined || !isAllowedEnvKey(key)) continue
      output[key] = value
    }
  }
  return output
}

function isAllowedEnvKey(key: string) {
  const upper = key.toUpperCase()
  return upper === 'PATH'
    || upper === 'PATHEXT'
    || upper === 'SYSTEMROOT'
    || upper === 'WINDIR'
    || upper === 'COMSPEC'
    || upper === 'TEMP'
    || upper === 'TMP'
    || upper === 'TMPDIR'
    || upper === 'USERPROFILE'
    || upper === 'HOME'
    || upper === 'HOMEDRIVE'
    || upper === 'HOMEPATH'
    || upper === 'APPDATA'
    || upper === 'LOCALAPPDATA'
    || upper === 'LANG'
    || upper === 'SHELL'
    || upper === 'HTTP_PROXY'
    || upper === 'HTTPS_PROXY'
    || upper === 'NO_PROXY'
    || upper === 'ALL_PROXY'
    || upper.startsWith('LC_')
}

function hasPathSeparator(input: string) {
  return input.includes('/') || input.includes('\\')
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function numberOrString(input: unknown): string | number | undefined {
  return typeof input === 'number' || typeof input === 'string' ? input : undefined
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function pick(input: Record<string, unknown>, keys: string[]) {
  const output: Record<string, unknown> = {}
  for (const key of keys) {
    if (input[key] !== undefined) output[key] = input[key]
  }
  if (output.code === 0 || output.code === '0') return undefined
  return Object.keys(output).length ? output : undefined
}

function dropUndefined(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) output[key] = value
  }
  return output
}
