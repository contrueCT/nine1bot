import type { TunnelManager } from './index'
import type { NgrokConfig } from '../config/schema'

// 动态导入 ngrok，避免在不需要时加载
let ngrokModule: typeof import('@ngrok/ngrok') | null = null

async function getNgrok() {
  if (!ngrokModule) {
    ngrokModule = await import('@ngrok/ngrok')
  }
  return ngrokModule
}

/**
 * ngrok 隧道实现
 */
export class NgrokTunnel implements TunnelManager {
  private config: NgrokConfig
  private listener: any | null = null
  private url: string | undefined

  constructor(config: NgrokConfig) {
    this.config = config
  }

  async start(port: number): Promise<string> {
    const ngrok = await getNgrok()

    try {
      this.listener = await ngrok.forward({
        addr: port,
        authtoken: this.config.authToken,
        domain: this.config.domain,
        region: this.config.region,
      })

      this.url = this.listener.url() || undefined

      if (!this.url) {
        throw new Error('Failed to get ngrok URL')
      }

      return this.url
    } catch (error: any) {
      if (error.message?.includes('invalid authtoken')) {
        throw new Error('Invalid ngrok authtoken. Get yours at https://dashboard.ngrok.com/authtokens')
      }
      throw error
    }
  }

  async stop(): Promise<void> {
    const ngrok = await getNgrok()

    try {
      if (this.listener) {
        await this.listener.close()
        this.listener = null
      }
      await ngrok.disconnect()
    } catch {
      // 忽略断开连接时的错误
    }

    this.url = undefined
  }

  getUrl(): string | undefined {
    return this.url
  }

  getProvider(): string {
    return 'ngrok'
  }
}
