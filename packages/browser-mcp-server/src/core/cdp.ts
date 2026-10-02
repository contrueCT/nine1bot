/**
 * Chrome DevTools Protocol (CDP) 连接实现
 * 参考 OpenClaw 的实现方式
 */

import WebSocket from 'ws'

export interface CDPTarget {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export interface CDPVersion {
  Browser: string
  'Protocol-Version': string
  'User-Agent': string
  'V8-Version': string
  'WebKit-Version': string
  webSocketDebuggerUrl: string
}

/**
 * 获取 CDP 端点的版本信息
 */
export async function getCdpVersion(cdpUrl: string): Promise<CDPVersion> {
  const url = new URL('/json/version', cdpUrl)
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to get CDP version: ${response.status}`)
  }
  return response.json()
}

/**
 * 列出所有可调试的目标（标签页）
 */
export async function listCdpTargets(cdpUrl: string): Promise<CDPTarget[]> {
  const url = new URL('/json/list', cdpUrl)
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to list CDP targets: ${response.status}`)
  }
  return response.json()
}

/**
 * 创建新标签页
 */
export async function createCdpTarget(cdpUrl: string, targetUrl: string): Promise<CDPTarget> {
  try { new URL(targetUrl) } catch { throw new Error('Failed to create CDP target: invalid URL') }
  const url = new URL('/json/new', cdpUrl)
  // Chromium expects the escaped URL as the raw query, not a named `url` parameter.
  url.search = encodeURIComponent(targetUrl)
  const response = await fetch(url.toString(), { method: 'PUT' })
  if (!response.ok) {
    throw new Error(`Failed to create CDP target: ${response.status}`)
  }
  const target = await response.json() as CDPTarget
  if (!target || typeof target.id !== 'string' || !target.id.trim() || target.type !== 'page') {
    throw new Error('Failed to create CDP target: invalid page target returned')
  }
  return target
}

/**
 * 关闭标签页
 */
