import { resolve, dirname, basename } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import type { ServerConfig, AuthConfig, Nine1BotConfig } from '../config/schema'
import { getInstallDir, getGlobalSkillsDir, getAuthPath, getGlobalConfigDir, getMcpAuthPath, getPlatformSecretsPath, getProjectEnvDir } from '../config/loader'
import { getGlobalPreferencesPath } from '../preferences'
import { registerBuiltinPlatformAdapters } from '../platform/builtin'
import { FilePlatformSecretStore } from '../platform/secrets'
import { sanitizeOpencodeConfig } from '../engine/opencode-runtime'
// 静态导入 OpenCode 服务器（编译时打包）
import { Server as OpencodeServer } from '../../../../opencode/packages/opencode/src/server/server'
import { BridgeServer } from '../../../browser-mcp-server/src/bridge/server'
import type { BridgeServer as OpencodeBridgeServer } from '../../../../opencode/packages/opencode/src/browser/bridge'
import { clearBridgeServer, setBridgeServer } from '../../../../opencode/packages/opencode/src/browser/bridge'

/**
 * 判断是否是发行版模式
 */
function isReleaseMode(): boolean {
  const dirName = basename(dirname(process.execPath))
  return dirName.startsWith('nine1bot-')
}

/**
 * 获取内置 skills 目录路径
 * - 发行版模式：installDir/skills
 * - 开发模式：installDir/packages/nine1bot/skills
 */
function getBuiltinSkillsDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, isReleaseMode() ? 'skills' : 'packages/nine1bot/skills')
}

/**
 * 获取 web 资源目录路径
 * - 发行版模式：installDir/web/dist
 * - 开发模式：installDir/web/dist
 */
function getWebDistDir(): string {
  const installDir = getInstallDir()
  return resolve(installDir, 'web/dist')
}

export interface ServerInstance {
  url: string
  hostname: string
  port: number
  stop: () => Promise<void>
}

export interface StartServerOptions {
  server: ServerConfig
  auth: AuthConfig
  configPath: string
  fullConfig: Nine1BotConfig
}

