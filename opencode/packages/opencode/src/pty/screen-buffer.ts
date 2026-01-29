import { Terminal } from "@xterm/headless"

/**
 * ScreenBuffer - 使用 xterm-headless 实现的终端屏幕缓冲区
 *
 * 提供完整的终端模拟功能，包括：
 * - ANSI 转义序列解析
 * - 备用屏幕缓冲区（vim 等全屏应用）
 * - 光标位置追踪
 * - 滚动历史
 */
export namespace ScreenBuffer {
  export interface Config {
    rows: number
    cols: number
    scrollback: number
  }

  export interface CursorPosition {
    row: number
    col: number
  }

  export interface ScreenInfo {
    rows: number
    cols: number
    cursor: CursorPosition
    scrollbackLength: number
  }

  const DEFAULT_CONFIG: Config = {
    rows: 24,
    cols: 120,
    scrollback: 1000,
  }

  export class Buffer {
    private term: Terminal
    private config: Config

    constructor(config: Partial<Config> = {}) {
      this.config = { ...DEFAULT_CONFIG, ...config }
      this.term = new Terminal({
        rows: this.config.rows,
        cols: this.config.cols,
        scrollback: this.config.scrollback,
        allowProposedApi: true,
      })
    }

    /**
     * 处理 PTY 输出数据
     */
    async write(data: string): Promise<void> {
      return new Promise((resolve) => this.term.write(data, resolve))
    }

    /**
     * 同步写入（不等待处理完成）
     */
    writeSync(data: string): void {
      this.term.write(data)
    }

    /**
     * 获取当前可见屏幕的文本内容
     */
    getScreen(): string[] {
      const lines: string[] = []
      const buffer = this.term.buffer.active
      for (let i = 0; i < this.term.rows; i++) {
        const line = buffer.getLine(i)
        if (line) {
          lines.push(line.translateToString().trimEnd())
        } else {
          lines.push("")
        }
      }
      return lines
    }

    /**
     * 获取屏幕内容为单个字符串
     */
    getScreenText(): string {
      return this.getScreen().join("\n")
    }

    /**
     * 获取滚动历史
     */
    getScrollback(lines?: number): string[] {
      const result: string[] = []
      const buffer = this.term.buffer.active
      const scrollbackLength = buffer.baseY

      const start = lines ? Math.max(0, scrollbackLength - lines) : 0
      for (let i = start; i < scrollbackLength; i++) {
        const line = buffer.getLine(i - scrollbackLength)
        if (line) {
          result.push(line.translateToString().trimEnd())
        }
      }
      return result
    }

    /**
     * 获取完整视图（历史 + 当前屏幕）
     */
    getFullView(historyLines = 50): string {
      const history = this.getScrollback(historyLines)
      const screen = this.getScreen()
      return [...history, ...screen].join("\n")
    }

    /**
     * 获取光标位置
     */
    getCursor(): CursorPosition {
      const buffer = this.term.buffer.active
      return {
        row: buffer.cursorY,
        col: buffer.cursorX,
      }
    }

    /**
     * 获取终端信息
     */
    getInfo(): ScreenInfo {
      const buffer = this.term.buffer.active
      return {
        rows: this.term.rows,
        cols: this.term.cols,
        cursor: this.getCursor(),
        scrollbackLength: buffer.baseY,
      }
    }

    /**
     * 调整终端大小
     */
    resize(rows: number, cols: number): void {
      this.term.resize(cols, rows)
      this.config.rows = rows
      this.config.cols = cols
    }

    /**
     * 等待特定模式出现在屏幕上
     */
    async waitForPattern(pattern: string | RegExp, timeout = 30000): Promise<{ matched: boolean; timedOut: boolean }> {
      const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern
      const startTime = Date.now()

      while (Date.now() - startTime < timeout) {
        const screenText = this.getFullView(20)
        if (regex.test(screenText)) {
          return { matched: true, timedOut: false }
        }
        await new Promise((resolve) => setTimeout(resolve, 100))
      }

      return { matched: false, timedOut: true }
    }

    /**
     * 清理资源
     */
    dispose(): void {
      this.term.dispose()
    }
  }
}
