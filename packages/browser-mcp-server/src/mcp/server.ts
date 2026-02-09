/**
 * MCP Server for browser automation
 * Wraps BridgeServer/BridgeClient methods as MCP tools via @modelcontextprotocol/sdk
 *
 * Two modes:
 * 1. Standalone: creates its own BridgeServer (starts HTTP server + Extension Relay)
 * 2. Client: connects to an existing BridgeServer via HTTP (BridgeClient)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { BridgeServer, type BridgeServerOptions } from '../bridge/server'
import { BridgeClient, type BridgeClientOptions } from '../bridge/client'
import { TOOL_DEFINITIONS } from './tools'
import type { Tab, PageContent, ScreenshotOptions, ExtensionToolResult } from '../core/types'

/** Common interface that both BridgeServer and BridgeClient implement */
export interface BrowserBackend {
  listTabs(): Promise<Tab[]>
  screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; mimeType: string }>
  navigate(tabId: string, url: string): Promise<void>
  click(tabId: string, x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void>
  type(tabId: string, text: string, delay?: number): Promise<void>
  evaluate(tabId: string, expression: string): Promise<unknown>
  getContent(tabId: string): Promise<PageContent>
  callExtensionTool(tabId: string, toolName: string, args?: Record<string, unknown>): Promise<ExtensionToolResult>
  start(): Promise<any>
  stop(): Promise<void>
}

export interface BrowserMcpServerOptions extends BridgeServerOptions {
  /** MCP server name (default: 'browser-mcp-server') */
  name?: string
  /** MCP server version (default: '0.1.0') */
  version?: string
  /** Connect to an existing Bridge Server instead of starting one */
  bridgeUrl?: string
}

/**
 * Create a configured MCP server with browser control tools
 *
 * If `bridgeUrl` is provided, connects to existing Bridge Server (client mode).
 * Otherwise, creates its own BridgeServer (standalone mode).
 */
export function createBrowserMcpServer(options: BrowserMcpServerOptions = {}): {
  mcpServer: McpServer
  backend: BrowserBackend
  /** @deprecated Use `backend` instead */
  bridgeServer: BrowserBackend
} {
  const mcpServer = new McpServer({
    name: options.name ?? 'browser-mcp-server',
    version: options.version ?? '0.1.0',
  })

  // Choose backend: client mode or standalone mode
  const backend: BrowserBackend = options.bridgeUrl
    ? new BridgeClient({ url: options.bridgeUrl })
    : new BridgeServer(options)

  // ---- browser_tabs ----
  mcpServer.tool(
    'browser_tabs',
    TOOL_DEFINITIONS.browser_tabs.description,
    TOOL_DEFINITIONS.browser_tabs.schema.shape,
    async () => {
      const tabs = await backend.listTabs()
      if (tabs.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: 'No browser tabs found. Make sure the Nine1Bot Browser Control extension is installed and connected.',
          }],
        }
      }
      const text = tabs.map(t => `[${t.id}] ${t.title}\n    ${t.url}`).join('\n\n')
      return {
        content: [{ type: 'text' as const, text: `Found ${tabs.length} tab(s):\n\n${text}` }],
      }
    }
  )

  // ---- browser_screenshot ----
  mcpServer.tool(
    'browser_screenshot',
    TOOL_DEFINITIONS.browser_screenshot.description,
    TOOL_DEFINITIONS.browser_screenshot.schema.shape,
    async ({ tabId, fullPage }) => {
      const result = await backend.screenshot(tabId, { fullPage })
      return {
        content: [{
          type: 'image' as const,
          data: result.data,
          mimeType: result.mimeType,
        }],
      }
    }
  )

  // ---- browser_navigate ----
  mcpServer.tool(
    'browser_navigate',
    TOOL_DEFINITIONS.browser_navigate.description,
    TOOL_DEFINITIONS.browser_navigate.schema.shape,
    async ({ tabId, url }) => {
      await backend.navigate(tabId, url)
      return {
        content: [{ type: 'text' as const, text: `Navigated to ${url}` }],
      }
    }
  )

  // ---- browser_click ----
  mcpServer.tool(
    'browser_click',
    TOOL_DEFINITIONS.browser_click.description,
    TOOL_DEFINITIONS.browser_click.schema.shape,
    async ({ tabId, x, y, button, clickCount }) => {
      await backend.click(tabId, x, y, { button: button ?? undefined, clickCount: clickCount ?? undefined })
      return {
        content: [{ type: 'text' as const, text: `Clicked at (${x}, ${y})` }],
      }
    }
  )

  // ---- browser_type ----
  mcpServer.tool(
    'browser_type',
    TOOL_DEFINITIONS.browser_type.description,
    TOOL_DEFINITIONS.browser_type.schema.shape,
    async ({ tabId, text }) => {
      await backend.type(tabId, text)
      return {
        content: [{ type: 'text' as const, text: `Typed ${text.length} character(s)` }],
      }
    }
  )

  // ---- browser_evaluate ----
  mcpServer.tool(
    'browser_evaluate',
    TOOL_DEFINITIONS.browser_evaluate.description,
    TOOL_DEFINITIONS.browser_evaluate.schema.shape,
    async ({ tabId, expression }) => {
      const result = await backend.evaluate(tabId, expression)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) ?? 'undefined' }],
      }
    }
  )

  // ---- browser_content ----
  mcpServer.tool(
    'browser_content',
    TOOL_DEFINITIONS.browser_content.description,
    TOOL_DEFINITIONS.browser_content.schema.shape,
    async ({ tabId }) => {
      const page = await backend.getContent(tabId)
      return {
        content: [{
          type: 'text' as const,
          text: `Title: ${page.title}\nURL: ${page.url}\n\n${page.content.slice(0, 50000)}`,
        }],
      }
    }
  )

  // ==================== Extension-powered tools (CSP-safe) ====================
  // These tools forward to Chrome extension via Extension.callTool protocol.
  // They bypass CSP restrictions because they use content scripts and chrome.debugger API.

  // Helper to forward extension tool calls and map results
  const forwardExtensionTool = (mcpToolName: string, extensionToolName: string) => {
    const def = TOOL_DEFINITIONS[mcpToolName as keyof typeof TOOL_DEFINITIONS]
    mcpServer.tool(
      mcpToolName,
      def.description,
      def.schema.shape,
      async (params: Record<string, unknown>) => {
        const { tabId, ...rest } = params as { tabId: string; [key: string]: unknown }
        const result = await backend.callExtensionTool(tabId, extensionToolName, rest)
        if (result.isError) {
          return {
            content: result.content.map(c => ({
              type: 'text' as const,
              text: c.text || 'Extension tool error',
            })),
            isError: true,
          }
        }
        return {
          content: result.content.map(c => {
            if (c.type === 'image' && c.data) {
              return { type: 'image' as const, data: c.data, mimeType: c.mimeType || 'image/png' }
            }
            return { type: 'text' as const, text: c.text || '' }
          }),
        }
      }
    )
  }

  forwardExtensionTool('browser_read_page', 'read_page')
  forwardExtensionTool('browser_find', 'find')
  forwardExtensionTool('browser_get_text', 'get_page_text')
  forwardExtensionTool('browser_form_input', 'form_input')
  forwardExtensionTool('browser_computer', 'computer')

  return { mcpServer, backend, bridgeServer: backend }
}
