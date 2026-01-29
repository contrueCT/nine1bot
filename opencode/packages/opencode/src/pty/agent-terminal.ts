import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { ScreenBuffer } from "./screen-buffer"

/**
 * AgentTerminal - Agent 控制的持久化终端会话
 *
 * 与普通 PTY 不同，AgentTerminal 提供：
 * - 屏幕缓冲区，让 Agent 能像人一样查看终端内容
 * - 会话归属追踪（属于哪个 OpenCode 会话）
 * - 模式匹配等待功能
 * - 专用事件用于 Web UI 实时展示
 */
export namespace AgentTerminal {
  const log = Log.create({ service: "agent-terminal" })

  const BUFFER_LIMIT = 1024 * 1024 * 2
  const SCREEN_UPDATE_THROTTLE = 100 // ms

  const pty = lazy(async () => {
    const { spawn } = await import("bun-pty")
    return spawn
  })

  // Schema definitions
  export const Info = z
    .object({
      id: Identifier.schema("agt"),
      name: z.string(),
      sessionID: z.string(),
      command: z.string(),
      args: z.array(z.string()),
      cwd: z.string(),
      status: z.enum(["running", "exited"]),
      pid: z.number(),
      rows: z.number(),
      cols: z.number(),
      createdAt: z.number(),
      lastActivity: z.number(),
    })
    .meta({ ref: "AgentTerminal" })

  export type Info = z.infer<typeof Info>

  export const CreateInput = z.object({
    name: z.string().optional(),
    sessionID: z.string(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string(), z.string()).optional(),
    rows: z.number().optional(),
    cols: z.number().optional(),
  })

  export type CreateInput = z.infer<typeof CreateInput>

  // Events
  export const Event = {
    Created: BusEvent.define(
      "agent-terminal.created",
      z.object({ info: Info })
    ),
    Updated: BusEvent.define(
      "agent-terminal.updated",
      z.object({ info: Info })
    ),
    Screen: BusEvent.define(
      "agent-terminal.screen",
      z.object({
        id: Identifier.schema("agt"),
        screen: z.string(),
        cursor: z.object({ row: z.number(), col: z.number() }),
      })
    ),
    Exited: BusEvent.define(
      "agent-terminal.exited",
      z.object({ id: Identifier.schema("agt"), exitCode: z.number() })
    ),
    Closed: BusEvent.define(
      "agent-terminal.closed",
      z.object({ id: Identifier.schema("agt") })
    ),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: ScreenBuffer.Buffer
    rawBuffer: string
    lastScreenUpdate: number
    screenUpdateTimer: ReturnType<typeof setTimeout> | null
  }

  const state = Instance.state(
    () => new Map<string, ActiveSession>(),
    async (sessions) => {
      for (const session of sessions.values()) {
        try {
          session.process.kill()
        } catch {}
        session.buffer.dispose()
        if (session.screenUpdateTimer) {
          clearTimeout(session.screenUpdateTimer)
        }
      }
      sessions.clear()
    }
  )

  /**
   * 列出所有活跃的 Agent 终端
   */
  export function list(sessionID?: string): Info[] {
    const all = Array.from(state().values()).map((s) => s.info)
    if (sessionID) {
      return all.filter((t) => t.sessionID === sessionID)
    }
    return all
  }

  /**
   * 获取指定终端信息
   */
  export function get(id: string): Info | undefined {
    return state().get(id)?.info
  }

  /**
   * 创建新的 Agent 终端
   */
  export async function create(input: CreateInput): Promise<Info> {
    const id = Identifier.create("agt", false)
    const command = input.command || Shell.preferred()
    const args = input.args || []
    const rows = input.rows || 24
    const cols = input.cols || 120

    if (command.endsWith("sh")) {
      // 使用交互式登录 shell，确保加载完整用户环境
      // -l: 登录 shell，加载 .profile/.bash_profile
      // -i: 交互式 shell，加载 .bashrc/.zshrc
      args.push("-l", "-i")
    }

    const cwd = input.cwd || Instance.directory
    const env = {
      ...process.env,
      ...input.env,
      TERM: "xterm-256color",
      OPENCODE_TERMINAL: "1",
      OPENCODE_AGENT_TERMINAL: "1",
    } as Record<string, string>

    log.info("creating agent terminal", { id, command, args, cwd, rows, cols })

    const spawn = await pty()
    const ptyProcess = spawn(command, args, {
      name: "xterm-256color",
      cwd,
      env,
      rows,
      cols,
    })

    const screenBuffer = new ScreenBuffer.Buffer({ rows, cols })
    const now = Date.now()

    const info: Info = {
      id,
      name: input.name || `Terminal ${id.slice(-4)}`,
      sessionID: input.sessionID,
      command,
      args,
      cwd,
      status: "running",
      pid: ptyProcess.pid,
      rows,
      cols,
      createdAt: now,
      lastActivity: now,
    }

    const session: ActiveSession = {
      info,
      process: ptyProcess,
      buffer: screenBuffer,
      rawBuffer: "",
      lastScreenUpdate: 0,
      screenUpdateTimer: null,
    }

    state().set(id, session)

    // 处理 PTY 输出
    ptyProcess.onData((data) => {
      session.info.lastActivity = Date.now()
      session.rawBuffer += data

      // 保持原始缓冲区大小限制
      if (session.rawBuffer.length > BUFFER_LIMIT) {
        session.rawBuffer = session.rawBuffer.slice(-BUFFER_LIMIT)
      }

      // 写入屏幕缓冲区
      session.buffer.writeSync(data)

      // 节流屏幕更新事件
      scheduleScreenUpdate(session)
    })

    // 处理退出
    ptyProcess.onExit(({ exitCode }) => {
      log.info("agent terminal exited", { id, exitCode })
      session.info.status = "exited"

      if (session.screenUpdateTimer) {
        clearTimeout(session.screenUpdateTimer)
        session.screenUpdateTimer = null
      }

      Bus.publish(Event.Exited, { id, exitCode })
    })

    Bus.publish(Event.Created, { info })

    // 等待 shell 启动并发送初始屏幕
    await new Promise((resolve) => setTimeout(resolve, 300))
    publishScreen(session)

    return info
  }