export async function closeCdpTarget(cdpUrl: string, targetId: string): Promise<void> {
  const url = new URL(`/json/close/${targetId}`, cdpUrl)
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to close CDP target: ${response.status}`)
  }
}

/**
 * 激活标签页
 */
export async function activateCdpTarget(cdpUrl: string, targetId: string): Promise<void> {
  const url = new URL(`/json/activate/${targetId}`, cdpUrl)
  const response = await fetch(url.toString())
  if (!response.ok) {
    throw new Error(`Failed to activate CDP target: ${response.status}`)
  }
}

/**
 * CDP WebSocket 会话
 */
export class CDPSession {
  private ws: WebSocket
  private messageId = 0
  private closed = false
  private pendingMessages = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private eventHandlers = new Map<string, Set<(params: unknown) => void>>()

  constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (data) => this.handleMessage(data.toString()))
    this.ws.on('close', () => this.failPending(new Error('CDP session closed')))
    this.ws.on('error', (error) => this.failPending(error))
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data)

      // 响应消息
      if ('id' in message) {
        const pending = this.pendingMessages.get(message.id)
        if (pending) {
          this.pendingMessages.delete(message.id)
          clearTimeout(pending.timer)
          if (message.error) {
            pending.reject(new Error(message.error.message || 'CDP error'))
          } else {
            pending.resolve(message.result)
          }
        }
      }

      // 事件消息
      if ('method' in message) {
        const handlers = this.eventHandlers.get(message.method)
        if (handlers) {
          for (const handler of handlers) {
            handler(message.params)
          }
        }
      }
    } catch (error) {
      console.error('CDP message parse error:', error)
    }
  }

  /**
   * 发送 CDP 命令
   */
  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (this.closed || this.ws.readyState !== WebSocket.OPEN) throw new Error('CDP session closed')
    const id = ++this.messageId
    const message = JSON.stringify({ id, method, params })

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingMessages.delete(id)
        reject(new Error(`CDP command timeout: ${method}`))
      }, 30000)
      this.pendingMessages.set(id, { resolve, reject, timer })

      const fail = (error: Error) => {
        const pending = this.pendingMessages.get(id)
        if (!pending) return
        this.pendingMessages.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      }
      try {
        this.ws.send(message, (error) => { if (error) fail(error) })
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private failPending(error: Error): void {
    this.closed = true
    for (const pending of this.pendingMessages.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pendingMessages.clear()
    this.eventHandlers.clear()
  }

  /**
   * 监听 CDP 事件
   */
  on(event: string, handler: (params: unknown) => void) {
    let handlers = this.eventHandlers.get(event)
    if (!handlers) {
      handlers = new Set()
      this.eventHandlers.set(event, handlers)
    }
    handlers.add(handler)
  }

  /**
   * 关闭会话
   */
  close() {
    this.failPending(new Error('CDP session closed'))
    this.ws.close()
  }
}

/**
 * 连接到 CDP WebSocket
 */
export async function connectCdp(wsUrl: string): Promise<CDPSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      reject(new Error('CDP connection timeout'))
      ws.terminate()
    }, 10000)
    const onError = (error: Error) => {
      clearTimeout(timer)
      reject(error)
    }
    const onClose = () => {
      clearTimeout(timer)
      reject(new Error('CDP connection closed before opening'))
    }
    ws.once('error', onError)
    ws.once('close', onClose)
    ws.once('open', () => {
      clearTimeout(timer)
      ws.off('error', onError)
      ws.off('close', onClose)
      resolve(new CDPSession(ws))
    })
  })
}

/**
 * 执行 CDP 命令并自动管理连接
 */
export async function withCdpSession<T>(
  wsUrl: string,
  callback: (session: CDPSession) => Promise<T>
): Promise<T> {
  const session = await connectCdp(wsUrl)
  try {
    return await callback(session)
  } finally {
    session.close()
  }
}

/**
 * 截取页面截图
 */
export async function captureScreenshot(wsUrl: string, options?: {
  fullPage?: boolean
  format?: 'png' | 'jpeg'
  quality?: number
}): Promise<Buffer> {
  return withCdpSession(wsUrl, async (session) => {
    await session.send('Page.enable')

    let clip: { x: number; y: number; width: number; height: number; scale: number } | undefined

    if (options?.fullPage) {
      const metrics = await session.send('Page.getLayoutMetrics') as {
        cssContentSize?: { x?: number; y?: number; width?: number; height?: number }
        contentSize?: { x?: number; y?: number; width?: number; height?: number }
      }
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      const width = size?.width
      const height = size?.height
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 ||
          typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
        throw new Error('Full-page screenshot failed: invalid page layout metrics')
      }
      clip = { x: size?.x ?? 0, y: size?.y ?? 0, width, height, scale: 1 }
    }

    const format = options?.format ?? 'png'
    const quality = format === 'jpeg' ? Math.max(0, Math.min(100, options?.quality ?? 85)) : undefined

    const result = await session.send('Page.captureScreenshot', {
      format,
      ...(quality !== undefined ? { quality } : {}),
      fromSurface: true,
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    }) as { data?: string }

    const base64 = result?.data
    if (!base64) {
      throw new Error('Screenshot failed: missing data')
    }

    return Buffer.from(base64, 'base64')
  })
}

/**
 * 在页面中执行 JavaScript
 */
export async function evaluateScript(wsUrl: string, expression: string): Promise<unknown> {
  return withCdpSession(wsUrl, async (session) => {
    await session.send('Runtime.enable')

    const result = await session.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    }) as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: string }
    }

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Script evaluation failed')
    }

    return result.result?.value
  })
}

/**
 * 模拟鼠标点击
 */
export async function mouseClick(wsUrl: string, x: number, y: number, options?: {
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}): Promise<void> {
  return withCdpSession(wsUrl, async (session) => {
    const button = options?.button ?? 'left'
    const clickCount = options?.clickCount ?? 1

    // 移动鼠标
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    })

    // 按下
    await session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button,
      clickCount,
    })

    // 释放
    await session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button,
      clickCount,
    })
  })
}

/**
 * 模拟键盘输入
 */
export async function typeText(wsUrl: string, text: string, delay = 12): Promise<void> {
  return withCdpSession(wsUrl, async (session) => {
    for (const char of text) {
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        text: char,
      })
      await session.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        text: char,
      })

      if (delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }
  })
}

/**
 * 导航到 URL
 */
export async function navigateToUrl(wsUrl: string, url: string): Promise<void> {
  return withCdpSession(wsUrl, async (session) => {
    await session.send('Page.enable')
    const result = await session.send('Page.navigate', { url }) as { errorText?: string }
    if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
  })
}
