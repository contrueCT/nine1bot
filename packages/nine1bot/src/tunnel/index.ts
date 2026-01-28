import type { TunnelConfig } from '../config/schema'
import { NgrokTunnel } from './ngrok'
import { NatappTunnel } from './natapp'

/**
 * 隧道管理器接口
 */
export interface TunnelManager {
  /**
   * 启动隧道
   * @param port 本地端口
   * @returns 公网 URL
   */
  start(port: number): Promise<string>

  /**
   * 停止隧道
   */
  stop(): Promise<void>

  /**
   * 获取当前公网 URL
   */
  getUrl(): string | undefined

  /**
   * 获取隧道提供者名称
   */
  getProvider(): string
}

/**
 * 创建隧道管理器
 */
export async function createTunnel(config: TunnelConfig): Promise<TunnelManager> {
  if (!config.enabled) {
    throw new Error('Tunnel is not enabled in configuration')
  }

  switch (config.provider) {
    case 'ngrok':
      if (!config.ngrok?.authToken) {
        throw new Error('ngrok authToken is required. Get yours at https://dashboard.ngrok.com/authtokens')
      }
      return new NgrokTunnel(config.ngrok)

    case 'natapp':
      if (!config.natapp?.authToken) {
        throw new Error('NATAPP authToken is required. Get yours at https://natapp.cn')
      }
      return new NatappTunnel(config.natapp)

    default:
      throw new Error(`Unknown tunnel provider: ${config.provider}`)
  }
}

/**
 * 检查隧道是否可用
 */
export async function checkTunnelAvailability(provider: 'ngrok' | 'natapp'): Promise<boolean> {
  switch (provider) {
    case 'ngrok':
      // ngrok 使用 npm 包，总是可用
      return true

    case 'natapp':
      // 检查 natapp 命令是否可用
      return NatappTunnel.isAvailable()

    default:
      return false
  }
}

export { NgrokTunnel } from './ngrok'
export { NatappTunnel } from './natapp'
