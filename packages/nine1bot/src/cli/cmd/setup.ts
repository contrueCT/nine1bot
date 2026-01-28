import * as prompts from '@clack/prompts'
import { UI } from '../ui'
import { saveConfig, configExists, getDefaultConfigPath } from '../../config/loader'
import type { Nine1BotConfig } from '../../config/schema'

/**
 * 检查是否需要运行 setup（首次运行）
 */
export async function checkFirstRun(): Promise<boolean> {
  return !(await configExists())
}

/**
 * 首次运行时的提示
 */
export async function promptFirstRun(): Promise<boolean> {
  UI.empty()
  UI.printLogo()

  const shouldSetup = await prompts.confirm({
    message: 'Welcome to Nine1Bot! Would you like to run the setup wizard?',
    initialValue: true,
  })

  if (prompts.isCancel(shouldSetup)) {
    throw new UI.CancelledError()
  }

  return shouldSetup
}

/**
 * 运行配置向导
 */
export async function runSetup(): Promise<void> {
  UI.empty()
  prompts.intro('Nine1Bot Setup Wizard')

  const config: Partial<Nine1BotConfig> = {
    server: { port: 4096, hostname: '127.0.0.1', openBrowser: true },
    auth: { enabled: false },
    tunnel: { enabled: false, provider: 'ngrok' },
  }

  // Step 1: Server 配置
  const serverPort = await prompts.text({
    message: 'Server port',
    placeholder: '4096',
    initialValue: '4096',
    validate: (value) => {
      const port = parseInt(value || '4096')
      if (isNaN(port) || port < 1 || port > 65535) {
        return 'Please enter a valid port number (1-65535)'
      }
    },
  })

  if (prompts.isCancel(serverPort)) {
    throw new UI.CancelledError()
  }

  config.server!.port = parseInt(serverPort || '4096')

  // Step 2: 认证配置
  const enableAuth = await prompts.confirm({
    message: 'Enable password protection?',
    initialValue: false,
  })

  if (prompts.isCancel(enableAuth)) {
    throw new UI.CancelledError()
  }

  if (enableAuth) {
    const password = await prompts.password({
      message: 'Set a password for web access',
      validate: (value) => {
        if (!value || value.length < 4) {
          return 'Password must be at least 4 characters'
        }
      },
    })

    if (prompts.isCancel(password)) {
      throw new UI.CancelledError()
    }

    config.auth = { enabled: true, password }
  }

  // Step 3: 隧道配置
  const setupTunnel = await prompts.confirm({
    message: 'Set up tunnel for public access?',
    initialValue: false,
  })

  if (prompts.isCancel(setupTunnel)) {
    throw new UI.CancelledError()
  }

  if (setupTunnel) {
    const tunnelProvider = await prompts.select({
      message: 'Select tunnel provider',
      options: [
        { value: 'ngrok', label: 'ngrok (International)', hint: 'https://ngrok.com' },
        { value: 'natapp', label: 'NATAPP (China)', hint: 'https://natapp.cn' },
      ],
    })

    if (prompts.isCancel(tunnelProvider)) {
      throw new UI.CancelledError()
    }

    config.tunnel!.provider = tunnelProvider as 'ngrok' | 'natapp'
    config.tunnel!.enabled = true

    if (tunnelProvider === 'ngrok') {
      prompts.log.info('Get your ngrok authtoken from https://dashboard.ngrok.com/authtokens')

      const ngrokToken = await prompts.text({
        message: 'ngrok authtoken',
        placeholder: 'paste your authtoken here',
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Authtoken is required'
          }
        },
      })

      if (prompts.isCancel(ngrokToken)) {
        throw new UI.CancelledError()
      }

      config.tunnel!.ngrok = { authToken: ngrokToken }
    } else if (tunnelProvider === 'natapp') {
      prompts.log.info('Get your NATAPP authtoken from https://natapp.cn')
      prompts.log.info('You also need to download the NATAPP client and add it to PATH')

      const natappToken = await prompts.text({
        message: 'NATAPP authtoken',
        placeholder: 'paste your authtoken here',
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return 'Authtoken is required'
          }
        },
      })

      if (prompts.isCancel(natappToken)) {
        throw new UI.CancelledError()
      }

      config.tunnel!.natapp = { authToken: natappToken }
    }
  }

  // Step 4: AI Provider 配置（可选）
  const setupProvider = await prompts.confirm({
    message: 'Configure an AI provider now?',
    initialValue: true,
  })

  if (!prompts.isCancel(setupProvider) && setupProvider) {
    const provider = await prompts.select({
      message: 'Select AI provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI (ChatGPT)' },
        { value: 'openrouter', label: 'OpenRouter' },
        { value: 'google', label: 'Google (Gemini)' },
        { value: 'skip', label: 'Skip for now' },
      ],
    })

    if (!prompts.isCancel(provider) && provider !== 'skip') {
      const apiKey = await prompts.password({
        message: `Enter your ${provider} API key`,
      })

      if (!prompts.isCancel(apiKey) && apiKey) {
        config.provider = {
          [provider]: {
            options: {
              apiKey: apiKey,
            },
          },
        }

        // 设置默认模型
        const defaultModels: Record<string, string> = {
          anthropic: 'anthropic/claude-3-5-sonnet-20241022',
          openai: 'openai/gpt-4o',
          openrouter: 'openrouter/anthropic/claude-3.5-sonnet',
          google: 'google/gemini-pro',
        }

        if (defaultModels[provider]) {
          config.model = defaultModels[provider]
        }

        prompts.log.success(`${provider} configured successfully`)
      }
    }
  }

  // 保存配置
  const spinner = prompts.spinner()
  spinner.start('Saving configuration...')

  try {
    const configPath = getDefaultConfigPath()
    await saveConfig(config, configPath)
    spinner.stop(`Configuration saved to ${configPath}`)
  } catch (error: any) {
    spinner.stop(`Failed to save configuration: ${error.message}`)
    throw error
  }

  UI.empty()
  prompts.outro("Setup complete! Run 'nine1bot' to start.")
}

/**
 * Setup 命令定义
 */
export const SetupCommand = {
  command: 'setup',
  describe: 'Run the setup wizard',
  handler: async () => {
    try {
      await runSetup()
    } catch (error) {
      if (error instanceof UI.CancelledError) {
        prompts.outro('Setup cancelled.')
        process.exit(0)
      }
      throw error
    }
  },
}
