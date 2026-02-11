#!/usr/bin/env bun
// 在程序最开始保存原始工作目录（在任何模块加载之前）
// 这确保了用户运行 nine1bot 命令时的目录被正确记录
if (!process.env.NINE1BOT_PROJECT_DIR) {
  process.env.NINE1BOT_PROJECT_DIR = process.cwd()
}

// 禁用 OpenCode 默认插件（必须在导入 OpenCode 模块之前设置）
// 这些插件依赖 @openauthjs/openauth，在编译后的二进制中无法正确解析
process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'

// 全局错误兜底：防止未捕获的 Promise rejection 导致服务崩溃
process.on("unhandledRejection", (e) => {
  console.error("[nine1bot] unhandled rejection:", e instanceof Error ? e.message : e)
})

process.on("uncaughtException", (e) => {
  console.error("[nine1bot] uncaught exception:", e instanceof Error ? e.message : e)
})

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { UI } from './cli/ui'
import { StartCommand, startHandler } from './cli/cmd/start'
import { SetupCommand } from './cli/cmd/setup'
import { ConfigCommand } from './cli/cmd/config'

const VERSION = '1.0.0'

async function main() {
  const cli = yargs(hideBin(process.argv))
    .scriptName('nine1bot')
    .usage('\n' + UI.logo() + '\nUsage: $0 [command] [options]')
    .wrap(100)
    .help('help')
    .alias('help', '?')
    .version('version', 'Show version number', VERSION)
    .alias('version', 'v')

    // Commands
    .command(StartCommand)
    .command(SetupCommand)
    .command(ConfigCommand)

    // Default command (run start)
    .command(
      '$0',
      'Start Nine1Bot (default)',
      StartCommand.builder,
      startHandler
    )

    // Strict mode
    .strict()

    // Error handling
    .fail((msg, err, yargs) => {
      if (err) {
        if (err instanceof UI.CancelledError) {
          process.exit(0)
        }
        UI.error(err.message)
        process.exit(1)
      }
      if (msg) {
        console.error(msg)
        console.error()
        yargs.showHelp()
        process.exit(1)
      }
    })

  // Parse and execute
  await cli.parse()
}

// Run
main().catch((error) => {
  if (error instanceof UI.CancelledError) {
    process.exit(0)
  }
  UI.error(error.message)
  process.exit(1)
})
