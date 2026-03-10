#!/usr/bin/env bun
/**
 * CLI entry point for browser-mcp-server
 *
 * Usage:
 *   npx @nine1bot/browser-mcp-server
 *
 * Environment variables:
 *   BRIDGE_URL   - Connect to an existing Bridge Server (client mode)
 *                  e.g. BRIDGE_URL=http://127.0.0.1:18793
 *
 *   --- Standalone mode (when BRIDGE_URL is not set) ---
 *   BRIDGE_PORT  - Bridge HTTP server port (default: 18791)
 *   BRIDGE_HOST  - Bridge HTTP server host (default: 127.0.0.1)
 *   CDP_PORT     - Chrome CDP debugging port (default: 9222)
 *   AUTO_LAUNCH  - Auto-launch Chrome if not running (default: true)
 *   HEADLESS     - Run Chrome in headless mode (default: false)
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createBrowserMcpServer } from '../src/mcp/server'

const bridgeUrl = process.env.BRIDGE_URL
const bridgePort = parseInt(process.env.BRIDGE_PORT || '18791')
const bridgeHost = process.env.BRIDGE_HOST || '127.0.0.1'
const cdpPort = parseInt(process.env.CDP_PORT || '9222')
const autoLaunch = process.env.AUTO_LAUNCH !== 'false'
const headless = process.env.HEADLESS === 'true'

const isClientMode = Boolean(bridgeUrl)

if (isClientMode) {
  console.error(`[browser-mcp-server] Client mode: connecting to ${bridgeUrl}`)
} else {
  console.error(`[browser-mcp-server] Standalone mode: starting Bridge on port ${bridgePort}`)
}

const { mcpServer, backend } = createBrowserMcpServer({
  bridgeUrl,
  port: bridgePort,
  host: bridgeHost,
  cdpPort,
  autoLaunch,
  headless,
})

// Start the backend (BridgeServer starts HTTP, BridgeClient verifies connection)
await backend.start()

// Connect MCP server via stdio
const transport = new StdioServerTransport()
await mcpServer.connect(transport)

console.error('[browser-mcp-server] MCP server connected via stdio')

// Graceful shutdown
process.on('SIGINT', async () => {
  await backend.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await backend.stop()
  process.exit(0)
})
