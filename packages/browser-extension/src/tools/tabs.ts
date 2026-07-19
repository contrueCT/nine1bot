import type { ToolDefinition, ToolResult } from './index'
import { addTabToNine1Group, getDefaultNine1Tab, getTabGroupDiagnostics, getTabsInActiveNine1Group } from '../background/tab-group-manager'

interface TabsContextArgs {
  createIfEmpty?: boolean
  url?: string
  includeAll?: boolean
}

interface TabsCreateArgs {
  url?: string
}

function normalizeNewTabUrl(url?: string): string {
  if (typeof url !== 'string') return 'about:blank'
  const trimmed = url.trim()
  return trimmed.length > 0 ? trimmed : 'about:blank'
}

function isAutomatableTabUrl(url?: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'file:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function serializeTab(tab: chrome.tabs.Tab) {
  return {
    id: tab.id,
    url: tab.url,
    title: tab.title,
    active: tab.active,
    windowId: tab.windowId,
  }
}

async function listManagedTabs() {
  return (await getTabsInActiveNine1Group()).filter((tab) => typeof tab.id === 'number')
}

export const tabsContextTool = {
  definition: {
    name: 'tabs_context_mcp',
    description:
      'Get context information about the active Nine1Bot tab group. Returns only tab IDs managed by the current extension side-panel session.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        createIfEmpty: {
          type: 'boolean',
          description: 'If true and no tabs exist in the active Nine1Bot group, create a new tab.',
        },
        url: {
          type: 'string',
          description: 'Optional URL to open when createIfEmpty creates a new tab.',
        },
        includeAll: {
          type: 'boolean',
          description: 'If true, include automatable tabs from the active Nine1Bot group. It never includes tabs outside the group.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    const { createIfEmpty = false, url, includeAll = false } = (args as TabsContextArgs) || {}

    try {
      let managedTabs = await listManagedTabs()

      if (createIfEmpty && managedTabs.length === 0) {
        const newTab = await chrome.tabs.create({ url: normalizeNewTabUrl(url) })
        if (newTab.id) {
          await addTabToNine1Group(newTab.id)
          managedTabs = await listManagedTabs()
        }
      }

      const activeTab = await getDefaultNine1Tab()
      const automatableTabs = managedTabs.filter((tab) => isAutomatableTabUrl(tab.url))
      const diagnostics = await getTabGroupDiagnostics(activeTab?.windowId)
      const resolution = diagnostics.currentWindowId !== null
        ? diagnostics.lastResolutionByWindow[String(diagnostics.currentWindowId)] ?? null
        : null
      const reasonCode = automatableTabs.length > 0
        ? 'ok'
        : managedTabs.length > 0
          ? 'no_automatable_tabs'
          : resolution?.issueCode ?? 'no_active_group'

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                mcpTabs: managedTabs.map(serializeTab),
                activeTab: activeTab ? serializeTab(activeTab) : null,
                allTabs: includeAll ? automatableTabs.map(serializeTab) : undefined,
                totalMcpTabs: managedTabs.length,
                totalAutomatableTabs: automatableTabs.length,
                tabScanStatus: {
                  source: 'authoritative_group_scan',
                  reasonCode,
                  recoverySource: resolution?.recoverySource ?? 'none',
                  windowId: diagnostics.currentWindowId,
                  matchedGroupIds: resolution?.matchedGroupIds ?? [],
                },
                diagnostics,
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
    description: 'Creates a new empty tab in the active Nine1Bot tab group. Use tabs_context_mcp first to see existing tabs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Optional initial URL to open in the new tab. Defaults to about:blank.',
        },
      },
      required: [],
    },
  } satisfies ToolDefinition,

  async execute(args: unknown): Promise<ToolResult> {
    try {
      const { url } = (args as TabsCreateArgs) || {}
      const initialUrl = normalizeNewTabUrl(url)
      const newTab = await chrome.tabs.create({ url: initialUrl })

      if (!newTab.id) {
        return {
          content: [{ type: 'text', text: 'Error: Failed to create tab - no ID returned' }],
          isError: true,
        }
      }

      await addTabToNine1Group(newTab.id)

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
                requestedUrl: initialUrl,
                message: 'New tab created and added to active Nine1Bot tab group',
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

export function addTabToMcpGroup(tabId: number): void {
  addTabToNine1Group(tabId).catch(() => {})
}
