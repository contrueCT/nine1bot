/**
 * Relay Client - 连接到 Nine1Bot Bridge Server 的 Extension Relay
 *
 * 这个模块负责：
 * 1. 建立与 Bridge Server 的 WebSocket 连接
 * 2. 接收并执行 CDP 命令
 * 3. 将 CDP 事件转发回 Bridge Server
 */

import { toolExecutors } from '../tools'

// 配置 - relay URL 可通过 chrome.storage.sync 修改
const DEFAULT_RELAY_URL = 'ws://127.0.0.1:4096/browser/extension'

/**
 * 从 chrome.storage.sync 获取 relay URL（支持用户自定义）
 */
async function getConfiguredRelayUrl(): Promise<string> {
  try {
    const { relayUrl } = await chrome.storage.sync.get({ relayUrl: DEFAULT_RELAY_URL })
    return relayUrl
  } catch {
    return DEFAULT_RELAY_URL
  }
}
const RECONNECT_INTERVAL = 5000
const PING_INTERVAL = 5000

// WebSocket 连接状态
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let pingTimer: ReturnType<typeof setInterval> | null = null
let isConnecting = false

// 当前活动的标签页 session
const activeSessions = new Map<number, string>() // tabId -> sessionId

/**
 * 生成唯一的 session ID
 */
function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
  return `session_${Date.now()}_${hex}`
}

/**
 * 发送消息到 Relay Server
 */
