/**
 * Browser MCP Tools
 * 通过 Bridge Server 提供 MCP 工具接口
 */

const BRIDGE_URL = 'http://127.0.0.1:18791'

async function bridgeRequest<T = unknown>(
  path: string,
  options?: { method?: string; body?: unknown }
): Promise<T> {
  const response = await fetch(`${BRIDGE_URL}${path}`, {
    method: options?.method ?? 'GET',
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options?.body ? JSON.stringify(options.body) : undefined,
  })

  const data = await response.json() as { ok: boolean; error?: string } & T

  if (!data.ok) {
    throw new Error(data.error || 'Bridge request failed')
  }

  return data
}

// ===== Tool Definitions =====

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

// ===== Screenshot Tool =====

export const screenshotTool = {
  definition: {
    name: 'browser_screenshot',
    description: 'Capture a screenshot of a browser tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab to capture. Use browser_tabs to get available tabs.',
        },
        fullPage: {
          type: 'boolean',
          description: 'Capture the full page instead of just the visible area',
        },
      },
      required: ['targetId'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string; fullPage?: boolean }): Promise<ToolResult> {
    try {
      const result = await bridgeRequest<{ data: string; mimeType: string }>(
        `/tabs/${args.targetId}/screenshot`,
        { method: 'POST', body: { fullPage: args.fullPage } }
      )

      return {
        content: [{
          type: 'image',
          data: result.data,
          mimeType: result.mimeType,
        }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Tabs Tool =====

export const tabsTool = {
  definition: {
    name: 'browser_tabs',
    description: 'List, create, or close browser tabs',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'create', 'close', 'activate'],
          description: 'Action to perform: list (get all tabs), create (new tab), close (close tab), activate (focus tab)',
        },
        targetId: {
          type: 'string',
          description: 'Target ID for close/activate actions',
        },
        url: {
          type: 'string',
          description: 'URL for create action',
        },
      },
      required: ['action'],
    },
  } satisfies ToolDefinition,

  async execute(args: { action: string; targetId?: string; url?: string }): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'list': {
          const result = await bridgeRequest<{ tabs: Array<{ id: string; title: string; url: string }> }>('/tabs')
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result.tabs, null, 2),
            }],
          }
        }

        case 'create': {
          const result = await bridgeRequest<{ tab: { id: string; title: string; url: string } }>(
            '/tabs',
            { method: 'POST', body: { url: args.url ?? 'about:blank' } }
          )
          return {
            content: [{
              type: 'text',
              text: `Created tab: ${JSON.stringify(result.tab)}`,
            }],
          }
        }

        case 'close': {
          if (!args.targetId) {
            return {
              content: [{ type: 'text', text: 'Error: targetId is required for close action' }],
              isError: true,
            }
          }
          await bridgeRequest(`/tabs/${args.targetId}`, { method: 'DELETE' })
          return {
            content: [{ type: 'text', text: `Closed tab: ${args.targetId}` }],
          }
        }

        case 'activate': {
          if (!args.targetId) {
            return {
              content: [{ type: 'text', text: 'Error: targetId is required for activate action' }],
              isError: true,
            }
          }
          await bridgeRequest(`/tabs/${args.targetId}/activate`, { method: 'POST' })
          return {
            content: [{ type: 'text', text: `Activated tab: ${args.targetId}` }],
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown action: ${args.action}` }],
            isError: true,
          }
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Navigate Tool =====

export const navigateTool = {
  definition: {
    name: 'browser_navigate',
    description: 'Navigate a browser tab to a URL',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab to navigate',
        },
        url: {
          type: 'string',
          description: 'The URL to navigate to',
        },
      },
      required: ['targetId', 'url'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string; url: string }): Promise<ToolResult> {
    try {
      await bridgeRequest(`/tabs/${args.targetId}/navigate`, {
        method: 'POST',
        body: { url: args.url },
      })
      return {
        content: [{ type: 'text', text: `Navigated to: ${args.url}` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Click Tool =====

export const clickTool = {
  definition: {
    name: 'browser_click',
    description: 'Click at a specific position in a browser tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab',
        },
        x: {
          type: 'number',
          description: 'X coordinate to click',
        },
        y: {
          type: 'number',
          description: 'Y coordinate to click',
        },
        button: {
          type: 'string',
          enum: ['left', 'right', 'middle'],
          description: 'Mouse button to use (default: left)',
        },
      },
      required: ['targetId', 'x', 'y'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string; x: number; y: number; button?: string }): Promise<ToolResult> {
    try {
      await bridgeRequest(`/tabs/${args.targetId}/click`, {
        method: 'POST',
        body: { x: args.x, y: args.y, button: args.button },
      })
      return {
        content: [{ type: 'text', text: `Clicked at (${args.x}, ${args.y})` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Type Tool =====

export const typeTool = {
  definition: {
    name: 'browser_type',
    description: 'Type text in a browser tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
      },
      required: ['targetId', 'text'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string; text: string }): Promise<ToolResult> {
    try {
      await bridgeRequest(`/tabs/${args.targetId}/type`, {
        method: 'POST',
        body: { text: args.text },
      })
      return {
        content: [{ type: 'text', text: `Typed: "${args.text}"` }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Evaluate Tool =====

export const evaluateTool = {
  definition: {
    name: 'browser_evaluate',
    description: 'Execute JavaScript in a browser tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab',
        },
        expression: {
          type: 'string',
          description: 'JavaScript expression to evaluate',
        },
      },
      required: ['targetId', 'expression'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string; expression: string }): Promise<ToolResult> {
    try {
      const result = await bridgeRequest<{ result: unknown }>(`/tabs/${args.targetId}/evaluate`, {
        method: 'POST',
        body: { expression: args.expression },
      })
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result.result, null, 2),
        }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Content Tool =====

export const contentTool = {
  definition: {
    name: 'browser_content',
    description: 'Get the content (HTML, title, URL) of a browser tab',
    inputSchema: {
      type: 'object' as const,
      properties: {
        targetId: {
          type: 'string',
          description: 'The target ID of the tab',
        },
      },
      required: ['targetId'],
    },
  } satisfies ToolDefinition,

  async execute(args: { targetId: string }): Promise<ToolResult> {
    try {
      const result = await bridgeRequest<{ title: string; url: string; html: string }>(
        `/tabs/${args.targetId}/content`,
        { method: 'POST' }
      )
      return {
        content: [{
          type: 'text',
          text: `Title: ${result.title}\nURL: ${result.url}\n\nHTML (truncated):\n${result.html?.slice(0, 10000)}`,
        }],
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Browser Start/Stop Tool =====

export const browserControlTool = {
  definition: {
    name: 'browser_control',
    description: 'Start or stop the managed browser instance',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string',
          enum: ['start', 'stop', 'status'],
          description: 'Action to perform',
        },
      },
      required: ['action'],
    },
  } satisfies ToolDefinition,

  async execute(args: { action: string }): Promise<ToolResult> {
    try {
      switch (args.action) {
        case 'start': {
          const result = await bridgeRequest<{ cdpUrl: string }>('/start', { method: 'POST' })
          return {
            content: [{ type: 'text', text: `Browser started. CDP URL: ${result.cdpUrl}` }],
          }
        }

        case 'stop': {
          const result = await bridgeRequest<{ stopped: boolean }>('/stop', { method: 'POST' })
          return {
            content: [{ type: 'text', text: result.stopped ? 'Browser stopped' : 'No managed browser to stop' }],
          }
        }

        case 'status': {
          const result = await bridgeRequest<{ running: boolean; cdpUrl: string; version?: string }>('/')
          return {
            content: [{
              type: 'text',
              text: `Browser status:\n- Running: ${result.running}\n- CDP URL: ${result.cdpUrl}\n- Version: ${result.version ?? 'N/A'}`,
            }],
          }
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown action: ${args.action}` }],
            isError: true,
          }
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error}` }],
        isError: true,
      }
    }
  },
}

// ===== Export all tools =====

export const browserTools = {
  browser_screenshot: screenshotTool,
  browser_tabs: tabsTool,
  browser_navigate: navigateTool,
  browser_click: clickTool,
  browser_type: typeTool,
  browser_evaluate: evaluateTool,
  browser_content: contentTool,
  browser_control: browserControlTool,
}

export const browserToolDefinitions = Object.values(browserTools).map(t => t.definition)

export async function executeBrowserTool(name: string, args: unknown): Promise<ToolResult> {
  const tool = browserTools[name as keyof typeof browserTools]
  if (!tool) {
    return {
      content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      isError: true,
    }
  }
  return tool.execute(args as never)
}