  /**
   * 调度屏幕更新事件（节流）
   */
  function scheduleScreenUpdate(session: ActiveSession) {
    if (session.screenUpdateTimer) return

    const timeSinceLastUpdate = Date.now() - session.lastScreenUpdate
    const delay = Math.max(0, SCREEN_UPDATE_THROTTLE - timeSinceLastUpdate)

    session.screenUpdateTimer = setTimeout(() => {
      session.screenUpdateTimer = null
      session.lastScreenUpdate = Date.now()
      publishScreen(session)
    }, delay)
  }

  /**
   * 发布屏幕更新事件
   */
  function publishScreen(session: ActiveSession) {
    const screen = session.buffer.getScreenText()
    const cursor = session.buffer.getCursor()
    Bus.publish(Event.Screen, {
      id: session.info.id,
      screen,
      cursor,
    })
  }

  /**
   * 向终端发送输入
   */
  export function write(id: string, data: string): boolean {
    const session = state().get(id)
    if (!session || session.info.status !== "running") {
      return false
    }
    session.process.write(data)
    session.info.lastActivity = Date.now()
    return true
  }

  /**
   * 获取当前屏幕内容
   */
  export function getScreen(id: string): string | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getScreenText()
  }

  /**
   * 获取屏幕行数组
   */
  export function getScreenLines(id: string): string[] | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getScreen()
  }

  /**
   * 获取滚动历史
   */
  export function getScrollback(id: string, lines?: number): string[] | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getScrollback(lines)
  }

  /**
   * 获取完整视图（历史 + 屏幕）
   */
  export function getFullView(id: string, historyLines = 50): string | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getFullView(historyLines)
  }

  /**
   * 获取光标位置
   */
  export function getCursor(id: string): ScreenBuffer.CursorPosition | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getCursor()
  }

  /**
   * 获取终端详细信息
   */
  export function getScreenInfo(id: string): ScreenBuffer.ScreenInfo | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.buffer.getInfo()
  }

  /**
   * 等待特定模式出现
   */
  export async function waitFor(
    id: string,
    pattern: string | RegExp,
    timeout = 30000
  ): Promise<{ matched: boolean; timedOut: boolean; screen?: string }> {
    const session = state().get(id)
    if (!session) {
      return { matched: false, timedOut: false }
    }

    const result = await session.buffer.waitForPattern(pattern, timeout)
    return {
      ...result,
      screen: session.buffer.getScreenText(),
    }
  }

  /**
   * 调整终端大小
   */
  export function resize(id: string, rows: number, cols: number): boolean {
    const session = state().get(id)
    if (!session || session.info.status !== "running") {
      return false
    }

    session.process.resize(cols, rows)
    session.buffer.resize(rows, cols)
    session.info.rows = rows
    session.info.cols = cols

    Bus.publish(Event.Updated, { info: session.info })
    return true
  }

  /**
   * 关闭终端
   */
  export async function close(id: string): Promise<boolean> {
    const session = state().get(id)
    if (!session) {
      return false
    }

    log.info("closing agent terminal", { id })

    if (session.screenUpdateTimer) {
      clearTimeout(session.screenUpdateTimer)
    }

    try {
      session.process.kill()
    } catch {}

    session.buffer.dispose()
    state().delete(id)

    Bus.publish(Event.Closed, { id })
    return true
  }

  /**
   * 获取原始输出缓冲区
   */
  export function getRawBuffer(id: string): string | undefined {
    const session = state().get(id)
    if (!session) return undefined
    return session.rawBuffer
  }
}
