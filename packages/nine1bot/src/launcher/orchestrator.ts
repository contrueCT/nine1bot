import open from 'open'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { loadConfig, findConfigPath, getDefaultConfigPath } from '../config/loader'
import { startServer, type ServerInstance } from './server'
import { createTunnel, type TunnelManager } from '../tunnel'
import { startFeishuService, type FeishuServiceHandle } from '../feishu/service'

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
  feishu?: FeishuServiceHandle
  localUrl: string
  publicUrl?: string
  configPath: string
}

/**
 * 启动 Nine1Bot
 */
export async function launch(options: LaunchOptions = {}): Promise<LaunchResult> {
  // 查找或使用指定的配置文件
  let configPath = options.configPath
  if (!configPath) {
    configPath = await findConfigPath() || getDefaultConfigPath()
  }

  // 加载配置（使用指定的配置路径）
  const config = await loadConfig(configPath)

  // 合并命令行选项
  const serverConfig = {
    ...config.server,
    port: options.port ?? config.server.port,
    hostname: options.hostname ?? config.server.hostname,
  }

  const enableTunnel = options.tunnel ?? config.tunnel.enabled

  // 1. 启动服务器
  const server = await startServer({
    server: serverConfig,
    auth: config.auth,
    configPath,
    fullConfig: config,
  })

  const localUrl = server.url || `http://${serverConfig.hostname}:${serverConfig.port}`

  let feishu: FeishuServiceHandle | undefined
  if (config.feishu?.enabled) {
    feishu = await startFeishuService(config.feishu, {
      localUrl,
      auth: config.auth,
    })
  }

  // 2. 创建隧道（如果启用）
  let tunnel: TunnelManager | undefined
  let publicUrl: string | undefined

  if (enableTunnel) {
    // 安全警告：隧道会将服务暴露到公网
    if (!config.auth?.enabled) {
      console.warn('\n⚠️  WARNING: Tunnel enabled without password protection!')
      console.warn('   Your Nine1Bot instance will be publicly accessible without authentication.')
      console.warn('   Consider enabling auth in your config for security.\n')
    }
    try {
      tunnel = await createTunnel(config.tunnel)
      publicUrl = await tunnel.start(server.port)
    } catch (error: any) {
      console.warn(`Failed to create tunnel: ${error.message}`)
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
    feishu,
    localUrl,
    publicUrl,
    configPath,
  }
}

/**
 * 停止 Nine1Bot
 */
export async function shutdown(result: LaunchResult): Promise<void> {
  // 停止隧道
  if (result.tunnel) {
    try {
      await result.tunnel.stop()
    } catch {
      // 忽略停止隧道时的错误
    }
  }

  if (result.feishu) {
    try {
      await result.feishu.stop()
    } catch {
      // 忽略停止飞书服务时的错误
    }
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
