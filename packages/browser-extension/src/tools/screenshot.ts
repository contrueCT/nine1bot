import type { ToolDefinition, ToolResult } from './index'

interface ScreenshotArgs {
  tabId?: number
}

// Track attached debugger tabs
const attachedDebuggerTabs = new Set<number>()

/**
 * Ensure debugger is attached to the tab
 */
async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedDebuggerTabs.has(tabId)) return

  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attachedDebuggerTabs.add(tabId)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already attached'))) {
      throw error
    }
    attachedDebuggerTabs.add(tabId)
  }
}

// Listen for debugger detach events
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) {
    attachedDebuggerTabs.delete(source.tabId)
  }
})

export const screenshotTool = {
  definition: {
    name: 'screenshot',
    description: 'Capture a screenshot of the visible area of the specified tab. Returns the screenshot as a base64-encoded PNG image.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tabId: {
          type: 'number',
          description: 'The ID of the tab to capture. If not provided, captures the active tab.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { tabId } = (args as ScreenshotArgs) || {}

    try {
      // Get the tab to capture
      let targetTabId: number | undefined

      if (tabId !== undefined) {
        targetTabId = tabId
      } else {
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
        targetTabId = activeTab?.id
      }

      if (!targetTabId) {
        return {
          content: [{ type: 'text', text: 'Error: No tab found to capture' }],
          isError: true,
        }
      }

      // Use debugger API to capture screenshot (doesn't require activeTab permission)
      await ensureDebuggerAttached(targetTabId)

      const result = await chrome.debugger.sendCommand(
        { tabId: targetTabId },
        'Page.captureScreenshot',
        { format: 'png' }
      ) as { data: string }

      if (!result?.data) {
        return {
          content: [{ type: 'text', text: 'Error: Screenshot capture returned no data' }],
          isError: true,
        }
      }

      return {
        content: [
          {
            type: 'image',
            data: result.data,
            mimeType: 'image/png',
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error capturing screenshot: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}
