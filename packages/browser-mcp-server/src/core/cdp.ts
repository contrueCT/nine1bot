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
  const url = new URL('/json/new', cdpUrl)
  url.searchParams.set('url', targetUrl)
  const response = await fetch(url.toString(), { method: 'PUT' })
  if (!response.ok) {
    throw new Error(`Failed to create CDP target: ${response.status}`)
  }
  return response.json()
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
  private pendingMessages = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private eventHandlers = new Map<string, Set<(params: unknown) => void>>()

  constructor(ws: WebSocket) {
    this.ws = ws
    this.ws.on('message', (data) => this.handleMessage(data.toString()))
  }

  private handleMessage(data: string) {
    try {
      const message = JSON.parse(data)

      // 响应消息
      if ('id' in message) {
        const pending = this.pendingMessages.get(message.id)
        if (pending) {
          this.pendingMessages.delete(message.id)
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
    const id = ++this.messageId

    return new Promise((resolve, reject) => {
      this.pendingMessages.set(id, { resolve, reject })

      const message = JSON.stringify({ id, method, params })
      this.ws.send(message, (error) => {
        if (error) {
          this.pendingMessages.delete(id)
          reject(error)
        }
      })

      // 超时处理
      setTimeout(() => {
        if (this.pendingMessages.has(id)) {
          this.pendingMessages.delete(id)
          reject(new Error(`CDP command timeout: ${method}`))
        }
      }, 30000)
    })
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
    this.ws.close()
    this.pendingMessages.clear()
    this.eventHandlers.clear()
  }
}

/**
 * 连接到 CDP WebSocket
 */
export async function connectCdp(wsUrl: string): Promise<CDPSession> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)

    ws.on('open', () => {
      resolve(new CDPSession(ws))
    })

    ws.on('error', (error) => {
      reject(error)
    })

    // 连接超时
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        ws.close()
        reject(new Error('CDP connection timeout'))
      }
    }, 10000)
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
        cssContentSize?: { width?: number; height?: number }
        contentSize?: { width?: number; height?: number }
      }
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      const width = Number(size?.width ?? 0)
      const height = Number(size?.height ?? 0)
      if (width > 0 && height > 0) {
        clip = { x: 0, y: 0, width, height, scale: 1 }
      }
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
    await session.send('Page.navigate', { url })
  })
}