function sendToRelay(message: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * 发送 CDP 事件到 Relay Server
 */
function forwardCdpEvent(method: string, params?: unknown, sessionId?: string): void {
  sendToRelay({
    method: 'forwardCDPEvent',
    params: { method, params, sessionId },
  })
}

/**
 * 处理来自 Relay Server 的消息
 */
async function handleRelayMessage(data: string): Promise<void> {
  let message: any
  try {
    message = JSON.parse(data)
  } catch {
    console.error('[Relay Client] Failed to parse message:', data)
    return
  }

  // 处理 ping
  if (message.method === 'ping') {
    sendToRelay({ method: 'pong' })
    return
  }

  // 处理 CDP 命令转发请求
  if (message.method === 'forwardCDPCommand') {
    const { id } = message
    const { method, params, sessionId } = message.params || {}

    try {
      const result = await handleCdpCommand(method, params, sessionId)
      sendToRelay({ id, result })
    } catch (error) {
      sendToRelay({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }
}

/**
 * 处理 CDP 命令
 */
async function handleCdpCommand(method: string, params: any, sessionId?: string): Promise<unknown> {
  console.log('[Relay Client] Handling CDP command:', method, 'sessionId:', sessionId)
  console.log('[Relay Client] activeSessions:', Array.from(activeSessions.entries()))

  // 获取 tabId（从 sessionId 或使用当前活动标签）
  let tabId: number | undefined

  if (sessionId) {
    // 从 session 映射中查找 tabId
    for (const [tid, sid] of activeSessions) {
      if (sid === sessionId) {
        tabId = tid
        console.log('[Relay Client] Found tabId from sessionId:', tabId)
        break
      }
    }
  }

  if (!tabId) {
    // 使用当前活动标签
    console.log('[Relay Client] sessionId not found in activeSessions, using active tab')
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    tabId = activeTab?.id
    console.log('[Relay Client] Active tab:', tabId)
  }

  // 根据 CDP method 调用相应的工具
  switch (method) {
    // 扩展工具直接转发（不受 CSP 限制）
    case 'Extension.callTool': {
      const { toolName, args } = params || {}
      // 白名单校验：仅允许已注册的工具名
      const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(toolExecutors))
      if (typeof toolName !== 'string' || !ALLOWED_TOOLS.has(toolName)) {
        throw new Error(`Unknown extension tool: ${toolName}. Available: ${[...ALLOWED_TOOLS].join(', ')}`)
      }
      const executor = toolExecutors[toolName as keyof typeof toolExecutors]
      const toolArgs: Record<string, unknown> = { ...(args || {}) }
      if (tabId && toolArgs.tabId === undefined) {
        toolArgs.tabId = tabId
      }
      return await executor(toolArgs)
    }

    case 'Page.captureScreenshot': {
      console.log('[Relay Client] Taking screenshot for tabId:', tabId)
      const result = await toolExecutors.screenshot({ tabId })
      console.log('[Relay Client] Screenshot result:', result.content[0]?.type, result.isError)
      if (result.content[0]?.type === 'image' && result.content[0].data) {
        return { data: result.content[0].data }
      }
      // Return error details if available
      const errorText = result.content[0]?.text || 'Screenshot failed'
      throw new Error(errorText)
    }

    case 'Page.navigate': {
      const result = await toolExecutors.navigate({ tabId, url: params?.url })
      return { frameId: 'main' }
    }

    case 'Runtime.evaluate': {
      if (!tabId) throw new Error('No active tab')

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (expr: string) => {
          try {
            return { result: { value: eval(expr) } }
          } catch (e) {
            return { exceptionDetails: { text: String(e) } }
          }
        },
        args: [params?.expression || ''],
      })

      const evalResult = results[0]?.result
      return evalResult || {}
    }

    case 'Input.dispatchMouseEvent': {
      if (!tabId) throw new Error('No active tab')

      const { type, x, y, button, clickCount } = params || {}

      // 使用 chrome.debugger API
      await ensureDebuggerAttached(tabId)
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: button || 'left',
        clickCount: clickCount || 1,
      })

      return {}
    }

    case 'Input.dispatchKeyEvent': {
      if (!tabId) throw new Error('No active tab')

      await ensureDebuggerAttached(tabId)
      await chrome.debugger.sendCommand({ tabId }, 'Input.dispatchKeyEvent', params)

      return {}
    }

    case 'Input.insertText': {
      if (!tabId) throw new Error('No active tab')

      await ensureDebuggerAttached(tabId)
      await chrome.debugger.sendCommand({ tabId }, 'Input.insertText', params)

      return {}
    }

    case 'DOM.getDocument': {
      if (!tabId) throw new Error('No active tab')

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          root: {
            nodeId: 1,
            backendNodeId: 1,
            nodeType: 9,
            nodeName: '#document',
            localName: '',
            nodeValue: '',
            childNodeCount: 1,
          },
        }),
      })

      return results[0]?.result || {}
    }

    case 'Page.getLayoutMetrics': {
      if (!tabId) throw new Error('No active tab')

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => ({
          layoutViewport: {
            pageX: window.scrollX,
            pageY: window.scrollY,
            clientWidth: document.documentElement.clientWidth,
            clientHeight: document.documentElement.clientHeight,
          },
          visualViewport: {
            offsetX: 0,
            offsetY: 0,
            pageX: window.scrollX,
            pageY: window.scrollY,
            clientWidth: window.innerWidth,
            clientHeight: window.innerHeight,
            scale: 1,
            zoom: 1,
          },
          contentSize: {
            x: 0,
            y: 0,
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          },
        }),
      })

      return results[0]?.result || {}
    }

    case 'Target.getTargets':
    case 'Target.getTargetInfo':
    case 'Target.setAutoAttach':
    case 'Target.setDiscoverTargets':
      // 这些命令由 Relay Server 处理
      return {}

    default:
      console.warn('[Relay Client] Unhandled CDP method:', method)
      return {}
  }
}

// Debugger 管理
const attachedTabs = new Set<number>()

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return

  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attachedTabs.add(tabId)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already attached'))) {
      throw error
    }
    attachedTabs.add(tabId)
  }
}

/**
 * 监听标签页变化并通知 Relay Server
 */
