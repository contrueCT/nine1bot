/**
 * Chrome 浏览器管理
 * 启动带有远程调试端口的 Chrome 实例
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir } from 'fs/promises'
import { tmpdir, homedir, platform } from 'os'
import { join } from 'path'
import { getCdpVersion } from './cdp'

export interface ChromeInstance {
  process: ChildProcess
  pid: number
  cdpPort: number
  cdpUrl: string
  userDataDir: string
  executablePath: string
  stop: () => Promise<void>
}

export interface ChromeLaunchOptions {
  cdpPort?: number
  headless?: boolean
  userDataDir?: string
  executablePath?: string
  args?: string[]
  startupTimeoutMs?: number
}

/**
 * 检测系统中可用的 Chrome 可执行文件路径
 */
export function detectChromeExecutable(): string | null {
  const os = platform()

  const candidates: string[] = []

  if (os === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else if (os === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] || 'C:\\Program Files'
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA'] || join(homedir(), 'AppData', 'Local')

    candidates.push(
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    )
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/brave-browser',
    )
  }

  for (const path of candidates) {
    if (existsSync(path)) {
      return path
    }
  }

  return null
}

/** Poll only while this launch owns a live process and its startup deadline. */
async function waitForCdp(cdpUrl: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(new URL('/json/version', cdpUrl), { signal })
      if (response.ok) {
        await response.json()
        signal.throwIfAborted()
        return
      }
    } catch {
      signal.throwIfAborted()
    }
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      const timer = setTimeout(finish, 200)
      signal.addEventListener('abort', finish, { once: true })
      if (signal.aborted) finish()
    })
  }
  signal.throwIfAborted()
}

/**
 * 启动 Chrome 浏览器
 */
export async function launchChrome(options: ChromeLaunchOptions = {}): Promise<ChromeInstance> {
  const cdpPort = options.cdpPort ?? 9222
  const headless = options.headless ?? false

  // 检测或使用指定的可执行文件路径
  const executablePath = options.executablePath ?? detectChromeExecutable()
  if (!executablePath) {
    throw new Error('Chrome executable not found. Please install Chrome or specify executablePath.')
  }

  // 创建用户数据目录
  const userDataDir = options.userDataDir ?? join(tmpdir(), 'browser-mcp-chrome-profile')
  await mkdir(userDataDir, { recursive: true })

  // 构建启动参数
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-client-side-phishing-detection',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--disable-translate',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    ...(headless ? ['--headless=new'] : []),
    ...(options.args ?? []),
  ]

  const cdpUrl = `http://127.0.0.1:${cdpPort}`
  const timeoutMs = options.startupTimeoutMs ?? 30000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('startupTimeoutMs must be a positive finite number')
  }

  let chromeProcess: ChildProcess
  try {
    chromeProcess = spawn(executablePath, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    throw new Error(`Failed to launch Chrome: ${error instanceof Error ? error.message : String(error)}`)
  }

  const startup = new AbortController()
  let stderr = ''
  let closed = false
  let exited = false
  // Drain both streams so a noisy child cannot block before opening CDP.
  chromeProcess.stdout?.resume()
  chromeProcess.stderr?.on('data', (chunk: Buffer | string) => {
    stderr = (stderr + String(chunk)).slice(-4096)
  })
  const onError = (error: Error) => startup.abort(new Error(`Chrome process error: ${error.message}`))
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    exited = true
    startup.abort(new Error(`Chrome exited before CDP became available (code ${code ?? 'none'}, signal ${signal ?? 'none'})`))
  }
  chromeProcess.on('error', onError)
  chromeProcess.once('exit', onExit)
  chromeProcess.once('close', () => { closed = true })

  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (!closed) {
        await new Promise<void>((resolve, reject) => {
          let forceTimer: ReturnType<typeof setTimeout> | undefined
          const finish = (error?: Error) => {
            clearTimeout(timer)
            if (forceTimer) clearTimeout(forceTimer)
            chromeProcess.removeListener('close', onClose)
            if (error) reject(error)
            else resolve()
          }
          const onClose = () => finish()
          // Kill only the child we spawned, never a process discovered via a port.
          const timer = setTimeout(() => {
            try {
              if (!exited && chromeProcess.pid) chromeProcess.kill('SIGKILL')
              forceTimer = setTimeout(() => {
                finish(exited || closed ? undefined : new Error('Owned Chrome process did not exit after termination'))
              }, 1000)
            } catch (error) {
              finish(error instanceof Error ? error : new Error(String(error)))
            }
          }, 5000)
          chromeProcess.once('close', onClose)
          try {
            if (!exited && chromeProcess.pid) chromeProcess.kill()
            if (closed) finish()
          } catch (error) {
            finish(error instanceof Error ? error : new Error(String(error)))
          }
        })
      }
    })()
    return stopping
  }

  const deadline = setTimeout(() => {
    startup.abort(new Error(`CDP endpoint not available after ${timeoutMs}ms`))
  }, timeoutMs)
  let rejectStartup: (() => void) | undefined
  try {
    // The race also bounds a transport that fails to honor AbortSignal.
    await Promise.race([
      waitForCdp(cdpUrl, startup.signal),
      new Promise<never>((_, reject) => {
        rejectStartup = () => reject(startup.signal.reason)
        startup.signal.addEventListener('abort', rejectStartup, { once: true })
        if (startup.signal.aborted) reject(startup.signal.reason)
      }),
    ])
    startup.signal.throwIfAborted()
    if (!chromeProcess.pid) throw new Error('Failed to start Chrome process')
  } catch (error) {
    startup.abort(error)
    let cleanupError = ''
    try { await stop() } catch (failure) { cleanupError = `\nCleanup failed: ${String(failure)}` }
    const detail = stderr.trim()
    throw new Error(`${error instanceof Error ? error.message : String(error)}${detail ? `\nChrome stderr (last 4096 characters): ${detail}` : ''}${cleanupError}`)
  } finally {
    clearTimeout(deadline)
    if (rejectStartup) startup.signal.removeEventListener('abort', rejectStartup)
  }

  const instance: ChromeInstance = {
    process: chromeProcess,
    pid: chromeProcess.pid!,
    cdpPort,
    cdpUrl,
    userDataDir,
    executablePath,
    stop,
  }

  return instance
}

/**
 * 检查是否有 Chrome 实例在指定端口运行
 */
export async function isChromeRunning(cdpPort = 9222): Promise<boolean> {
  try {
    await getCdpVersion(`http://127.0.0.1:${cdpPort}`)
    return true
  } catch {
    return false
  }
}

/**
 * 连接到已运行的 Chrome 实例
 */
export async function connectToChrome(cdpPort = 9222): Promise<{ cdpUrl: string; version: Awaited<ReturnType<typeof getCdpVersion>> }> {
  const cdpUrl = `http://127.0.0.1:${cdpPort}`
  const version = await getCdpVersion(cdpUrl)
  return { cdpUrl, version }
}
