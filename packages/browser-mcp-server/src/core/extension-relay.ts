/**
 * Extension Relay Server
 *
 * 实现 Chrome 扩展与 MCP Server 之间的通信中继
 * 参考 ClawdBot 的 extension-relay.js 实现
 *
 * 架构:
 * - Chrome 扩展通过 WebSocket 连接到 /extension 端点
 * - 外部 CDP 客户端（如 Playwright）连接到 /cdp 端点
 * - Relay Server 转发 CDP 命令给扩展，扩展执行后返回结果
 */

import { WebSocket, WebSocketServer } from 'ws'
import type { Server as HttpServer, IncomingMessage } from 'http'
import type { Duplex } from 'stream'

export interface ExtensionRelayOptions {
  httpServer: HttpServer
  basePath?: string
}

export interface TargetInfo {
  targetId: string
  type: string
  title: string
  url: string
  attached?: boolean
}

export interface ConnectedTarget {
  sessionId: string
  targetId: string
  targetInfo: TargetInfo
}

export interface ExtensionRelay {
  extensionConnected: () => boolean
  getTargets: () => ConnectedTarget[]
  sendCommand: (method: string, params?: unknown, targetId?: string) => Promise<unknown>
  stop: () => Promise<void>
}

export function createExtensionRelay(options: ExtensionRelayOptions): ExtensionRelay {
  const { httpServer, basePath = '' } = options

  // Extension WebSocket connection
  let extensionWs: WebSocket | null = null

  // CDP client connections
  const cdpClients = new Set<WebSocket>()

  // Connected targets (tabs) from extension
  const connectedTargets = new Map<string, ConnectedTarget>()

  // Pending requests to extension
  const pendingExtension = new Map<number, {
    resolve: (result: unknown) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()

  let nextExtensionId = 1

  // WebSocket servers
  const wssExtension = new WebSocketServer({ noServer: true })
  const wssCdp = new WebSocketServer({ noServer: true })

  /**
   * Send command to extension and wait for response
   */
  async function sendToExtension(payload: { id: number; method: string; params: unknown }): Promise<unknown> {
    const ws = extensionWs
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('Chrome extension not connected')
    }

    ws.send(JSON.stringify(payload))

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExtension.delete(payload.id)
        reject(new Error(`Extension request timeout: ${(payload.params as any)?.method || 'unknown'}`))
      }, 30000)

      pendingExtension.set(payload.id, { resolve, reject, timer })
    })
  }

  /**
   * Broadcast event to all CDP clients
   */
  function broadcastToCdpClients(evt: unknown): void {
    const msg = JSON.stringify(evt)
    for (const ws of cdpClients) {
      if (ws.readyState !== WebSocket.OPEN) continue
      ws.send(msg)
    }
  }

  /**
   * Send response to specific CDP client
   */
  function sendResponseToCdp(ws: WebSocket, res: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(res))
  }

  /**
   * Route CDP command - handle locally or forward to extension
   */
  async function routeCdpCommand(cmd: { id: number; method: string; params?: unknown; sessionId?: string }): Promise<unknown> {
    switch (cmd.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: 'Chrome/Browser-MCP-Extension-Relay',
          revision: '0',
          userAgent: 'Browser-MCP-Extension-Relay',
          jsVersion: 'V8',
        }

      case 'Browser.setDownloadBehavior':
        return {}

      case 'Target.setAutoAttach':
      case 'Target.setDiscoverTargets':
        return {}

      case 'Target.getTargets':
        return {
          targetInfos: Array.from(connectedTargets.values()).map(t => ({
            ...t.targetInfo,
            attached: true,
          })),
        }

      case 'Target.getTargetInfo': {
        const params = (cmd.params ?? {}) as { targetId?: string }
        const targetId = params.targetId

        if (targetId) {
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) {
              return { targetInfo: t.targetInfo }
            }
          }
        }

        if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
          const t = connectedTargets.get(cmd.sessionId)
          if (t) return { targetInfo: t.targetInfo }
        }

        const first = Array.from(connectedTargets.values())[0]
        return { targetInfo: first?.targetInfo }
      }

      case 'Target.attachToTarget': {
        const params = (cmd.params ?? {}) as { targetId?: string }
        const targetId = params.targetId

        if (!targetId) throw new Error('targetId required')

        for (const t of connectedTargets.values()) {
          if (t.targetId === targetId) {
            return { sessionId: t.sessionId }
          }
        }

        throw new Error('target not found')
      }

      default: {
        // Forward to extension
        const id = nextExtensionId++
        return await sendToExtension({
          id,
          method: 'forwardCDPCommand',
          params: {
            method: cmd.method,
            sessionId: cmd.sessionId,
            params: cmd.params,
          },
        })
      }
    }
  }

  /**
   * Handle extension WebSocket connection
   */
  wssExtension.on('connection', (ws) => {
    console.log('[Extension Relay] Extension connected')
    extensionWs = ws

    // Ping to keep connection alive
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({ method: 'ping' }))
    }, 5000)

    ws.on('message', (data) => {
      let parsed: any = null
      try {
        parsed = JSON.parse(data.toString())
      } catch {
        return
      }

      // Handle response to our request
      if (parsed && typeof parsed === 'object' && 'id' in parsed && typeof parsed.id === 'number') {
        const pending = pendingExtension.get(parsed.id)
        if (!pending) return

        pendingExtension.delete(parsed.id)
        clearTimeout(pending.timer)

        if ('error' in parsed && typeof parsed.error === 'string' && parsed.error.trim()) {
          pending.reject(new Error(parsed.error))
        } else {
          pending.resolve(parsed.result)
        }
        return
      }

      // Handle event from extension
      if (parsed && typeof parsed === 'object' && 'method' in parsed) {
        if (parsed.method === 'pong') return

        if (parsed.method !== 'forwardCDPEvent') return

        const evt = parsed as { params: { method: string; params?: unknown; sessionId?: string } }
        const method = evt.params?.method
        const params = evt.params?.params
        const sessionId = evt.params?.sessionId

        if (!method || typeof method !== 'string') return

        // Handle Target.attachedToTarget - track connected tabs
        if (method === 'Target.attachedToTarget') {
          const attached = (params ?? {}) as {
            sessionId?: string
            targetInfo?: TargetInfo
          }

          const targetType = attached?.targetInfo?.type ?? 'page'
          if (targetType !== 'page') return

          if (attached?.sessionId && attached?.targetInfo?.targetId) {
            const prev = connectedTargets.get(attached.sessionId)
            const nextTargetId = attached.targetInfo.targetId
            const prevTargetId = prev?.targetId
            const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId)

            connectedTargets.set(attached.sessionId, {
              sessionId: attached.sessionId,
              targetId: nextTargetId,
              targetInfo: attached.targetInfo,
            })

            if (changedTarget && prevTargetId) {
              broadcastToCdpClients({
                method: 'Target.detachedFromTarget',
                params: { sessionId: attached.sessionId, targetId: prevTargetId },
                sessionId: attached.sessionId,
              })
            }

            if (!prev || changedTarget) {
              broadcastToCdpClients({ method, params, sessionId })
            }
            return
          }
        }

        // Handle Target.detachedFromTarget
        if (method === 'Target.detachedFromTarget') {
          const detached = (params ?? {}) as { sessionId?: string }
          if (detached?.sessionId) {
            connectedTargets.delete(detached.sessionId)
          }
          broadcastToCdpClients({ method, params, sessionId })
          return
        }

        // Handle Target.targetInfoChanged - update cached metadata
        if (method === 'Target.targetInfoChanged') {
          const changed = (params ?? {}) as { targetInfo?: TargetInfo }
          const targetInfo = changed?.targetInfo
          const targetId = targetInfo?.targetId

          if (targetId && (targetInfo?.type ?? 'page') === 'page') {
            for (const [sid, target] of connectedTargets) {
              if (target.targetId !== targetId) continue
              connectedTargets.set(sid, {
                ...target,
                targetInfo: { ...target.targetInfo, ...targetInfo },
              })
            }
          }
        }

        // Broadcast other events to CDP clients
        broadcastToCdpClients({ method, params, sessionId })
      }
    })

    ws.on('close', () => {
      console.log('[Extension Relay] Extension disconnected')
      clearInterval(ping)
      extensionWs = null

      // Reject all pending requests
      for (const [, pending] of pendingExtension) {
        clearTimeout(pending.timer)
        pending.reject(new Error('Extension disconnected'))
      }
      pendingExtension.clear()

      // Clear targets
      connectedTargets.clear()

      // Close all CDP clients
      for (const client of cdpClients) {
        try {
          client.close(1011, 'Extension disconnected')
        } catch {
          // ignore
        }
      }
      cdpClients.clear()
    })

    ws.on('error', (err) => {
      console.error('[Extension Relay] Extension WebSocket error:', err.message)
    })
  })

  /**
   * Handle CDP client WebSocket connection
   */
  wssCdp.on('connection', (ws) => {
    console.log('[Extension Relay] CDP client connected')
    cdpClients.add(ws)

    // Send current targets to new client
    for (const target of connectedTargets.values()) {
      ws.send(JSON.stringify({
        method: 'Target.attachedToTarget',
        params: {
          sessionId: target.sessionId,
          targetInfo: { ...target.targetInfo, attached: true },
          waitingForDebugger: false,
        },
      }))
    }

    ws.on('message', async (data) => {
      let cmd: any = null
      try {
        cmd = JSON.parse(data.toString())
      } catch {
        return
      }

      if (!cmd || typeof cmd !== 'object') return
      if (typeof cmd.id !== 'number' || typeof cmd.method !== 'string') return

      if (!extensionWs) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: 'Extension not connected' },
        })
        return
      }

      try {
        const result = await routeCdpCommand(cmd)
        sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result })
      } catch (err) {
        sendResponseToCdp(ws, {
          id: cmd.id,
          sessionId: cmd.sessionId,
          error: { message: err instanceof Error ? err.message : String(err) },
        })
      }
    })

    ws.on('close', () => {
      console.log('[Extension Relay] CDP client disconnected')
      cdpClients.delete(ws)
    })

    ws.on('error', (err) => {
      console.error('[Extension Relay] CDP client WebSocket error:', err.message)
    })
  })

  /**
   * Handle HTTP upgrade for WebSocket connections
   */
  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    // Check if request is for extension relay
    const extensionPath = basePath + '/extension'
    const cdpPath = basePath + '/cdp'

    if (pathname === extensionPath) {
      if (extensionWs) {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\nExtension already connected')
        socket.destroy()
        return true
      }

      wssExtension.handleUpgrade(req, socket, head, (ws) => {
        wssExtension.emit('connection', ws, req)
      })
      return true
    }

    if (pathname === cdpPath) {
      if (!extensionWs) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\nExtension not connected')
        socket.destroy()
        return true
      }

      wssCdp.handleUpgrade(req, socket, head, (ws) => {
        wssCdp.emit('connection', ws, req)
      })
      return true
    }

    return false
  }

  // Attach upgrade handler to HTTP server
  httpServer.on('upgrade', handleUpgrade)

  return {
    extensionConnected: () => Boolean(extensionWs),
    getTargets: () => Array.from(connectedTargets.values()),
    sendCommand: async (method: string, params?: unknown, targetId?: string) => {
      if (!extensionWs || extensionWs.readyState !== WebSocket.OPEN) {
        throw new Error('Chrome extension not connected')
      }

      // Find sessionId for targetId
      let sessionId: string | undefined
      if (targetId) {
        for (const target of connectedTargets.values()) {
          if (target.targetId === targetId) {
            sessionId = target.sessionId
            break
          }
        }
      }

      console.log('[Extension Relay] sendCommand:', method, 'targetId:', targetId, 'sessionId:', sessionId)
      console.log('[Extension Relay] connectedTargets:', Array.from(connectedTargets.entries()))

      const id = nextExtensionId++
      return await sendToExtension({
        id,
        method: 'forwardCDPCommand',
        params: { method, params, sessionId },
      })
    },
    stop: async () => {
      // Close extension connection
      if (extensionWs) {
        try {
          extensionWs.close(1001, 'Server stopping')
        } catch {
          // ignore
        }
      }

      // Close all CDP clients
      for (const ws of cdpClients) {
        try {
          ws.close(1001, 'Server stopping')
        } catch {
          // ignore
        }
      }

      // Close WebSocket servers
      wssExtension.close()
      wssCdp.close()

      // Remove upgrade handler
      httpServer.removeListener('upgrade', handleUpgrade)
    },
  }
}