function setupTabListeners(): void {
  // 新标签页创建
  chrome.tabs.onCreated.addListener((tab) => {
    if (tab.id && tab.url !== 'chrome://newtab/') {
      const sessionId = generateSessionId()
      activeSessions.set(tab.id, sessionId)

      forwardCdpEvent('Target.attachedToTarget', {
        sessionId,
        targetInfo: {
          targetId: String(tab.id),
          type: 'page',
          title: tab.title || '',
          url: tab.url || '',
          attached: true,
        },
        waitingForDebugger: false,
      })
    }
  })

  // 标签页更新（URL/标题变化）
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const sessionId = activeSessions.get(tabId)
    if (!sessionId) return

    if (changeInfo.url || changeInfo.title) {
      forwardCdpEvent('Target.targetInfoChanged', {
        targetInfo: {
          targetId: String(tabId),
          type: 'page',
          title: tab.title || '',
          url: tab.url || '',
          attached: true,
        },
      })
    }
  })

  // 标签页关闭
  chrome.tabs.onRemoved.addListener((tabId) => {
    const sessionId = activeSessions.get(tabId)
    if (sessionId) {
      forwardCdpEvent('Target.detachedFromTarget', {
        sessionId,
        targetId: String(tabId),
      })
      activeSessions.delete(tabId)
      attachedTabs.delete(tabId)
    }
  })

  // 标签页激活
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    let sessionId = activeSessions.get(activeInfo.tabId)

    if (!sessionId) {
      sessionId = generateSessionId()
      activeSessions.set(activeInfo.tabId, sessionId)

      forwardCdpEvent('Target.attachedToTarget', {
        sessionId,
        targetInfo: {
          targetId: String(activeInfo.tabId),
          type: 'page',
          title: tab.title || '',
          url: tab.url || '',
          attached: true,
        },
        waitingForDebugger: false,
      })
    }
  })
}

/**
 * 发送当前所有标签页信息
 */
async function sendInitialTargets(): Promise<void> {
  const tabs = await chrome.tabs.query({})

  for (const tab of tabs) {
    if (!tab.id || tab.url?.startsWith('chrome://')) continue

    const sessionId = generateSessionId()
    activeSessions.set(tab.id, sessionId)

    forwardCdpEvent('Target.attachedToTarget', {
      sessionId,
      targetInfo: {
        targetId: String(tab.id),
        type: 'page',
        title: tab.title || '',
        url: tab.url || '',
        attached: true,
      },
      waitingForDebugger: false,
    })
  }
}

/**
 * 连接到 Relay Server
 */
export function connectToRelay(url: string = DEFAULT_RELAY_URL): void {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    return
  }

  isConnecting = true
  console.log('[Relay Client] Connecting to:', url)

  try {
    ws = new WebSocket(url)

    ws.onopen = () => {
      console.log('[Relay Client] Connected to Relay Server')
      isConnecting = false

      // 清除重连定时器
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      // 设置 ping 定时器
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Relay Server 会发 ping，我们这里保持连接活跃
        }
      }, PING_INTERVAL)

      // 发送当前所有标签页
      sendInitialTargets()
    }

    ws.onmessage = (event) => {
      handleRelayMessage(event.data)
    }

    ws.onclose = () => {
      console.log('[Relay Client] Disconnected from Relay Server')
      cleanup()
      scheduleReconnect(url)
    }

    ws.onerror = (error) => {
      console.error('[Relay Client] WebSocket error:', error)
      isConnecting = false
    }
  } catch (error) {
    console.error('[Relay Client] Failed to connect:', error)
    isConnecting = false
    scheduleReconnect(url)
  }
}

/**
 * 清理连接状态
 */
function cleanup(): void {
  isConnecting = false

  if (pingTimer) {
    clearInterval(pingTimer)
    pingTimer = null
  }

  if (ws) {
    ws = null
  }

  activeSessions.clear()
}

/**
 * 安排重连
 */
function scheduleReconnect(url: string): void {
  if (reconnectTimer) return

  console.log(`[Relay Client] Reconnecting in ${RECONNECT_INTERVAL / 1000}s...`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToRelay(url)
  }, RECONNECT_INTERVAL)
}

/**
 * 断开连接
 */
export function disconnectFromRelay(): void {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  if (ws) {
    ws.close()
    ws = null
  }

  cleanup()
}

/**
 * 获取连接状态
 */
export function isRelayConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

/**
 * 初始化 Relay Client
 */
export function initRelayClient(): void {
  console.log('[Relay Client] Initializing...')

  setupTabListeners()
  console.log('[Relay Client] Tab listeners set up')

  // 监听 debugger 断开
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attachedTabs.delete(source.tabId)
    }
  })

  // 尝试连接（使用 chrome.storage 中配置的 URL）
  console.log('[Relay Client] About to connect...')
  getConfiguredRelayUrl().then((url) => {
    try {
      connectToRelay(url)
    } catch (error) {
      console.error('[Relay Client] Error in connectToRelay:', error)
    }
  })
}
