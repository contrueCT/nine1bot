#!/usr/bin/env bun
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
