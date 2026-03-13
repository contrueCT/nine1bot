import type { ToolDefinition, ToolResult } from './index'
import type { ToolExecutionContext } from './execution-context'
import { isAbortError } from './execution-context'
import { sampleConsoleMessages, sampleNetworkRequests } from '../background/diagnostics-buffer'

interface ConsoleMessagesArgs {
  tabId?: number
  sampleMs?: number
  max?: number
  sinceMs?: number
  level?: string
}

interface NetworkRequestsArgs {
  tabId?: number
  sampleMs?: number
  max?: number
  sinceMs?: number
  resourceType?: string
}

async function resolveTargetTab(tabId?: number): Promise<number> {
  if (tabId !== undefined) return tabId
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!activeTab?.id) {
    throw new Error('No active tab found')
  }
  return activeTab.id
}

export const consoleMessagesTool = {
  definition: {
    name: 'console_messages',
    description: 'Capture console messages from the target tab via Chrome debugger (on-demand sampling).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'number', description: 'Tab ID to inspect. Defaults to active tab.' },
        sampleMs: { type: 'number', description: 'Sampling window in ms (default 1500).' },
        max: { type: 'number', description: 'Maximum number of messages to return (default 50).' },
        sinceMs: { type: 'number', description: 'Only include entries newer than now-sinceMs.' },
        level: { type: 'string', description: 'Filter by console level (log, warning, error, etc).' },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const parsed = (args as ConsoleMessagesArgs) || {}
      const tabId = await resolveTargetTab(parsed.tabId ?? context?.tabId)
      const entries = await sampleConsoleMessages({
        tabId,
        sampleMs: parsed.sampleMs,
        max: parsed.max,
        sinceMs: parsed.sinceMs,
        level: parsed.level,
        signal: context?.signal,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
      }
    } catch (error) {
      if (isAbortError(error)) {
        return { content: [{ type: 'text', text: 'Cancelled' }], isError: true }
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error reading console messages: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

export const networkRequestsTool = {
  definition: {
    name: 'network_requests',
    description: 'Capture network requests from the target tab via Chrome debugger (on-demand sampling).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: { type: 'number', description: 'Tab ID to inspect. Defaults to active tab.' },
        sampleMs: { type: 'number', description: 'Sampling window in ms (default 1500).' },
        max: { type: 'number', description: 'Maximum number of requests to return (default 50).' },
        sinceMs: { type: 'number', description: 'Only include entries newer than now-sinceMs.' },
        resourceType: { type: 'string', description: 'Filter by resource type (Document, Script, XHR, etc).' },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    try {
      const parsed = (args as NetworkRequestsArgs) || {}
      const tabId = await resolveTargetTab(parsed.tabId ?? context?.tabId)
      const entries = await sampleNetworkRequests({
        tabId,
        sampleMs: parsed.sampleMs,
        max: parsed.max,
        sinceMs: parsed.sinceMs,
        resourceType: parsed.resourceType,
        signal: context?.signal,
      })
      return {
        content: [{ type: 'text', text: JSON.stringify(entries, null, 2) }],
      }
    } catch (error) {
      if (isAbortError(error)) {
        return { content: [{ type: 'text', text: 'Cancelled' }], isError: true }
      }
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error reading network requests: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

