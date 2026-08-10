import open from 'open'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { Nine1BotConfig } from '../config/schema'
import { resolveConfigContext } from '../config/loader'
import { startServer, type ServerInstance } from './server'
import { createTunnel, type TunnelManager } from '../tunnel'
import {
  startBuiltinPlatformBackgroundServices,
  stopBuiltinPlatformBackgroundServices,
  unregisterBuiltinPlatformAdapters,
} from '../platform/builtin'
import type { PlatformControllerBridge } from '@nine1bot/platform-protocol'
import { createAccessAuthRuntime } from '../access-auth/service'

const execFileAsync = promisify(execFile)

export interface LaunchOptions {
  port?: number
  hostname?: string
  tunnel?: boolean
  noBrowser?: boolean
  configPath?: string
}

export interface LaunchResult {
  server: ServerInstance
  tunnel?: TunnelManager
  localUrl: string
  publicUrl?: string
  configPath: string
}

/**
 * 启动 Nine1Bot
 */
export async function launch(options: LaunchOptions = {}): Promise<LaunchResult> {
  const configContext = await resolveConfigContext({
    customConfigPath: options.configPath,
    startDir: process.cwd(),
  })
  const configPath = configContext.writePath
  const config = configContext.effective

  // 合并命令行选项
  const serverConfig = {
    ...config.server,
    port: options.port ?? config.server.port,
    hostname: options.hostname ?? config.server.hostname,
  }

  const enableTunnel = options.tunnel ?? config.tunnel.enabled

  // 认证状态必须在 server bind 和 tunnel 创建前确定。enabled 但凭据缺失/损坏
  // 会直接失败，不允许静默退化为无认证。
  const accessAuth = await createAccessAuthRuntime(config.auth)
  if (enableTunnel && accessAuth.state !== 'active') {
    throw new Error(
      'Tunnel requires active Web access authentication. Run `nine1bot config set-password` or disable the tunnel.',
    )
  }

  // 1. 启动服务器
  const server = await startServer({
    server: serverConfig,
    accessAuth,
    configPath,
    fullConfig: config,
  })

  const localUrl = server.url || `http://${serverConfig.hostname}:${serverConfig.port}`
  process.env.NINE1BOT_LOCAL_URL = localUrl
  const authHeader = accessAuth.service.createInternalAuthorization()

  await startBuiltinPlatformBackgroundServices({
    localUrl,
    authHeader,
    controller: createPlatformControllerBridge(localUrl, authHeader),
    legacySettings: {
      feishu: config.feishu,
    },
  })

  // 2. 创建隧道（如果启用）
  let tunnel: TunnelManager | undefined
  let publicUrl: string | undefined
  delete process.env.NINE1BOT_PUBLIC_URL

  if (enableTunnel) {
    try {
      tunnel = await createTunnel(config.tunnel)
      publicUrl = await tunnel.start(serverConfig.port)
      process.env.NINE1BOT_PUBLIC_URL = publicUrl
    } catch (error: any) {
      console.warn(`Failed to create tunnel: ${error.message}`)
      delete process.env.NINE1BOT_PUBLIC_URL
      // 清理可能已部分初始化的隧道资源
      if (tunnel) {
        try {
          await tunnel.stop()
        } catch {
          // 忽略清理错误
        }
        tunnel = undefined
      }
    }
  }

  // 3. 打开浏览器（如果启用）
  if (!options.noBrowser && config.server.openBrowser) {
    try {
      await execFileAsync('which', ['xdg-open'])
      open(localUrl, { wait: false }).catch(() => {})
    } catch {
      console.log(`\nℹ️  Server running at ${localUrl}`)
      console.log('   (Browser auto-open skipped: xdg-open not found)\n')
    }
  }

  return {
    server,
    tunnel,
    localUrl,
    publicUrl,
    configPath,
  }
}

/**
 * 停止 Nine1Bot
 */
export async function shutdown(result: LaunchResult): Promise<void> {
  unregisterBuiltinPlatformAdapters()

  // 停止隧道
  if (result.tunnel) {
    try {
      await result.tunnel.stop()
    } catch {
      // 忽略停止隧道时的错误
    }
  }

  try {
    await stopBuiltinPlatformBackgroundServices()
  } catch {
    // 忽略停止平台后台服务时的错误
  }

  // 停止服务器
  if (result.server) {
    try {
      await result.server.stop()
    } catch {
      // 忽略停止服务器时的错误
    }
  }
}

function createPlatformControllerBridge(localUrl: string, authHeader?: string): PlatformControllerBridge {
  return {
    localUrl,
    authHeader,
    async requestJson(path, init = {}) {
      const url = new URL(path, localUrl)
      const headers = new Headers(init.headers)
      if (authHeader) headers.set('authorization', authHeader)
      if (init.body !== undefined && !headers.has('content-type')) {
        headers.set('content-type', 'application/json')
      }
      const response = await fetch(url, {
        method: init.method ?? 'GET',
        headers,
        body: init.body === undefined
          ? undefined
          : typeof init.body === 'string'
            ? init.body
            : JSON.stringify(init.body),
      })
      if (!response.ok) {
        throw new Error(`Controller request failed: ${response.status} ${response.statusText}`)
      }
      return await response.json()
    },
  }
}

/**
 * 优雅退出处理
 */
export function setupGracefulShutdown(result: LaunchResult): void {
  let isShuttingDown = false

  const handleExit = async (signal?: string) => {
    if (isShuttingDown) return
    isShuttingDown = true

    console.log(`\nShutting down${signal ? ` (${signal})` : ''}...`)
    try {
      await shutdown(result)
    } catch (error: any) {
      console.error('Error during shutdown:', error.message)
    }
    process.exit(0)
  }

  // Windows 和 Unix 信号处理
  process.on('SIGINT', () => handleExit('SIGINT'))
  process.on('SIGTERM', () => handleExit('SIGTERM'))

  // SIGHUP 在 Windows 上不可用
  if (process.platform !== 'win32') {
    process.on('SIGHUP', () => handleExit('SIGHUP'))
  }

  // Windows 特殊处理：监听 stdin 关闭和 'exit' 事件
  if (process.platform === 'win32') {
    // 当终端窗口关闭时
    process.on('exit', () => {
      if (!isShuttingDown) {
        shutdown(result).catch(() => {})
      }
    })
  }
}
