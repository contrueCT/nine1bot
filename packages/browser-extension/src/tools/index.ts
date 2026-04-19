// Tool definitions for MCP Server

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

export interface ToolResult {
  content: Array<{
    type: 'text' | 'image'
    text?: string
    data?: string
    mimeType?: string
  }>
  isError?: boolean
}

export type { ToolExecutionContext } from './execution-context'

// Re-export all tools
export * from './screenshot'
export * from './navigation'
export * from './dom-reader'
export * from './interaction'
export * from './form-input'
export * from './tabs'
export * from './diagnostics'
export * from './gif-recording'

// Tool registry
import { screenshotTool } from './screenshot'
import { navigateTool } from './navigation'
import { readPageTool, getPageTextTool, findTool } from './dom-reader'
import { computerTool } from './interaction'
import { formInputTool } from './form-input'
import { tabsContextTool, tabsCreateTool } from './tabs'
import { consoleMessagesTool, networkRequestsTool } from './diagnostics'
import { gifRecordingTool } from './gif-recording'
import type { ToolExecutionContext } from './execution-context'

export const tools: Record<string, ToolDefinition> = {
  screenshot: screenshotTool.definition,
  navigate: navigateTool.definition,
  read_page: readPageTool.definition,
  get_page_text: getPageTextTool.definition,
  find: findTool.definition,
  computer: computerTool.definition,
  form_input: formInputTool.definition,
  tabs_context_mcp: tabsContextTool.definition,
  tabs_create_mcp: tabsCreateTool.definition,
  console_messages: consoleMessagesTool.definition,
  network_requests: networkRequestsTool.definition,
  gif_recording: gifRecordingTool.definition,
}

export const toolExecutors: Record<string, (args: unknown, context?: ToolExecutionContext) => Promise<ToolResult>> = {
  screenshot: screenshotTool.execute,
  navigate: navigateTool.execute,
  read_page: readPageTool.execute,
  get_page_text: getPageTextTool.execute,
  find: findTool.execute,
  computer: computerTool.execute,
  form_input: formInputTool.execute,
  tabs_context_mcp: tabsContextTool.execute,
  tabs_create_mcp: tabsCreateTool.execute,
  console_messages: consoleMessagesTool.execute,
  network_requests: networkRequestsTool.execute,
  gif_recording: gifRecordingTool.execute,
}
