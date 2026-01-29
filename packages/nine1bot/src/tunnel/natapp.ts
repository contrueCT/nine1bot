import { spawn, type ChildProcess } from 'child_process'
import { promisify } from 'util'
import { exec } from 'child_process'
import type { TunnelManager } from './index'
import type { NatappConfig } from '../config/schema'

const execAsync = promisify(exec)

/**
 * NATAPP 隧道实现
 *
 * NATAPP 是国内的内网穿透服务，需要用户：
 * 1. 注册账号：https://natapp.cn
 * 2. 创建隧道，获取 authtoken
 * 3. 下载 NATAPP 客户端并放入 PATH
 */
export class NatappTunnel implements TunnelManager {
  private config: NatappConfig
  private process: ChildProcess | null = null
  private url: string | undefined

  constructor(config: NatappConfig) {
    this.config = config
  }

  /**
   * 检查 NATAPP 客户端是否可用
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execAsync('natapp -version')
      return true
    } catch {
      return false
    }
  }

  async start(port: number): Promise<string> {
    // 检查 natapp 是否可用
    const available = await NatappTunnel.isAvailable()
    if (!available) {
      throw new Error(
        'NATAPP client not found. Please download from https://natapp.cn and add to PATH'
      )
    }

    return new Promise((resolve, reject) => {
      const args = ['-authtoken', this.config.authToken]

      // 如果指定了 clientId（隧道 ID），添加参数
      if (this.config.clientId) {
        args.push('-clienttoken', this.config.clientId)
      }

      this.process = spawn('natapp', args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let output = ''
      let resolved = false
      let timeoutId: ReturnType<typeof setTimeout> | null = null

      // 清理函数
      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId)
          timeoutId = null
        }
        this.process?.stdout?.removeAllListeners('data')
        this.process?.stderr?.removeAllListeners('data')
        this.process?.removeAllListeners('error')
        this.process?.removeAllListeners('close')
      }

      // 杀死进程并拒绝 Promise
      const killAndReject = (error: Error) => {
        if (!resolved) {
          resolved = true
          cleanup()
          try {
            this.process?.kill('SIGTERM')
          } catch {
            // 忽略杀死进程时的错误
          }
          this.process = null
          reject(error)
        }
      }

      const handleData = (data: Buffer) => {
        output += data.toString()

        // NATAPP 输出格式可能是：
        // Tunnel established at http://xxx.natapp.cn
        // 或者: Forwarding http://xxx.natapp.cn -> 127.0.0.1:4096
        const patterns = [
          /Tunnel established at (https?:\/\/[^\s]+)/,
          /Forwarding\s+(https?:\/\/[^\s]+)/,
          /(https?:\/\/[a-z0-9]+\.natapp[a-z.]*\.(cn|cc))/i,
        ]

        for (const pattern of patterns) {
          const match = output.match(pattern)
          if (match && !resolved) {
            resolved = true
            cleanup()
            this.url = match[1]
            resolve(this.url)
            return
          }
        }
      }

      this.process.stdout?.on('data', handleData)
      this.process.stderr?.on('data', handleData)

      this.process.on('error', (error) => {
        killAndReject(new Error(`Failed to start NATAPP: ${error.message}`))
      })

      this.process.on('close', (code) => {
        if (!resolved) {
          resolved = true
          cleanup()
          if (code !== 0) {
            reject(new Error(`NATAPP exited with code ${code}. Output: ${output}`))
          }
        }
      })

      // 超时处理
      timeoutId = setTimeout(() => {
        killAndReject(new Error(`Timeout waiting for NATAPP tunnel. Output: ${output}`))
      }, 30000)
    })
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill('SIGTERM')

      // 等待进程退出
      await new Promise<void>((resolve) => {
        if (this.process) {
          this.process.on('close', () => resolve())
          // 如果 5 秒后还没退出，强制杀死
          setTimeout(() => {
            this.process?.kill('SIGKILL')
            resolve()
          }, 5000)
        } else {
          resolve()
        }
      })

      this.process = null
    }
    this.url = undefined
  }

  getUrl(): string | undefined {
    return this.url
  }

  getProvider(): string {
    return 'natapp'
  }
}
