/**
 * MCP 配置热更新模块
 * 定时检测 Nine1Bot 配置文件变化，自动同步 MCP 服务器
 */

import { Log } from "../util/log"

const log = Log.create({ service: "mcp-hot-reload" })

// 缓存变量
let lastConfigHash: string = ''
let lastCheckTime: number = 0
const MCP_CONFIG_CHECK_TTL = 30000 // 30秒

/**
 * 检查并重新加载 MCP 配置
 * 在 MCP.status() 调用时触发
 */
export async function checkAndReloadMcpConfig(): Promise<void> {
  const configPath = process.env.NINE1BOT_CONFIG_PATH
  if (!configPath) return // 非 Nine1Bot 环境，跳过

  const now = Date.now()
  if (now - lastCheckTime < MCP_CONFIG_CHECK_TTL) return
  lastCheckTime = now

  try {
    const file = Bun.file(configPath)
    if (!await file.exists()) return

    const content = await file.text()
    // 支持 JSONC 格式（移除注释）
    const jsonContent = content
      .replace(/\/\/.*$/gm, '') // 移除单行注释
      .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
    const config = JSON.parse(jsonContent)
    const mcpConfig = config?.mcp || {}

    // 过滤掉继承控制字段，只保留 MCP 服务器配置
    const { inheritOpencode, inheritClaudeCode, ...servers } = mcpConfig

    // 计算配置哈希，快速判断是否变化
    const configHash = JSON.stringify(servers)
    if (configHash === lastConfigHash) return

    // 首次加载时只记录哈希，不进行同步（避免启动时重复连接）
    if (lastConfigHash === '') {
      lastConfigHash = configHash
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
 * 同步 MCP 服务器状态
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
      } catch (error) {
        log.error("Failed to add MCP server", { name, error })
      }
    }
  }

  // 移除已删除的 MCP 服务器
  for (const name of currentNames) {
    if (!newNames.has(name)) {
      log.info("Removing MCP server", { name })
      try {
        await MCP.remove(name)
      } catch (error) {
        log.error("Failed to remove MCP server", { name, error })
      }
    }
  }
}
