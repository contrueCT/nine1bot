/**
 * MCP 配置热更新模块
 * 定时检测 Nine1Bot 配置文件变化，自动同步 MCP 服务器
 */

import { Log } from "../util/log"
import { homedir } from "os"
import { join } from "path"

const log = Log.create({ service: "mcp-hot-reload" })
const LEGACY_BROWSER_MCP_MARKER = "browser-mcp-server"
const LEGACY_BROWSER_BRIDGE_URL_MARKERS = ["127.0.0.1:18793", "localhost:18793"]

// 缓存变量
let lastConfigHash: string = ''
let lastCheckTime: number = 0
let serverConfigHashes: Record<string, string> = {}
const MCP_CONFIG_CHECK_TTL = 30000 // 30秒
let watcherInterval: ReturnType<typeof setInterval> | null = null

/**
 * 获取全局配置文件路径
 */
function getGlobalConfigPath(): string {
  return join(homedir(), '.config', 'nine1bot', 'config.jsonc')
}

function getCommandParts(entry: unknown): string[] {
  const command = (entry as { command?: unknown })?.command
  if (!Array.isArray(command)) return []
  return command.filter((part): part is string => typeof part === "string")
}

function getLegacyBrowserMcpEntry(name: string, entry: unknown) {
  if (!entry || typeof entry !== "object") return null
  if ((entry as { type?: unknown }).type !== "local") return null

  const command = getCommandParts(entry)
  if (!command.some((part) => part.includes(LEGACY_BROWSER_MCP_MARKER))) {
    return null
  }

  const bridgeUrl = typeof (entry as { environment?: Record<string, unknown> }).environment?.BRIDGE_URL === "string"
    ? (entry as { environment?: Record<string, string> }).environment?.BRIDGE_URL
    : undefined

  return { name, bridgeUrl }
}

function isDeprecatedBrowserBridgeUrl(url: string): boolean {
  return LEGACY_BROWSER_BRIDGE_URL_MARKERS.some((marker) => url.includes(marker))
}

function warnAboutLegacyBrowserConfig(
  filePath: string,
  config: Record<string, any>,
  ignoredLegacyBrowserMcp: Array<{ name: string; bridgeUrl?: string }>,
): void {
  if (config.browser?.bridgePort !== undefined) {
    log.warn("browser.bridgePort is deprecated and ignored", { filePath })
  }

  for (const entry of ignoredLegacyBrowserMcp) {
    log.warn("ignoring legacy browser MCP server", {
      filePath,
      name: entry.name,
    })
    if (entry.bridgeUrl && isDeprecatedBrowserBridgeUrl(entry.bridgeUrl)) {
      log.warn("legacy browser MCP bridge URL is deprecated", {
        filePath,
        name: entry.name,
        bridgeUrl: entry.bridgeUrl,
      })
    }
  }

  if (ignoredLegacyBrowserMcp.length > 0 && config.browser?.enabled !== true) {
    log.warn('set "browser.enabled": true to keep browser control enabled', { filePath })
  }
}

/**
 * 启动 MCP 配置文件监听
 * 在 MCP 模块初始化后调用
 */
export function startMcpConfigWatcher(): void {
  if (watcherInterval) return // 已启动

  const projectConfigPath = process.env.NINE1BOT_CONFIG_PATH
  if (!projectConfigPath) return // 非 Nine1Bot 环境，跳过

  const globalConfigPath = getGlobalConfigPath()
  log.info("Starting MCP config watcher", { projectConfigPath, globalConfigPath })

  watcherInterval = setInterval(async () => {
    try {
      await checkAndReloadMcpConfig()
    } catch (error) {
      log.error("Error in MCP config watcher", { error })
    }
  }, MCP_CONFIG_CHECK_TTL)
}

/**
 * 停止 MCP 配置文件监听
 */
export function stopMcpConfigWatcher(): void {
  if (watcherInterval) {
    clearInterval(watcherInterval)
    watcherInterval = null
  }
}

/**
 * 从配置文件加载 MCP 配置
 */
