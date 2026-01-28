import type { Argv, ArgumentsCamelCase } from 'yargs'
import { UI } from '../ui'
import { loadConfig, findConfigPath, getDefaultConfigPath, saveConfig } from '../../config/loader'
import type { Nine1BotConfig } from '../../config/schema'

/**
 * 显示配置
 */
async function showConfig(): Promise<void> {
  const configPath = await findConfigPath()

  if (!configPath) {
    UI.warn('No configuration file found.')
    UI.info(`Run 'nine1bot setup' to create one, or create ${getDefaultConfigPath()} manually.`)
    return
  }

  UI.title('Configuration')
  UI.info(`File: ${configPath}`)
  UI.empty()

  const config = await loadConfig()

  // 显示 server 配置
  UI.println('Server:')
  UI.println(`  port:        ${UI.formatConfigValue(config.server.port)}`)
  UI.println(`  hostname:    ${UI.formatConfigValue(config.server.hostname)}`)
  UI.println(`  openBrowser: ${UI.formatConfigValue(config.server.openBrowser)}`)
  UI.empty()

  // 显示 auth 配置
  UI.println('Auth:')
  UI.println(`  enabled:  ${UI.formatConfigValue(config.auth.enabled)}`)
  UI.println(`  password: ${UI.formatConfigValue(config.auth.password ? '***' : undefined)}`)
  UI.empty()

  // 显示 tunnel 配置
  UI.println('Tunnel:')
  UI.println(`  enabled:  ${UI.formatConfigValue(config.tunnel.enabled)}`)
  UI.println(`  provider: ${UI.formatConfigValue(config.tunnel.provider)}`)
  if (config.tunnel.ngrok) {
    UI.println(`  ngrok.authToken: ${UI.formatConfigValue(config.tunnel.ngrok.authToken ? '***' : undefined)}`)
  }
  if (config.tunnel.natapp) {
    UI.println(`  natapp.authToken: ${UI.formatConfigValue(config.tunnel.natapp.authToken ? '***' : undefined)}`)
  }
  UI.empty()

  // 显示 model 配置
  if (config.model) {
    UI.println('Model:')
    UI.println(`  default: ${UI.formatConfigValue(config.model)}`)
    UI.empty()
  }

  // 显示 provider 配置（隐藏 API key）
  if (config.provider && Object.keys(config.provider).length > 0) {
    UI.println('Providers:')
    for (const [name, providerConfig] of Object.entries(config.provider)) {
      const hasApiKey = providerConfig.options?.apiKey ? ' (configured)' : ''
      UI.println(`  ${name}${hasApiKey}`)
    }
    UI.empty()
  }

  // 显示 MCP 配置
  if (config.mcp && Object.keys(config.mcp).length > 0) {
    UI.println('MCP Servers:')
    for (const [name, mcpConfig] of Object.entries(config.mcp)) {
      const type = 'type' in mcpConfig ? mcpConfig.type : 'unknown'
      const enabled = 'enabled' in mcpConfig ? mcpConfig.enabled : true
      UI.println(`  ${name}: ${type} (${enabled ? 'enabled' : 'disabled'})`)
    }
    UI.empty()
  }
}

/**
 * 设置配置值
 */
async function setConfig(key: string, value: string): Promise<void> {
  const configPath = await findConfigPath() || getDefaultConfigPath()

  // 解析键路径，例如 "server.port" -> ["server", "port"]
  const keys = key.split('.')

  // 解析值
  let parsedValue: any = value
  if (value === 'true') parsedValue = true
  else if (value === 'false') parsedValue = false
  else if (/^\d+$/.test(value)) parsedValue = parseInt(value)

  // 构建配置对象
  const config: any = {}
  let current = config
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = {}
    current = current[keys[i]]
  }
  current[keys[keys.length - 1]] = parsedValue

  await saveConfig(config, configPath)
  UI.success(`Set ${key} = ${JSON.stringify(parsedValue)}`)
}

/**
 * 在编辑器中打开配置文件
 */
async function editConfig(): Promise<void> {
  const configPath = await findConfigPath() || getDefaultConfigPath()

  // 尝试使用系统默认编辑器打开
  const { exec } = await import('child_process')
  const { promisify } = await import('util')
  const execAsync = promisify(exec)

  const platform = process.platform

  try {
    if (platform === 'win32') {
      await execAsync(`start "" "${configPath}"`)
    } else if (platform === 'darwin') {
      await execAsync(`open "${configPath}"`)
    } else {
      // Linux - 尝试 xdg-open 或环境变量中的编辑器
      const editor = process.env.EDITOR || 'xdg-open'
      await execAsync(`${editor} "${configPath}"`)
    }
    UI.success(`Opened ${configPath}`)
  } catch {
    UI.info(`Config file: ${configPath}`)
    UI.warn('Could not open editor automatically. Please open the file manually.')
  }
}

/**
 * Config 命令处理器
 */
export const ConfigCommand = {
  command: 'config [action] [key] [value]',
  describe: 'Manage configuration',
  builder: (yargs: Argv) => {
    return yargs
      .positional('action', {
        describe: 'Action to perform',
        choices: ['show', 'set', 'edit'] as const,
        default: 'show' as const,
      })
      .positional('key', {
        describe: 'Configuration key (for set)',
        type: 'string',
      })
      .positional('value', {
        describe: 'Configuration value (for set)',
        type: 'string',
      })
  },
  handler: async (args: ArgumentsCamelCase<{ action: string; key?: string; value?: string }>) => {
    try {
      switch (args.action) {
        case 'show':
          await showConfig()
          break
        case 'set':
          if (!args.key || args.value === undefined) {
            UI.error('Usage: nine1bot config set <key> <value>')
            UI.info('Example: nine1bot config set server.port 8080')
            process.exit(1)
          }
          await setConfig(args.key, args.value)
          break
        case 'edit':
          await editConfig()
          break
        default:
          UI.error(`Unknown action: ${args.action}`)
          process.exit(1)
      }
    } catch (error: any) {
      UI.error(error.message)
      process.exit(1)
    }
  },
}
