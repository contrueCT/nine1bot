/**
 * Shared type definitions for browser-mcp-server
 */

export interface BrowserMcpConfig {
  /** Bridge HTTP server port (default: 18791) */
  bridgePort?: number
  /** Bridge HTTP server host (default: '127.0.0.1') */
  bridgeHost?: string
  /** Chrome CDP debugging port (default: 9222) */
  cdpPort?: number
  /** Auto-launch Chrome if not running (default: true) */
  autoLaunch?: boolean
  /** Run Chrome in headless mode (default: false) */
  headless?: boolean
  /** Chrome executable path (auto-detected if omitted) */
  chromePath?: string
}

export interface Tab {
  id: string
  title: string
  url: string
  sessionId?: string
}

export interface PageContent {
  title: string
  url: string
  content: string
}

export interface ScreenshotOptions {
  fullPage?: boolean
  format?: 'png' | 'jpeg'
  quality?: number
}

/** Result from Chrome extension tool execution */
export interface ExtensionToolResult {
  content: Array<{
    type: 'text' | 'image'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}
