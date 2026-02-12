/**
 * Extension Relay - Bun/Hono Native WebSocket Implementation
 *
 * Rewrite of core/extension-relay.ts using Hono's upgradeWebSocket()
 * instead of Node.js 'ws' library, for integration with Bun.serve().
 *
 * Architecture:
 * - Chrome Extension connects to /extension WebSocket endpoint
 * - External CDP clients (Playwright, etc.) connect to /cdp endpoint
 * - Relay forwards CDP commands to extension, extension executes and returns results
 */

import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/bun'
import type { WSContext } from 'hono/ws'

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

// ==================== Module-level State ====================

let extensionWs: WSContext | null = null
const cdpClients = new Set<WSContext>()
const connectedTargets = new Map<string, ConnectedTarget>()
const pendingExtension = new Map<number, {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}>()
let nextExtensionId = 1
let pingInterval: ReturnType<typeof setInterval> | null = null

// ==================== Internal Helpers ====================

function sendToExtension(payload: { id: number; method: string; params: unknown }): Promise<unknown> {
  const ws = extensionWs
  if (!ws || ws.readyState !== 1) {
    return Promise.reject(new Error('Chrome extension not connected'))
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

function broadcastToCdpClients(evt: unknown): void {
  const msg = JSON.stringify(evt)
  for (const ws of cdpClients) {
    if (ws.readyState !== 1) continue
    ws.send(msg)
  }
}

function sendResponseToCdp(ws: WSContext, res: unknown): void {
  if (ws.readyState !== 1) return
  ws.send(JSON.stringify(res))
}

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

function handleExtensionMessage(data: string): void {
  let parsed: any = null
  try {
    parsed = JSON.parse(data)
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
      const attached = (params ?? {}) as { sessionId?: string; targetInfo?: TargetInfo }
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

    // Broadcast to CDP clients
    broadcastToCdpClients({ method, params, sessionId })
  }
}

function cleanupExtension(): void {
  console.log('[Extension Relay] Extension disconnected')

  if (pingInterval) {
    clearInterval(pingInterval)
    pingInterval = null
  }

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
}

// ==================== Hono Routes ====================

export function createRelayRoutes(): Hono {
  return new Hono()
    .get('/extension', async (c, next) => {
      // Reject if extension already connected
      if (extensionWs && extensionWs.readyState === 1) {
        return c.text('Extension already connected', 409)
      }
      return next()
    }, upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        console.log('[Extension Relay] Extension connected')
        extensionWs = ws

        // Ping to keep connection alive
        pingInterval = setInterval(() => {
          if (!extensionWs || extensionWs.readyState !== 1) return
          extensionWs.send(JSON.stringify({ method: 'ping' }))
        }, 5000)
      },
      onMessage(event) {
        handleExtensionMessage(String(event.data))
      },
      onClose() {
        cleanupExtension()
      },
    })))
    .get('/cdp', async (c, next) => {
      // Reject if extension not connected
      if (!extensionWs || extensionWs.readyState !== 1) {
        return c.text('Extension not connected', 503)
      }
      return next()
    }, upgradeWebSocket(() => {
      let thisWs: WSContext
      return {
        onOpen(_event, ws) {
          console.log('[Extension Relay] CDP client connected')
          thisWs = ws
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
        },
        async onMessage(event) {
          let cmd: any = null
          try {
            cmd = JSON.parse(String(event.data))
          } catch {
            return
          }

          if (!cmd || typeof cmd !== 'object') return
          if (typeof cmd.id !== 'number' || typeof cmd.method !== 'string') return

          if (!extensionWs) {
            sendResponseToCdp(thisWs, {
              id: cmd.id,
              sessionId: cmd.sessionId,
              error: { message: 'Extension not connected' },
            })
            return
          }

          try {
            const result = await routeCdpCommand(cmd)
            sendResponseToCdp(thisWs, { id: cmd.id, sessionId: cmd.sessionId, result })
          } catch (err) {
            sendResponseToCdp(thisWs, {
              id: cmd.id,
              sessionId: cmd.sessionId,
              error: { message: err instanceof Error ? err.message : String(err) },
            })
          }
        },
        onClose() {
          console.log('[Extension Relay] CDP client disconnected')
          cdpClients.delete(thisWs)
        },
      }
    }))
}

// ==================== Public API (for BridgeServer direct calls) ====================

export function getExtensionRelay(): ExtensionRelay {
  return {
    extensionConnected: () => Boolean(extensionWs && extensionWs.readyState === 1),
    getTargets: () => Array.from(connectedTargets.values()),
    sendCommand: async (method: string, params?: unknown, targetId?: string) => {
      if (!extensionWs || extensionWs.readyState !== 1) {
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

      const id = nextExtensionId++
      return await sendToExtension({
        id,
        method: 'forwardCDPCommand',
        params: { method, params, sessionId },
      })
    },
    stop: async () => {
      if (extensionWs) {
        try {
          extensionWs.close(1001, 'Server stopping')
        } catch {
          // ignore
        }
      }
      for (const ws of cdpClients) {
        try {
          ws.close(1001, 'Server stopping')
        } catch {
          // ignore
        }
      }
      cleanupExtension()
    },
  }
}
