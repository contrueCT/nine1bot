/**
 * Bridge Client - connects to an existing Bridge Server via HTTP
 * Used when the MCP server is a subprocess and the Bridge is managed externally
 * (e.g., Nine1Bot orchestrator starts the Bridge, MCP connects to it)
 */

import type { Tab, PageContent, ScreenshotOptions, ExtensionToolResult } from '../core/types'

export interface BridgeClientOptions {
  /** Bridge Server base URL (e.g., http://127.0.0.1:18793) */
  url: string
}

/**
 * Thin HTTP client that implements the same interface as BridgeServer's direct methods.
 * This allows the MCP layer to use either BridgeServer (embedded) or BridgeClient (remote).
 */
export class BridgeClient {
  private baseUrl: string

  constructor(options: BridgeClientOptions) {
    this.baseUrl = options.url.replace(/\/$/, '')
  }

  private async request<T = unknown>(path: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options?.method ?? 'GET',
      headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options?.body ? JSON.stringify(options.body) : undefined,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      throw new Error(`Bridge request failed: ${response.status} ${text}`)
    }

    return response.json() as Promise<T>
  }

  async listTabs(): Promise<Tab[]> {
    const result = await this.request<{ ok: boolean; tabs?: Tab[]; error?: string }>('/tabs')
    if (!result.ok) throw new Error(result.error || 'Failed to list tabs')
    return result.tabs ?? []
  }

  async screenshot(tabId: string, options?: ScreenshotOptions): Promise<{ data: string; mimeType: string }> {
    const result = await this.request<{ ok: boolean; data?: string; mimeType?: string; error?: string }>(
      `/tabs/${tabId}/screenshot`,
      { method: 'POST', body: options ?? {} }
    )
    if (!result.ok || !result.data) throw new Error(result.error || 'Screenshot failed')
    return { data: result.data, mimeType: result.mimeType ?? 'image/png' }
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const result = await this.request<{ ok: boolean; error?: string }>(
      `/tabs/${tabId}/navigate`,
      { method: 'POST', body: { url } }
    )
    if (!result.ok) throw new Error(result.error || 'Navigation failed')
  }

  async click(tabId: string, x: number, y: number, options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }): Promise<void> {
    const result = await this.request<{ ok: boolean; error?: string }>(
      `/tabs/${tabId}/click`,
      { method: 'POST', body: { x, y, ...options } }
    )
    if (!result.ok) throw new Error(result.error || 'Click failed')
  }

  async type(tabId: string, text: string, delay?: number): Promise<void> {
    const result = await this.request<{ ok: boolean; error?: string }>(
      `/tabs/${tabId}/type`,
      { method: 'POST', body: { text, delay } }
    )
    if (!result.ok) throw new Error(result.error || 'Type failed')
  }

  async evaluate(tabId: string, expression: string): Promise<unknown> {
    const result = await this.request<{ ok: boolean; result?: unknown; error?: string }>(
      `/tabs/${tabId}/evaluate`,
      { method: 'POST', body: { expression } }
    )
    if (!result.ok) throw new Error(result.error || 'Evaluate failed')
    return result.result
  }

  async getContent(tabId: string): Promise<PageContent> {
    const result = await this.request<{ ok: boolean; title?: string; url?: string; html?: string; content?: string; error?: string }>(
      `/tabs/${tabId}/content`,
      { method: 'POST', body: {} }
    )
    if (!result.ok) throw new Error(result.error || 'Get content failed')
    return {
      title: result.title ?? '',
      url: result.url ?? '',
      content: result.html ?? result.content ?? '',
    }
  }

  async callExtensionTool(tabId: string, toolName: string, args: Record<string, unknown> = {}): Promise<ExtensionToolResult> {
    const result = await this.request<{ ok: boolean; content?: ExtensionToolResult['content']; isError?: boolean; error?: string }>(
      `/tabs/${tabId}/tool/${toolName}`,
      { method: 'POST', body: args }
    )
    if (!result.ok) throw new Error(result.error || `Extension tool ${toolName} failed`)
    return { content: result.content || [], isError: result.isError }
  }

  // No lifecycle management - the bridge is managed externally
  async start(): Promise<void> {
    // Verify connection by hitting health endpoint
    try {
      const result = await this.request<{ ok: boolean }>('/')
      if (!result.ok) throw new Error('Bridge server health check failed')
      console.log(`[Bridge Client] Connected to existing Bridge Server at ${this.baseUrl}`)
    } catch (error) {
      console.warn(`[Bridge Client] Warning: Could not reach Bridge Server at ${this.baseUrl}:`, error)
      console.warn(`[Bridge Client] Will retry on first tool call`)
    }
  }

  async stop(): Promise<void> {
    // Nothing to clean up - we don't own the bridge server
  }
}
