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

// Re-export all tools
export * from './screenshot'
export * from './navigation'
export * from './dom-reader'
export * from './interaction'
export * from './form-input'
export * from './tabs'

// Tool registry
import { screenshotTool } from './screenshot'
import { navigateTool } from './navigation'
import { readPageTool, getPageTextTool, findTool } from './dom-reader'
import { computerTool } from './interaction'
import { formInputTool } from './form-input'
import { tabsContextTool, tabsCreateTool } from './tabs'

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
}

export const toolExecutors: Record<string, (args: unknown) => Promise<ToolResult>> = {
  screenshot: screenshotTool.execute,
  navigate: navigateTool.execute,
  read_page: readPageTool.execute,
  get_page_text: getPageTextTool.execute,
  find: findTool.execute,
  computer: computerTool.execute,
  form_input: formInputTool.execute,
  tabs_context_mcp: tabsContextTool.execute,
  tabs_create_mcp: tabsCreateTool.execute,
}
