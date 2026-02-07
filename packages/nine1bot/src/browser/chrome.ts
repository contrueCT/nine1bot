/**
 * Chrome 浏览器管理
 * 启动带有远程调试端口的 Chrome 实例
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, rm } from 'fs/promises'
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

/**
 * 等待 CDP 端点可用
 */
async function waitForCdp(cdpUrl: string, timeout = 30000): Promise<void> {
  const startTime = Date.now()

  while (Date.now() - startTime < timeout) {
    try {
      await getCdpVersion(cdpUrl)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 200))
    }
  }

  throw new Error(`CDP endpoint not available after ${timeout}ms`)
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
  const userDataDir = options.userDataDir ?? join(tmpdir(), 'nine1bot-chrome-profile')
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

  // 启动 Chrome 进程
  const chromeProcess = spawn(executablePath, args, {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const pid = chromeProcess.pid
  if (!pid) {
    throw new Error('Failed to start Chrome process')
  }

  const cdpUrl = `http://127.0.0.1:${cdpPort}`

  // 等待 CDP 端点可用
  try {
    await waitForCdp(cdpUrl)
  } catch (error) {
    chromeProcess.kill()
    throw error
  }

  const instance: ChromeInstance = {
    process: chromeProcess,
    pid,
    cdpPort,
    cdpUrl,
    userDataDir,
    executablePath,
    stop: async () => {
      chromeProcess.kill()
      // 等待进程退出
      await new Promise<void>((resolve) => {
        chromeProcess.on('exit', resolve)
        setTimeout(resolve, 5000) // 超时强制继续
      })
    },
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
