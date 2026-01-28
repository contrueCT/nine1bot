import { resolve } from 'path'
import type { ServerConfig, AuthConfig } from '../config/schema'

export interface ServerInstance {
  url: string
  hostname: string
  port: number
  stop: () => Promise<void>
}

export interface StartServerOptions {
  server: ServerConfig
  auth: AuthConfig
  configPath: string
}

/**
 * 启动 OpenCode 服务器
 */
export async function startServer(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, configPath } = options

  // 设置环境变量
  process.env.OPENCODE_CONFIG = configPath

  // 如果启用了认证，设置密码
  if (auth.enabled && auth.password) {
    process.env.OPENCODE_SERVER_PASSWORD = auth.password
    process.env.OPENCODE_SERVER_USERNAME = 'nine1bot'
  }

  // 动态导入 opencode 服务器模块
  // 路径相对于 nine1bot 包的位置
  const opencodeServerPath = resolve(__dirname, '../../../../opencode/packages/opencode/src/server/server.ts')

  try {
    // 尝试导入 opencode 服务器
    const { Server } = await import(opencodeServerPath)

    const serverInstance = await Server.listen({
      port: server.port,
      hostname: server.hostname,
      cors: [],
    })

    return {
      url: serverInstance.url,
      hostname: serverInstance.hostname,
      port: serverInstance.port,
      stop: async () => {
        // OpenCode 服务器的停止逻辑
        serverInstance.server?.stop?.()
      },
    }
  } catch (error: any) {
    // 如果直接导入失败，尝试使用子进程启动
    console.warn('Direct import failed, falling back to subprocess:', error.message)
    return startServerProcess(options)
  }
}

/**
 * 使用子进程启动服务器（备用方案）
 */
async function startServerProcess(options: StartServerOptions): Promise<ServerInstance> {
  const { server, auth, configPath } = options
  const { spawn } = await import('child_process')

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      OPENCODE_CONFIG: configPath,
    }

    if (auth.enabled && auth.password) {
      env.OPENCODE_SERVER_PASSWORD = auth.password
      env.OPENCODE_SERVER_USERNAME = 'nine1bot'
    }

    const opencodeEntry = '../../opencode/packages/opencode/src/index.ts'
    const args = ['run', opencodeEntry, 'serve', '--port', String(server.port)]

    if (server.hostname !== '127.0.0.1') {
      args.push('--hostname', server.hostname)
    }

    const proc = spawn('bun', args, {
      cwd: __dirname,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let resolved = false

    const handleOutput = (data: Buffer) => {
      output += data.toString()
      console.log(data.toString())

      // 检测服务器启动成功
      const urlMatch = output.match(/Local:\s*(https?:\/\/[^\s]+)/)
      if (urlMatch && !resolved) {
        resolved = true
        resolve({
          url: urlMatch[1],
          hostname: server.hostname,
          port: server.port,
          stop: async () => {
            proc.kill('SIGTERM')
          },
        })
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true
        reject(new Error(`Failed to start server: ${error.message}`))
      }
    })

    proc.on('close', (code) => {
      if (!resolved && code !== 0) {
        resolved = true
        reject(new Error(`Server exited with code ${code}`))
      }
    })

    // 超时处理
    setTimeout(() => {
      if (!resolved) {
        resolved = true
        // 假设服务器已启动
        resolve({
          url: `http://${server.hostname}:${server.port}`,
          hostname: server.hostname,
          port: server.port,
          stop: async () => {
            proc.kill('SIGTERM')
          },
        })
      }
    }, 10000)
  })
}
