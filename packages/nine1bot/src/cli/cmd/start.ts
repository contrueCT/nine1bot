import * as prompts from '@clack/prompts'
import type { ArgumentsCamelCase, Argv } from 'yargs'
import { UI } from '../ui'
import { launch, setupGracefulShutdown, type LaunchResult } from '../../launcher/orchestrator'
import { checkFirstRun, promptFirstRun, runSetup } from './setup'

interface StartArgs {
  port?: number
  hostname?: string
  tunnel?: boolean
  'no-browser'?: boolean
}

/**
 * Start 命令处理器
 */
export async function startHandler(args: ArgumentsCamelCase<StartArgs>): Promise<void> {
  // 检查首次运行
  const isFirstRun = await checkFirstRun()
  if (isFirstRun) {
    const shouldSetup = await promptFirstRun()
    if (shouldSetup) {
      await runSetup()
    } else {
      prompts.outro("You can run 'nine1bot setup' anytime to configure.")
    }
  }

  UI.empty()
  UI.printLogo()
  UI.empty()

  const spinner = prompts.spinner()
  spinner.start('Starting Nine1Bot...')

  let result: LaunchResult | undefined

  try {
    result = await launch({
      port: args.port,
      hostname: args.hostname,
      tunnel: args.tunnel,
      noBrowser: args['no-browser'],
    })

    spinner.stop('Nine1Bot is running!')

    // 显示访问地址
    UI.empty()
    UI.title('Access URLs:')
    UI.url('Local', result.localUrl)
    if (result.publicUrl) {
      UI.url('Public', result.publicUrl)
    }
    UI.empty()

    // 显示配置信息
    UI.info(`Config: ${result.configPath}`)
    UI.empty()

    UI.println(`${UI.colors.dim}Press Ctrl+C to stop${UI.colors.reset}`)

    // 设置优雅退出
    setupGracefulShutdown(result)

    // 保持进程运行
    await new Promise(() => {})
  } catch (error: any) {
    spinner.stop('Failed to start')
    UI.error(error.message)
    process.exit(1)
  }
}

/**
 * Start 命令定义
 */
export const StartCommand = {
  command: 'start',
  describe: 'Start Nine1Bot server, web UI, and optional tunnel',
  builder: (yargs: Argv) => {
    return yargs
      .option('port', {
        alias: 'p',
        type: 'number',
        describe: 'Server port',
      })
      .option('hostname', {
        alias: 'h',
        type: 'string',
        describe: 'Server hostname',
      })
      .option('tunnel', {
        alias: 't',
        type: 'boolean',
        describe: 'Enable tunnel (ngrok/natapp)',
      })
      .option('no-browser', {
        type: 'boolean',
        describe: "Don't open browser automatically",
      })
  },
  handler: startHandler,
}
