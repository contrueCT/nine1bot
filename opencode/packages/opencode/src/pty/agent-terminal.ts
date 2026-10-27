import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { type IPty } from "bun-pty"
import z from "zod"
import { Identifier } from "../id/id"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { ProjectEnvironment } from "../project/environment"
import { lazy } from "@opencode-ai/util/lazy"
import { Shell } from "@/shell/shell"
import { ScreenBuffer } from "./screen-buffer"
import { captureBufferSnapshot } from "./buffer-snapshot"
import path from "path"

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
  const OUTPUT_FLUSH_INTERVAL = 25 // ms
  const OUTPUT_FLUSH_BYTES = 64 * 1024
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

  export const OutputChunk = z.object({
    seq: z.number().int().nonnegative(),
    data: z.string(),
  })

  export type OutputChunk = z.infer<typeof OutputChunk>

  export const BufferSnapshot = z.object({
    buffer: z.string(),
    chunks: z.array(OutputChunk),
    latestSeq: z.number().int().nonnegative(),
    firstSeq: z.number().int().nonnegative(),
    reset: z.boolean(),
    screen: z.object({
      screenAnsi: z.string(),
      cursor: z.object({ row: z.number(), col: z.number() }),
    }).optional(),
  })

  export type BufferSnapshot = z.infer<typeof BufferSnapshot>

  export interface ScreenSnapshot {
    sessionID: string
    screen: string
    screenAnsi: string
    cursor: ScreenBuffer.CursorPosition
    info: ScreenBuffer.ScreenInfo
    fullView?: string
  }

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
        sessionID: z.string(),
        screen: z.string(),
        screenAnsi: z.string(),
        cursor: z.object({ row: z.number(), col: z.number() }),
      })
    ),
    /** 原始数据输出事件 - 用于前端 xterm 直接渲染和保持滚动历史 */
    Output: BusEvent.define(
      "agent-terminal.output",
      z.object({
        id: Identifier.schema("agt"),
        sessionID: z.string(),
        seq: z.number().int().nonnegative(),
        data: z.string(),
      })
    ),
    Exited: BusEvent.define(
      "agent-terminal.exited",
      z.object({ id: Identifier.schema("agt"), sessionID: z.string(), exitCode: z.number() })
    ),
    Closed: BusEvent.define(
      "agent-terminal.closed",
      z.object({ id: Identifier.schema("agt"), sessionID: z.string() })
    ),
  }

  interface ActiveSession {
    info: Info
    process: IPty
    buffer: ScreenBuffer.Buffer
    rawBuffer: string
    outputSeq: number
    outputChunks: OutputChunk[]
    outputChunkBytes: number
    pendingOutput: string
    outputFlushTimer: ReturnType<typeof setTimeout> | null
    outputPublishChain: Promise<void>
    lastScreenUpdate: number
    screenUpdateTimer: ReturnType<typeof setTimeout> | null
    screenPublishChain: Promise<void>
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
        if (session.outputFlushTimer) {
          clearTimeout(session.outputFlushTimer)
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
  export function get(id: string, sessionID: string): Info | undefined {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    return session.info
  }

  function belongsToSession(session: ActiveSession, sessionID: string) {
    return session.info.sessionID === sessionID
  }

  function shellArgs(command: string, inputArgs?: string[]) {
    const args = [...(inputArgs ?? [])]
    if (args.length > 0) return args

    const basename = (process.platform === "win32" ? path.win32.basename(command) : path.basename(command))
      .toLowerCase()
      .replace(/\.exe$/, "")

    if (basename === "bash" || basename === "zsh") return ["-l", "-i"]
    if (basename === "sh" || basename === "dash") return ["-i"]
    return args
  }

  /**
   * 创建新的 Agent 终端
   */
  export async function create(input: CreateInput): Promise<Info> {
    const id = Identifier.create("agt", false)
    const command = input.command || Shell.preferred()
    const args = shellArgs(command, input.args)
    const rows = input.rows || 24
    const cols = input.cols || 120

    const cwd = input.cwd || Instance.directory
    const projectEnv = await ProjectEnvironment.getAll(Instance.project.id)
    const env = {
      ...process.env,
      ...projectEnv,
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
      outputSeq: 0,
      outputChunks: [],
      outputChunkBytes: 0,
      pendingOutput: "",
      outputFlushTimer: null,
      outputPublishChain: Promise.resolve(),
      lastScreenUpdate: 0,
      screenUpdateTimer: null,
      screenPublishChain: Promise.resolve(),
    }

    state().set(id, session)

    // 处理 PTY 输出
    ptyProcess.onData((data) => {
      session.info.lastActivity = Date.now()
      session.rawBuffer += data
      session.pendingOutput += data

      // 保持原始缓冲区大小限制
      if (session.rawBuffer.length > BUFFER_LIMIT) {
        session.rawBuffer = session.rawBuffer.slice(-BUFFER_LIMIT)
      }

      scheduleOutputFlush(session)

      void session.buffer.write(data).then(
        () => scheduleScreenUpdate(session),
        (error) => log.warn("failed to write terminal screen buffer", { id, error }),
      )
    })

    // 处理退出
    ptyProcess.onExit(({ exitCode }) => {
      log.info("agent terminal exited", { id, exitCode })
      session.info.status = "exited"

      if (session.screenUpdateTimer) {
        clearTimeout(session.screenUpdateTimer)
        session.screenUpdateTimer = null
      }
      if (session.outputFlushTimer) {
        clearTimeout(session.outputFlushTimer)
        session.outputFlushTimer = null
      }

      void flushOutput(session).finally(() => {
        Bus.publish(Event.Exited, { id, sessionID: session.info.sessionID, exitCode })
      })
    })

    Bus.publish(Event.Created, { info })

    // 等待 shell 启动并发送初始屏幕
    await new Promise((resolve) => setTimeout(resolve, 300))
    await publishScreen(session)

    return info
  }

  function addOutputChunk(session: ActiveSession, chunk: OutputChunk) {
    session.outputChunks.push(chunk)
    session.outputChunkBytes += chunk.data.length
    while (session.outputChunkBytes > BUFFER_LIMIT && session.outputChunks.length > 0) {
      const removed = session.outputChunks.shift()
      if (removed) session.outputChunkBytes -= removed.data.length
    }
  }

  function scheduleOutputFlush(session: ActiveSession) {
    if (session.pendingOutput.length >= OUTPUT_FLUSH_BYTES) {
      void flushOutput(session)
      return
    }
    if (session.outputFlushTimer) return
    session.outputFlushTimer = setTimeout(() => {
      session.outputFlushTimer = null
      void flushOutput(session)
    }, OUTPUT_FLUSH_INTERVAL)
  }

  async function flushOutput(session: ActiveSession) {
    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer)
      session.outputFlushTimer = null
    }
    if (!session.pendingOutput) return session.outputPublishChain

    const data = session.pendingOutput
    session.pendingOutput = ""
    const seq = ++session.outputSeq
    addOutputChunk(session, { seq, data })

    session.outputPublishChain = session.outputPublishChain.then(() =>
      Bus.publish(Event.Output, {
        id: session.info.id,
        sessionID: session.info.sessionID,
        seq,
        data,
      }).then(() => undefined),
    )
    session.outputPublishChain = session.outputPublishChain.catch((error) => {
      log.warn("failed to publish terminal output", { id: session.info.id, seq, error })
    })
    return session.outputPublishChain
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
      session.screenPublishChain = session.screenPublishChain.then(() => publishScreen(session))
      session.screenPublishChain = session.screenPublishChain.catch((error) => {
        log.warn("failed to publish terminal screen", { id: session.info.id, error })
      })
    }, delay)
  }

  /**
   * 发布屏幕更新事件
   */
  async function publishScreen(session: ActiveSession) {
    await session.buffer.flush()
    const screen = session.buffer.getScreenText()
    const screenAnsi = session.buffer.getScreenAnsi()
    const cursor = session.buffer.getCursor()
    await Bus.publish(Event.Screen, {
      id: session.info.id,
      sessionID: session.info.sessionID,
      screen,
      screenAnsi,
      cursor,
    })
  }

  /**
   * 向终端发送输入
   */
  export function write(id: string, data: string, sessionID: string): boolean {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID) || session.info.status !== "running") {
      return false
    }
    session.process.write(data)
    session.info.lastActivity = Date.now()
    return true
  }

  /**
   * 获取当前屏幕内容
   */
  export async function getScreen(id: string, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreenText()
  }

  /**
   * 获取带 ANSI 转义序列的屏幕内容
   */
  export async function getScreenAnsi(id: string, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreenAnsi()
  }

  /**
   * 获取屏幕行数组
   */
  export async function getScreenLines(id: string, sessionID: string): Promise<string[] | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScreen()
  }

  /**
   * 获取滚动历史
   */
  export async function getScrollback(id: string, lines: number | undefined, sessionID: string): Promise<string[] | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getScrollback(lines)
  }

  /**
   * 获取完整视图（历史 + 屏幕）
   */
  export async function getFullView(id: string, historyLines: number, sessionID: string): Promise<string | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getFullView(historyLines)
  }

  /**
   * 获取光标位置
   */
  export async function getCursor(id: string, sessionID: string): Promise<ScreenBuffer.CursorPosition | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getCursor()
  }

  /**
   * 获取终端详细信息
   */
  export async function getScreenInfo(id: string, sessionID: string): Promise<ScreenBuffer.ScreenInfo | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return session.buffer.getInfo()
  }

  export async function getScreenSnapshot(
    id: string,
    sessionID: string,
    historyLines?: number,
  ): Promise<ScreenSnapshot | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    await session.buffer.flush()
    return {
      sessionID: session.info.sessionID,
      screen: session.buffer.getScreenText(),
      screenAnsi: session.buffer.getScreenAnsi(),
      cursor: session.buffer.getCursor(),
      info: session.buffer.getInfo(),
      fullView: historyLines === undefined ? undefined : session.buffer.getFullView(historyLines),
    }
  }

  /**
   * 等待特定模式出现
   */
  export async function waitFor(
    id: string,
    pattern: string | RegExp,
    timeout: number,
    sessionID: string,
  ): Promise<{ matched: boolean; timedOut: boolean; screen?: string }> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) {
      return { matched: false, timedOut: false }
    }

    const result = await session.buffer.waitForPattern(pattern, timeout)
    await session.buffer.flush()
    return {
      ...result,
      screen: session.buffer.getScreenText(),
    }
  }

  /**
   * 调整终端大小
   */
  export async function resize(id: string, rows: number, cols: number, sessionID: string): Promise<boolean> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID) || session.info.status !== "running") {
      return false
    }

    session.process.resize(cols, rows)
    await session.buffer.resize(rows, cols)
    session.info.rows = rows
    session.info.cols = cols

    Bus.publish(Event.Updated, { info: session.info })
    void publishScreen(session)
    return true
  }

  /**
   * 关闭终端
   */
  export async function close(id: string, sessionID: string): Promise<boolean> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) {
      return false
    }

    log.info("closing agent terminal", { id })

    if (session.screenUpdateTimer) {
      clearTimeout(session.screenUpdateTimer)
    }
    if (session.outputFlushTimer) {
      clearTimeout(session.outputFlushTimer)
      session.outputFlushTimer = null
    }
    await flushOutput(session)
    await session.buffer.flush()

    try {
      session.process.kill()
    } catch {}

    session.buffer.dispose()
    state().delete(id)

    Bus.publish(Event.Closed, { id, sessionID: session.info.sessionID })
    return true
  }

  /**
   * 获取原始输出缓冲区
   */
  export async function getBuffer(id: string, afterSeq: number | undefined, sessionID: string): Promise<BufferSnapshot | undefined> {
    const session = state().get(id)
    if (!session || !belongsToSession(session, sessionID)) return undefined
    // flushOutput assigns the sequence synchronously. Capture the screen queue
    // position before awaiting publication or allowing later PTY writes in.
    void flushOutput(session)
    return captureBufferSnapshot(session, afterSeq)
  }
}