async function loadMcpFromFile(filePath: string): Promise<Record<string, any>> {
  try {
    const file = Bun.file(filePath)
    if (!await file.exists()) return {}

    const content = await file.text()
    // 支持 JSONC 格式（移除注释）
    const jsonContent = content
      .replace(/\/\/.*$/gm, '') // 移除单行注释
      .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    const config = JSON.parse(jsonContent) as Record<string, any>
    const mcpConfig = config?.mcp || {}

    // 过滤掉继承控制字段，只保留 MCP 服务器配置
    const { inheritOpencode, inheritClaudeCode, ...servers } = mcpConfig
    const ignoredLegacyBrowserMcp: Array<{ name: string; bridgeUrl?: string }> = []
    const filteredServers = Object.fromEntries(
      Object.entries(servers).filter(([name, entry]) => {
        const legacyEntry = getLegacyBrowserMcpEntry(name, entry)
        if (!legacyEntry) return true
        ignoredLegacyBrowserMcp.push(legacyEntry)
        return false
      }),
    )

    warnAboutLegacyBrowserConfig(filePath, config, ignoredLegacyBrowserMcp)
    return filteredServers
  } catch {
    return {}
  }
}

/**
 * 检查并重新加载 MCP 配置
 * 支持项目配置和全局配置
 */
export async function checkAndReloadMcpConfig(): Promise<void> {
  const projectConfigPath = process.env.NINE1BOT_CONFIG_PATH
  if (!projectConfigPath) return // 非 Nine1Bot 环境，跳过

  const now = Date.now()
  if (now - lastCheckTime < MCP_CONFIG_CHECK_TTL) return
  lastCheckTime = now

  try {
    // 加载全局配置和项目配置
    const globalConfigPath = getGlobalConfigPath()
    const globalServers = await loadMcpFromFile(globalConfigPath)
    const projectServers = await loadMcpFromFile(projectConfigPath)

    // 合并配置（项目配置优先级更高）
    const servers = { ...globalServers, ...projectServers }

    // 计算配置哈希，快速判断是否变化
    const configHash = JSON.stringify(servers)
    if (configHash === lastConfigHash) return

    // 首次加载时只记录哈希，不进行同步（避免启动时重复连接）
    if (lastConfigHash === '') {
      lastConfigHash = configHash
      // 初始化每个服务器的配置哈希
      for (const [name, cfg] of Object.entries(servers)) {
        serverConfigHashes[name] = JSON.stringify(cfg)
      }
      return
    }

    lastConfigHash = configHash
    log.info("MCP config changed, syncing...")

    // 动态导入 MCP 模块避免循环依赖
    const { MCP } = await import("./index")
    await syncMcpServers(MCP, servers)
  } catch (error) {
    log.error("Failed to reload MCP config", { error })
  }
}

/**
 * 同步 MCP 服务器状态（包括添加、更新、删除）
 */
async function syncMcpServers(
  MCP: typeof import("./index").MCP,
  newConfig: Record<string, any>
): Promise<void> {
  const currentStatus = await MCP.status()
  const currentNames = new Set(Object.keys(currentStatus))
  const newNames = new Set(Object.keys(newConfig))

  // 添加新的 MCP 服务器
  for (const name of newNames) {
    if (!currentNames.has(name)) {
      log.info("Adding MCP server", { name })
      try {
        await MCP.add(name, newConfig[name])
        serverConfigHashes[name] = JSON.stringify(newConfig[name])
      } catch (error) {
        log.error("Failed to add MCP server", { name, error })
      }
    }
  }

  // 更新已修改的 MCP 服务器配置
  for (const name of newNames) {
    if (currentNames.has(name)) {
      const newHash = JSON.stringify(newConfig[name])
      if (serverConfigHashes[name] !== newHash) {
        log.info("Updating MCP server config", { name })
        try {
          await MCP.add(name, newConfig[name]) // MCP.add 会先关闭旧连接
          serverConfigHashes[name] = newHash
        } catch (error) {
          log.error("Failed to update MCP server", { name, error })
        }
      }
    }
  }

  // 移除已删除的 MCP 服务器
  for (const name of currentNames) {
    if (!newNames.has(name)) {
      log.info("Removing MCP server", { name })
      try {
        await MCP.remove(name)
        delete serverConfigHashes[name]
      } catch (error) {
        log.error("Failed to remove MCP server", { name, error })
      }
    }
  }
}
