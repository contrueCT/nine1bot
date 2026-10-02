import type { ToolDefinition, ToolResult } from './index'
import { assertExecutionActive, executionDelay, type ToolExecutionContext } from './execution-context'

interface NavigateArgs {
  tabId?: number
  url?: string
  action?: 'goto' | 'back' | 'forward' | 'reload'
}

export const navigateTool = {
  definition: {
    name: 'navigate',
    description: 'Navigate to a URL or use browser history navigation (back, forward, reload).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to navigate. If not provided, uses the active tab.',
        },
        url: {
          type: 'string',
          description: 'The URL to navigate to. Required when action is "goto" or not specified.',
        },
        action: {
          type: 'string',
          enum: ['goto', 'back', 'forward', 'reload'],
          description: 'The navigation action to perform. Defaults to "goto" if url is provided.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown, context?: ToolExecutionContext): Promise<ToolResult> {
    const { tabId, url, action = url ? 'goto' : undefined } = (args as NavigateArgs) || {}

    try {
      // Get the target tab
      let targetTabId: number

      if (tabId !== undefined) {
        targetTabId = tabId
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!activeTab?.id) {
          return {
            content: [{ type: 'text', text: 'Error: No active tab found' }],
            isError: true,
          }
        }
        targetTabId = activeTab.id
      }

      await assertExecutionActive(context)
      switch (action) {
        case 'goto':
          if (!url) {
            return {
              content: [{ type: 'text', text: 'Error: URL is required for "goto" action' }],
              isError: true,
            }
          }
          await chrome.tabs.update(targetTabId, { url })
          // Wait for navigation to start
          await executionDelay(500, context)
          return {
            content: [{ type: 'text', text: `Navigated to ${url}` }],
          }

        case 'back':
          await chrome.tabs.goBack(targetTabId)
          await executionDelay(500, context)
          return {
            content: [{ type: 'text', text: 'Navigated back in history' }],
          }

        case 'forward':
          await chrome.tabs.goForward(targetTabId)
          await executionDelay(500, context)
          return {
            content: [{ type: 'text', text: 'Navigated forward in history' }],
          }

        case 'reload':
          await chrome.tabs.reload(targetTabId)
          await executionDelay(500, context)
          return {
            content: [{ type: 'text', text: 'Page reloaded' }],
          }

        default:
          return {
            content: [{ type: 'text', text: 'Error: Either url or action must be provided' }],
            isError: true,
          }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error during navigation: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
