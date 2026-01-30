import { resolve, dirname } from 'path'
import { writeFile, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { spawn as spawnChild, type ChildProcess } from 'child_process'
import type { ServerConfig, AuthConfig, Nine1BotConfig } from '../config/schema'
import { getInstallDir, getGlobalSkillsDir, getAuthPath, getGlobalConfigDir } from '../config/loader'
import { getGlobalPreferencesPath } from '../preferences'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/**
 * 跨平台杀死进程
 */
async function killProcess(proc: ChildProcess): Promise<void> {
  if (!proc.pid) return

  if (process.platform === 'win32') {
    // Windows: 使用 taskkill 强制终止进程树
    return new Promise((resolve) => {
      const killer = spawnChild('taskkill', ['/pid', String(proc.pid), '/f', '/t'], {
        stdio: 'ignore',
      })
      killer.on('exit', () => resolve())
      killer.on('error', () => resolve())
    })
  } else {
    // Unix: 发送 SIGTERM，如果进程未退出则发送 SIGKILL
    proc.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!proc.killed) {
      proc.kill('SIGKILL')
    }
  }
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

/**
 * Nine1Bot 特有的配置字段（需要从 opencode 配置中过滤掉）
 */
const NINE1BOT_ONLY_FIELDS = ['server', 'auth', 'tunnel', 'isolation', 'skills']

/**
 * 生成 opencode 兼容的配置文件
 * 过滤掉 nine1bot 特有的字段
 */
async function generateOpencodeConfig(config: Nine1BotConfig): Promise<string> {
  const opencodeConfig: Record<string, any> = {}

  for (const [key, value] of Object.entries(config)) {
    if (!NINE1BOT_ONLY_FIELDS.includes(key)) {
      // 特殊处理 server 字段：只保留 opencode 认识的字段
      if (key === 'server') {
        const { openBrowser, ...rest } = value as any
        if (Object.keys(rest).length > 0) {
          opencodeConfig[key] = rest
        }
      } else {
        opencodeConfig[key] = value
      }
    }
  }

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
  process.env.NINE1BOT_BUILTIN_SKILLS_DIR = resolve(installDir, 'packages/nine1bot/skills')
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
  const providerConfig = fullConfig.provider as any || {}
  if (providerConfig.inheritOpencode === false) {
    process.env.OPENCODE_DISABLE_OPENCODE_AUTH = 'true'
  }

  // 设置 Nine1Bot 独立的认证存储路径
  await mkdir(getGlobalConfigDir(), { recursive: true })
  process.env.NINE1BOT_AUTH_PATH = getAuthPath()

  // 设置偏好模块路径，让 OpenCode 可以动态加载
  const preferencesModulePath = resolve(installDir, 'packages/nine1bot/src/preferences/index.ts')
  process.env.NINE1BOT_PREFERENCES_MODULE = preferencesModulePath

  // 设置偏好文件路径（由 instruction.ts 定时读取）
  process.env.NINE1BOT_PREFERENCES_PATH = getGlobalPreferencesPath()

  // 动态导入 opencode 服务器模块
  // 使用安装目录的绝对路径
  const opencodeServerPath = resolve(installDir, 'opencode/packages/opencode/src/server/server.ts')

  try {
    // 尝试导入 opencode 服务器
    const { Server } = await import(opencodeServerPath)

    const serverInstance = await Server.listen({
      port: server.port,
      hostname: server.hostname,
      cors: [],
    })

    return {
      url: serverInstance.url,
      hostname: serverInstance.hostname,
      port: serverInstance.port,
      stop: async () => {
        // OpenCode 服务器的停止逻辑
        serverInstance.server?.stop?.()
      },
    }
  } catch (error: any) {
    // 如果直接导入失败，尝试使用子进程启动
    console.warn('Direct import failed, falling back to subprocess:', error.message)
    return startServerProcess(options)
  }
}

/**
 * 使用子进程启动服务器（备用方案）
 */
async function startServerProcess(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, fullConfig } = options

  // 生成 opencode 兼容的配置文件
  const opencodeConfigPath = await generateOpencodeConfig(fullConfig)

  // 确保认证目录存在（必须在 Promise 之前 await）
  await mkdir(getGlobalConfigDir(), { recursive: true })

  return new Promise((resolvePromise, rejectPromise) => {
    const env: Record<string, string | undefined> = {
      ...process.env,
      OPENCODE_CONFIG: opencodeConfigPath,
    }

    // 配置隔离：禁用全局或项目配置
    const isolation = fullConfig.isolation || {}
    if (isolation.disableGlobalConfig) {
      env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
    }
    if (isolation.disableProjectConfig) {
      env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
    }
    // 如果不继承 opencode 配置，禁用 opencode 的全局和项目配置
    if (isolation.inheritOpencode === false) {
      env.OPENCODE_DISABLE_GLOBAL_CONFIG = 'true'
      env.OPENCODE_DISABLE_PROJECT_CONFIG = 'true'
    }

    if (auth.enabled && auth.password) {
      env.OPENCODE_SERVER_PASSWORD = auth.password
      env.OPENCODE_SERVER_USERNAME = 'nine1bot'
    }

    // Skills 配置：设置 Nine1Bot skills 目录
    env.NINE1BOT_SKILLS_DIR = getGlobalSkillsDir()
    // 设置内置 skills 目录
    env.NINE1BOT_BUILTIN_SKILLS_DIR = resolve(installDir, 'packages/nine1bot/skills')
    const skills = fullConfig.skills || {}
    if (skills.inheritClaudeCode === false) {
      env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'true'
    }
    if (skills.inheritOpencode === false) {
      env.OPENCODE_DISABLE_OPENCODE_SKILLS = 'true'
    }

    // MCP 配置：继承控制
    const mcpConfig = fullConfig.mcp as any || {}
    if (mcpConfig.inheritOpencode === false) {
      env.OPENCODE_DISABLE_OPENCODE_MCP = 'true'
    }
    if (mcpConfig.inheritClaudeCode === false) {
      env.OPENCODE_DISABLE_CLAUDE_CODE_MCP = 'true'
    }

    // 设置配置文件路径，供 MCP 热更新使用
    env.NINE1BOT_CONFIG_PATH = options.configPath

    // Provider 认证配置：继承控制
    const providerConfig = fullConfig.provider as any || {}
    if (providerConfig.inheritOpencode === false) {
      env.OPENCODE_DISABLE_OPENCODE_AUTH = 'true'
    }

    // 设置 Nine1Bot 独立的认证存储路径
    env.NINE1BOT_AUTH_PATH = getAuthPath()

    // 使用安装目录的绝对路径
    const installDir = getInstallDir()

    // 设置偏好模块路径
    const preferencesModulePath = resolve(installDir, 'packages/nine1bot/src/preferences/index.ts')
    env.NINE1BOT_PREFERENCES_MODULE = preferencesModulePath

    // 设置偏好文件路径（由 instruction.ts 定时读取）
    env.NINE1BOT_PREFERENCES_PATH = getGlobalPreferencesPath()
    const opencodeDir = resolve(installDir, 'opencode/packages/opencode')
    const opencodeEntry = resolve(opencodeDir, 'src/index.ts')
    const args = ['run', opencodeEntry, 'serve', '--port', String(server.port)]

    if (server.hostname !== '127.0.0.1') {
      args.push('--hostname', server.hostname)
    }

    // cwd 必须设置为 opencode 包目录，以便 bunfig.toml 的 preload 配置生效
    const proc = spawnChild('bun', args, {
      cwd: opencodeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let resolved = false
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    // 清理函数
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      proc.stdout?.removeAllListeners('data')
      proc.stderr?.removeAllListeners('data')
      proc.removeAllListeners('error')
      proc.removeAllListeners('close')
    }

    // 杀死进程并拒绝 Promise
    const killAndReject = (error: Error) => {
      if (!resolved) {
        resolved = true
        cleanup()
        try {
          proc.kill('SIGTERM')
        } catch {
          // 忽略杀死进程时的错误
        }
        rejectPromise(error)
      }
    }

    const handleOutput = (data: Buffer) => {
      output += data.toString()
      console.log(data.toString())

      // 检测服务器启动成功
      const urlMatch = output.match(/Local:\s*(https?:\/\/[^\s]+)/)
      if (urlMatch && !resolved) {
        resolved = true
        cleanup()
        resolvePromise({
          url: urlMatch[1],
          hostname: server.hostname,
          port: server.port,
          stop: async () => {
            await killProcess(proc)
          },
        })
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('error', (error) => {
      killAndReject(new Error(`Failed to start server: ${error.message}`))
    })

    proc.on('close', (code) => {
      if (!resolved && code !== 0) {
        resolved = true
        cleanup()
        rejectPromise(new Error(`Server exited with code ${code}`))
      }
    })

    // 超时处理
    timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true
        cleanup()
        // 假设服务器已启动（进程仍在运行）
        resolvePromise({
          url: `http://${server.hostname}:${server.port}`,
          hostname: server.hostname,
          port: server.port,
          stop: async () => {
            await killProcess(proc)
          },
        })
      }
    }, 10000)
  })
}
