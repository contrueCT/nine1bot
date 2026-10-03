/** Test infrastructure only. No browser mocks and no changes to Chrome security settings. */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

export const ENABLED = process.env.RUN_REAL_CHROME === '1'
export const FIXTURE_ORIGIN = 'http://127.0.0.1:4096'

export function assertChromeForTestingVersion(version: string): void {
  if (!/^Google Chrome for Testing \d+\.\d+\.\d+\.\d+\s*$/.test(version.trim())) {
    throw new Error(`Expected the full Chrome for Testing binary; got ${JSON.stringify(version.trim())}. Branded Chrome 137+ does not support --load-extension. Set CHROME_PATH to Chrome for Testing; do not bypass extension policy or disable browser security.`)
  }
}

/** Check the actual executable before binding the fixture or launching either browser. */
export async function verifyChromeForTesting(executable: string, artifacts: string): Promise<void> {
  if (!ENABLED) throw new Error('Probing real Chrome requires RUN_REAL_CHROME=1')
  if (!isAbsolute(executable)) throw new Error('CHROME_PATH must be an absolute path to Chrome for Testing')
  const { stdout, stderr } = await promisify(execFile)(executable, ['--version'], { timeout: 5000, maxBuffer: 16384 })
  await writeFile(join(artifacts, 'chrome-version.txt'), stdout)
  await writeFile(join(artifacts, 'chrome-version.stderr.log'), stderr)
  console.info(`[real-chrome] Browser: ${stdout.trim()}`)
  assertChromeForTestingVersion(stdout)
}

export function chromeArguments(profile: string, extensionDir?: string): string[] {
  return [
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--headless=new',
    '--window-size=1100,720',
    ...(extensionDir ? [`--load-extension=${extensionDir}`] : []),
    'about:blank',
  ]
}

export function parseDebuggingPort(text: string): number {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  const port = Number(firstLine)
  if (!/^\d+$/.test(firstLine) || !Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    throw new Error('Invalid DevToolsActivePort from owned Chrome profile')
  }
  return port
}

export async function within<T>(label: string, promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

export type CleanupResult =
  | { name: string; status: 'passed'; durationMs: number }
  | { name: string; status: 'failed'; durationMs: number; error: unknown }

/** Attempt every owned resource, including after a failure; callers must report/throw failures. */
export async function cleanupResources(
  resources: Array<{ name: string; dispose: () => void | Promise<void> }>,
  timeoutMs = 15000,
): Promise<CleanupResult[]> {
  const results: CleanupResult[] = []
  for (const { name, dispose } of resources) {
    const started = Date.now()
    try {
      await within(name, Promise.resolve().then(dispose), timeoutMs)
      results.push({ name, status: 'passed', durationMs: Date.now() - started })
    } catch (error) {
      results.push({ name, status: 'failed', durationMs: Date.now() - started, error })
    }
  }
  return results
}

export async function eventually<T>(label: string, check: () => Promise<T | undefined | false>, timeoutMs = 10000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await within(label, check(), Math.max(1, deadline - Date.now()))
      if (result !== false && result !== undefined) return result
    } catch (error) {
      lastError = error
    }
    await Bun.sleep(Math.min(100, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`${label} did not become ready within ${timeoutMs}ms${lastError ? `: ${String(lastError)}` : ''}`)
}

export interface OwnedChrome {
  cdpUrl: string
  port: number
  profile: string
  version: Record<string, unknown>
  process: ChildProcess
  stop(): Promise<void>
}

export async function startChrome(label: string, executable: string, artifacts: string, extensionDir?: string): Promise<OwnedChrome> {
  if (!ENABLED) throw new Error('Launching real Chrome requires RUN_REAL_CHROME=1')
  if (!isAbsolute(executable)) throw new Error('CHROME_PATH must be an absolute path to Chrome for Testing')
  await access(executable, constants.X_OK)
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    throw new Error('Run as a non-root user with the Chrome sandbox available; this suite never disables the sandbox')
  }
  if (extensionDir) await access(join(extensionDir, 'manifest.json'))
  await mkdir(artifacts, { recursive: true })
  const profile = await mkdtemp(join(tmpdir(), `nine1bot-real-chrome-${label}-`))
  const child = spawn(executable, chromeArguments(profile, extensionDir), { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  let spawnError: Error | undefined
  let closed = false
  child.stdout?.resume()
  child.stderr?.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-100_000) })
  child.on('error', (error) => { spawnError = error })
  const closePromise = new Promise<void>((resolveClose) => child.once('close', () => { closed = true; resolveClose() }))
  let stopped: Promise<void> | undefined
  const stop = () => stopped ??= (async () => {
    try {
      if (!closed) {
        child.kill('SIGTERM')
        try { await within(`${label} Chrome exit`, closePromise, 5000) } catch {
          // Terminate only the process created above; never a discovered PID or shared browser.
          child.kill('SIGKILL')
          await within(`${label} Chrome forced exit`, closePromise, 5000)
        }
      }
      await rm(profile, { recursive: true, force: true })
    } finally {
      await writeFile(join(artifacts, `${label}-chrome.stderr.log`), stderr)
    }
  })()
  try {
    const port = await eventually(`${label} DevToolsActivePort`, async () => {
      if (spawnError) throw spawnError
      if (closed) throw new Error(`${label} Chrome exited before startup: ${stderr}`)
      return parseDebuggingPort(await readFile(join(profile, 'DevToolsActivePort'), 'utf8'))
    }, 20000)
    const cdpUrl = `http://127.0.0.1:${port}`
    const response = await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error(`Chrome CDP version returned HTTP ${response.status}`)
    const version = await response.json() as Record<string, unknown>
    if (typeof version.Browser !== 'string' || !/^(HeadlessChrome|Chrome)\//.test(version.Browser)) {
      throw new Error(`Expected actual Chrome CDP endpoint; got ${String(version.Browser)}`)
    }
    await writeFile(join(artifacts, `${label}-version.json`), JSON.stringify(version, null, 2))
    return { cdpUrl, port, profile, version, process: child, stop }
  } catch (error) {
    try { await stop() } catch (cleanupError) { throw new AggregateError([error, cleanupError], `${label} Chrome startup and cleanup failed`) }
    throw error
  }
}

export function artifactDirectory(): string {
  return resolve(process.env.REAL_CHROME_ARTIFACTS || join(tmpdir(), `nine1bot-real-chrome-artifacts-${Date.now()}`))
}
