/**
 * MCP Server implementation for Chrome Extension
 *
 * This implements a simplified MCP server that can be connected to via SSE.
 * The server runs in the Service Worker and exposes browser control tools.
 */

import { tools, toolExecutors, type ToolResult } from '../tools'

// MCP Protocol types
interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: string | number
  method: string
  params?: unknown
}

interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: string | number
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

// Server info
const SERVER_INFO = {
  name: 'nine1bot-browser-control',
  version: '0.1.0',
}

// Protocol version
const PROTOCOL_VERSION = '2024-11-05'

// SSE connection management
interface SSEConnection {
  id: string
  port: chrome.runtime.Port
}

const connections = new Map<string, SSEConnection>()

// Generate unique connection ID
function generateConnectionId(): string {
  return `conn_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
}

// Handle incoming MCP request
async function handleMcpRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
  const { id, method, params } = request

  try {
    switch (method) {
      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: SERVER_INFO,
            capabilities: {
              tools: {},
            },
          },
        }
      }

      case 'initialized': {
        // Client acknowledging initialization
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        }
      }

      case 'tools/list': {
        const toolList = Object.values(tools).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
        }))

        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: toolList,
          },
        }
      }

      case 'tools/call': {
        const { name, arguments: args } = params as { name: string; arguments?: unknown }

        if (!name) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'Invalid params: tool name is required',
            },
          }
        }

        const executor = toolExecutors[name]
        if (!executor) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Tool not found: ${name}`,
            },
          }
        }

        const result: ToolResult = await executor(args)

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: result.content,
            isError: result.isError,
          },
        }
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id,
          result: {},
        }
      }

      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`,
          },
        }
      }
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: `Internal error: ${errorMessage}`,
      },
    }
  }
}

// Handle incoming message from port
async function handlePortMessage(message: unknown, port: chrome.runtime.Port): Promise<void> {
  console.log('[MCP Server] Received message:', message)

  // Validate JSON-RPC format
  if (typeof message !== 'object' || message === null) {
    console.error('[MCP Server] Invalid message format')
    return
  }

  const request = message as JsonRpcRequest

  if (request.jsonrpc !== '2.0') {
    console.error('[MCP Server] Invalid JSON-RPC version')
    return
  }

  // Handle notification (no id)
  if (request.id === undefined) {
    console.log('[MCP Server] Received notification:', request.method)
    return
  }

  // Process request and send response
  const response = await handleMcpRequest(request)
  console.log('[MCP Server] Sending response:', response)

  try {
    port.postMessage(response)
  } catch (error) {
    console.error('[MCP Server] Failed to send response:', error)
  }
}

// Set up message listener for Chrome runtime
export function setupMcpServer(): void {
  console.log('[MCP Server] Setting up server...')

  // Handle external connections (from web pages or other extensions)
  chrome.runtime.onConnectExternal.addListener((port) => {
    console.log('[MCP Server] External connection established')

    const connectionId = generateConnectionId()
    connections.set(connectionId, { id: connectionId, port })

    port.onMessage.addListener((message) => {
      handlePortMessage(message, port)
    })

    port.onDisconnect.addListener(() => {
      console.log('[MCP Server] External connection disconnected:', connectionId)
      connections.delete(connectionId)
    })
  })

  // Handle internal connections (from popup, content scripts, etc.)
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'mcp') return

    console.log('[MCP Server] Internal MCP connection established')

    const connectionId = generateConnectionId()
    connections.set(connectionId, { id: connectionId, port })

    port.onMessage.addListener((message) => {
      handlePortMessage(message, port)
    })

    port.onDisconnect.addListener(() => {
      console.log('[MCP Server] Internal connection disconnected:', connectionId)
      connections.delete(connectionId)
    })
  })

  // Also handle message-based communication (for simpler integrations)
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'mcp-request') return false

    const request = message.request as JsonRpcRequest

    handleMcpRequest(request)
      .then((response) => {
        sendResponse(response)
      })
      .catch((error) => {
        sendResponse({
          jsonrpc: '2.0',
          id: request.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        })
      })

    return true // Will respond asynchronously
  })

  console.log('[MCP Server] Server setup complete')
}

// Broadcast notification to all connections
export function broadcastNotification(notification: JsonRpcNotification): void {
  for (const connection of connections.values()) {
    try {
      connection.port.postMessage(notification)
    } catch (error) {
      console.error('[MCP Server] Failed to broadcast to connection:', connection.id, error)
    }
  }
}
