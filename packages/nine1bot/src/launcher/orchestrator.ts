import open from 'open'
import type { Nine1BotConfig } from '../config/schema'
import { loadConfig, findConfigPath, getDefaultConfigPath } from '../config/loader'
import { startServer, type ServerInstance } from './server'
import { createTunnel, type TunnelManager } from '../tunnel'

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
  // 查找或使用指定的配置文件
  let configPath = options.configPath
  if (!configPath) {
    configPath = await findConfigPath() || getDefaultConfigPath()
  }

  // 加载配置
  const config = await loadConfig()

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
  })

  const localUrl = server.url || `http://${serverConfig.hostname}:${serverConfig.port}`

  // 2. 创建隧道（如果启用）
  let tunnel: TunnelManager | undefined
  let publicUrl: string | undefined

  if (enableTunnel) {
    try {
      tunnel = await createTunnel(config.tunnel)
      publicUrl = await tunnel.start(serverConfig.port)
    } catch (error: any) {
      console.warn(`Failed to create tunnel: ${error.message}`)
    }
  }

  // 3. 打开浏览器（如果启用）
  if (!options.noBrowser && config.server.openBrowser) {
    try {
      await open(localUrl)
    } catch {
      // 忽略打开浏览器失败
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
  // 停止隧道
  if (result.tunnel) {
    try {
      await result.tunnel.stop()
    } catch {
      // 忽略停止隧道时的错误
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
  const handleExit = async () => {
    console.log('\nShutting down...')
    await shutdown(result)
    process.exit(0)
  }

  process.on('SIGINT', handleExit)
  process.on('SIGTERM', handleExit)
}
