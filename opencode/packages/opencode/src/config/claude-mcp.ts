import { readFile } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import type { Config } from "./config"
import { Log } from "../util/log"

const log = Log.create({ service: "claude-mcp" })

/**
 * Get the Claude Desktop config file path based on platform
 */
function getClaudeConfigPath(): string {
  const home = homedir()

  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
  } else if (process.platform === "win32") {
    return join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
  } else {
    // Linux
    return join(home, ".config", "Claude", "claude_desktop_config.json")
  }
}

interface ClaudeMcpServer {
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface ClaudeConfig {
  mcpServers?: Record<string, ClaudeMcpServer>
}

/**
 * Load Claude Code MCP configuration and convert to OpenCode format
 */
export async function loadClaudeCodeMcp(): Promise<Record<string, Config.Mcp>> {
  const configPath = getClaudeConfigPath()

  if (!existsSync(configPath)) {
    log.debug("Claude Desktop config not found", { path: configPath })
    return {}
  }

  try {
    const content = await readFile(configPath, "utf-8")
    const config: ClaudeConfig = JSON.parse(content)

    if (!config.mcpServers) {
      log.debug("No MCP servers in Claude Desktop config")
      return {}
    }

    // Convert Claude format to OpenCode format
    const result: Record<string, Config.Mcp> = {}

    for (const [name, server] of Object.entries(config.mcpServers)) {
      result[name] = {
        type: "local",
        command: [server.command, ...(server.args || [])],
        environment: server.env || {},
        enabled: true,
      }
    }

    log.info("Loaded Claude Desktop MCP servers", { count: Object.keys(result).length })
    return result
  } catch (error) {
    log.error("Failed to load Claude Desktop MCP config", { path: configPath, error })
    return {}
  }
}