function generateBrowserInstanceId(): string {
  return `browser_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function getBrowserServerOrigin(hostname: string, port: number): string {
  const url = new URL('http://127.0.0.1')
  const normalizedHostname = !hostname || hostname === '0.0.0.0'
    ? '127.0.0.1'
    : hostname === '::'
      ? '::1'
      : hostname
  url.hostname = normalizedHostname
  url.port = String(port)
  return url.toString().replace(/\/$/, '')
}

function toOpencodeBridgeServer(bridge: BridgeServer): OpencodeBridgeServer {
  return bridge as unknown as OpencodeBridgeServer
}

/**
 * 生成 opencode 兼容的配置文件
 * 过滤掉 nine1bot 特有的字段
 */
async function generateOpencodeConfig(config: Nine1BotConfig): Promise<string> {
  const { config: opencodeConfig } = sanitizeOpencodeConfig(config)

  // 写入临时文件（设置安全权限，仅当前用户可读写）
  const tempDir = resolve(tmpdir(), 'nine1bot')
  await mkdir(tempDir, { recursive: true, mode: 0o700 })
  const tempConfigPath = resolve(tempDir, 'opencode.config.json')
  await writeFile(tempConfigPath, JSON.stringify(opencodeConfig, null, 2), { mode: 0o600 })

  return tempConfigPath
}

/**
 * 启动 OpenCode 服务器
 */
export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, fullConfig } = options
  const installDir = getInstallDir()

  // 生成 opencode 兼容的配置文件（过滤掉 nine1bot 特有字段）
  const opencodeConfigPath = await generateOpencodeConfig(fullConfig)

  // 设置环境变量
  process.env.OPENCODE_CONFIG = opencodeConfigPath
  process.env.OPENCODE_DISABLE_PLUGIN_DEPENDENCY_INSTALL = 'true'

  // 配置隔离：禁用全局或项目配置
  const isolation = fullConfig.isolation || {}
  if (isolation.disableGlobalConfig) {
    process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
  }
  if (isolation.disableProjectConfig) {
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
  }
  // 如果不继承 opencode 配置，禁用 opencode 的全局和项目配置
  if (isolation.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
    process.env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
  }

  // 如果启用了认证，设置密码
  if (auth.enabled && auth.password) {
    process.env.OPENCODE_SERVER_PASSWORD = auth.password
    process.env.OPENCODE_SERVER_USERNAME = 'nine1bot'
  }

  // Skills 配置：设置 Nine1Bot skills 目录
  process.env.NINE1BOT_SKILLS_DIR = getGlobalSkillsDir()
  // 设置内置 skills 目录（包含 /remember 等内置技能）
  process.env.NINE1BOT_BUILTIN_SKILLS_DIR = getBuiltinSkillsDir()
  const skills = fullConfig.skills || {}
  if (skills.inheritClaudeCode === false) {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'true'
  }
  if (skills.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_SKILLS = 'true'
  }

  // MCP 配置：继承控制
  const mcpConfig = fullConfig.mcp as any || {}
  if (mcpConfig.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_MCP = 'true'
  }
  if (mcpConfig.inheritClaudeCode === false) {
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_MCP = 'true'
  }

  // 设置配置文件路径，供 MCP 热更新使用
  process.env.NINE1BOT_CONFIG_PATH = options.configPath

  // Provider 认证配置：继承控制

  // 设置 Nine1Bot 独立的认证存储路径
  await mkdir(getGlobalConfigDir(), { recursive: true })
  process.env.NINE1BOT_AUTH_PATH = getAuthPath()
  process.env.NINE1BOT_MCP_AUTH_PATH = getMcpAuthPath()
  const platformSecretsPath = getPlatformSecretsPath()
  await mkdir(dirname(platformSecretsPath), { recursive: true, mode: 0o700 })
  process.env.NINE1BOT_PLATFORM_SECRETS_PATH = platformSecretsPath
  await mkdir(getProjectEnvDir(), { recursive: true })
  process.env.NINE1BOT_PROJECT_ENV_DIR = getProjectEnvDir()

  // 设置偏好模块路径标志（仅用于检测 Nine1Bot 环境）
  process.env.NINE1BOT_PREFERENCES_MODULE = 'nine1bot'

  // 设置偏好文件路径（由 instruction.ts 定时读取）
  process.env.NINE1BOT_PREFERENCES_PATH = getGlobalPreferencesPath()

  // 设置项目目录（用于 opencode 的默认工作目录）
  // 注意：NINE1BOT_PROJECT_DIR 应该在 index.ts 入口处就设置好了
  // 这里只是一个后备方案
  if (!process.env.NINE1BOT_PROJECT_DIR) {
    process.env.NINE1BOT_PROJECT_DIR = process.cwd()
  }

  // 设置 web 资源目录（供 OpenCode server 提供静态文件）
  process.env.NINE1BOT_WEB_DIR = getWebDistDir()

  // 注册 Nine1Bot 产品层平台适配器。Runtime core 只感知通用 registry，
  // 不直接依赖 GitLab 等第三方平台语义。
  registerBuiltinPlatformAdapters({
    config: fullConfig.platforms,
    secrets: new FilePlatformSecretStore(platformSecretsPath),
  })

  // 设置捆绑的 ripgrep 路径（发行版中 bin/rg）
  const rgPath = resolve(installDir, 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')
  process.env.OPENCODE_RIPGREP_PATH = rgPath

  // 初始化浏览器 Bridge（如果启用）
  // 必须在 OpencodeServer.listen() 之前完成，因为路由在 listen 时挂载
  let bridgeServer: BridgeServer | undefined
  const browserConfig = (fullConfig as any).browser
  clearBridgeServer()
  if (browserConfig?.enabled) {
    try {
      const serverOrigin = getBrowserServerOrigin(server.hostname, server.port)
      bridgeServer = new BridgeServer({
        cdpPort: browserConfig.cdpPort ?? 9222,
        autoLaunch: browserConfig.autoLaunch ?? true,
        headless: browserConfig.headless ?? false,
        serverOrigin,
        instanceId: generateBrowserInstanceId(),
      })
      await bridgeServer.start()
      setBridgeServer(toOpencodeBridgeServer(bridgeServer))
      console.log(`[Nine1Bot] Browser control enabled at ${serverOrigin}/browser/`)
    } catch (error: any) {
      console.warn(`[Nine1Bot] Failed to initialize browser bridge: ${error.message}`)
    }
  }

  // 使用静态导入的 OpenCode 服务器启动
  const serverInstance = await OpencodeServer.listen({
    port: server.port,
    hostname: server.hostname,
    cors: [],
  })

  return {
    url: serverInstance.url.toString(),
    hostname: serverInstance.hostname ?? server.hostname,
    port: serverInstance.port ?? server.port,
    stop: async () => {
      let stopError: unknown

      if (bridgeServer) {
        try {
          await bridgeServer.stop()
        } catch (error) {
          stopError = error
        } finally {
          clearBridgeServer()
        }
      }

      try {
        await serverInstance.stop(true)
      } catch (error) {
        stopError ??= error
      }

      if (stopError) {
        throw stopError
      }
    },
  }
}
