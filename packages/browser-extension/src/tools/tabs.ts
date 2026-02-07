import type { ToolDefinition, ToolResult } from './index'

interface TabsContextArgs {
  createIfEmpty?: boolean
}

// Track tabs created by this extension (MCP tab group)
const mcpTabIds = new Set<number>()

export const tabsContextTool = {
  definition: {
    name: 'tabs_context_mcp',
    description:
      'Get context information about the current MCP tab group. Returns all tab IDs managed by the extension. Use this to know what tabs exist before using other browser automation tools.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'If true and no tabs exist in the group, create a new tab.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { createIfEmpty = false } = (args as TabsContextArgs) || {}

    try {
      // Clean up closed tabs from our tracking
      const allTabs = await chrome.tabs.query({})
      const allTabIds = new Set(allTabs.map((t) => t.id).filter((id): id is number => id !== undefined))

      for (const tabId of mcpTabIds) {
        if (!allTabIds.has(tabId)) {
          mcpTabIds.delete(tabId)
        }
      }

      // Get info about managed tabs
      const managedTabs: Array<{
        id: number
        url?: string
        title?: string
        active: boolean
        windowId: number
      }> = []

      for (const tabId of mcpTabIds) {
        try {
          const tab = await chrome.tabs.get(tabId)
          managedTabs.push({
            id: tab.id!,
            url: tab.url,
            title: tab.title,
            active: tab.active,
            windowId: tab.windowId,
          })
        } catch {
          // Tab no longer exists
          mcpTabIds.delete(tabId)
        }
      }

      // Create a new tab if requested and none exist
      if (createIfEmpty && managedTabs.length === 0) {
        const newTab = await chrome.tabs.create({ url: 'about:blank' })
        if (newTab.id) {
          mcpTabIds.add(newTab.id)
          managedTabs.push({
            id: newTab.id,
            url: newTab.url,
            title: newTab.title,
            active: newTab.active,
            windowId: newTab.windowId,
          })
        }
      }

      // Also include the currently active tab if not already tracked
      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
      let activeTabInfo = null
      if (activeTab?.id) {
        activeTabInfo = {
          id: activeTab.id,
          url: activeTab.url,
          title: activeTab.title,
          windowId: activeTab.windowId,
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mcpTabs: managedTabs,
                activeTab: activeTabInfo,
                totalMcpTabs: managedTabs.length,
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error getting tabs context: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

export const tabsCreateTool = {
  definition: {
    name: 'tabs_create_mcp',
    description: 'Creates a new empty tab in the MCP tab group. Use tabs_context_mcp first to see existing tabs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(_args: unknown): Promise<ToolResult> {
    try {
      const newTab = await chrome.tabs.create({ url: 'about:blank' })

      if (!newTab.id) {
        return {
          content: [{ type: 'text', text: 'Error: Failed to create tab - no ID returned' }],
          isError: true,
        }
      }

      mcpTabIds.add(newTab.id)

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                id: newTab.id,
                url: newTab.url,
                title: newTab.title,
                windowId: newTab.windowId,
                message: 'New tab created and added to MCP tab group',
              },
              null,
              2
            ),
          },
        ],
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: 'text', text: `Error creating tab: ${errorMessage}` }],
        isError: true,
      }
    }
  },
}

// Helper to add existing tab to MCP group
export function addTabToMcpGroup(tabId: number): void {
  mcpTabIds.add(tabId)
}

// Helper to remove tab from MCP group
export function removeTabFromMcpGroup(tabId: number): void {
  mcpTabIds.delete(tabId)
}

// Listen for tab close events to clean up
chrome.tabs.onRemoved.addListener((tabId) => {
  mcpTabIds.delete(tabId)
})
