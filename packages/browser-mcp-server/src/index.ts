// Core layer - CDP, Chrome, Extension Relay
export * from './core/cdp'
export * from './core/chrome'
export * from './core/extension-relay'
export * from './core/types'

// Bridge layer - HTTP server wrapping core
export { BridgeServer } from './bridge/server'
export type { BridgeServerOptions, BridgeServerState } from './bridge/server'

// Bridge client - connects to existing bridge via HTTP
export { BridgeClient } from './bridge/client'
export type { BridgeClientOptions } from './bridge/client'

// MCP layer - MCP server wrapping bridge
export { createBrowserMcpServer } from './mcp/server'
export type { BrowserMcpServerOptions, BrowserBackend } from './mcp/server'
export { TOOL_DEFINITIONS } from './mcp/tools'
