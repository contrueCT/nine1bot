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
     * 获取带 ANSI 转义序列的屏幕内容（用于前端渲染）
     *
     * 遍历每个单元格，提取文本和样式属性，生成 ANSI 序列
     */
    getScreenAnsi(): string {
      const lines: string[] = []
      const buffer = this.term.buffer.active

      for (let y = 0; y < this.term.rows; y++) {
        const line = buffer.getLine(y)
        if (!line) {
          lines.push("")
          continue
        }

        let lineStr = ""
        let lastFg: number | undefined
        let lastBg: number | undefined
        let lastBold = false
        let lastItalic = false
        let lastUnderline = false
        let lastDim = false

        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x)
          if (!cell) continue

          const char = cell.getChars()
          if (!char) continue

          // 获取样式属性
          const fg = cell.getFgColor()
          const bg = cell.getBgColor()
          const bold = cell.isBold() === 1
          const italic = cell.isItalic() === 1
          const underline = cell.isUnderline() === 1
          const dim = cell.isDim() === 1

          // 检查样式是否变化
          const styleChanged =
            fg !== lastFg ||
            bg !== lastBg ||
            bold !== lastBold ||
            italic !== lastItalic ||
            underline !== lastUnderline ||
            dim !== lastDim

          if (styleChanged) {
            // 重置并应用新样式
            const codes: number[] = [0] // 先重置

            if (bold) codes.push(1)
            if (dim) codes.push(2)
            if (italic) codes.push(3)
            if (underline) codes.push(4)

            // 前景色
            if (fg !== undefined && fg !== -1) {
              if (cell.isFgRGB()) {
                // 真彩色
                const r = (fg >> 16) & 0xff
                const g = (fg >> 8) & 0xff
                const b = fg & 0xff
                codes.push(38, 2, r, g, b)
              } else if (cell.isFgPalette()) {
                if (fg < 8) {
                  codes.push(30 + fg)
                } else if (fg < 16) {
                  codes.push(90 + (fg - 8))
                } else {
                  codes.push(38, 5, fg)
                }
              }
            }

            // 背景色
            if (bg !== undefined && bg !== -1) {
              if (cell.isBgRGB()) {
                const r = (bg >> 16) & 0xff
                const g = (bg >> 8) & 0xff
                const b = bg & 0xff
                codes.push(48, 2, r, g, b)
              } else if (cell.isBgPalette()) {
                if (bg < 8) {
                  codes.push(40 + bg)
                } else if (bg < 16) {
                  codes.push(100 + (bg - 8))
                } else {
                  codes.push(48, 5, bg)
                }
              }
            }

            lineStr += `\x1b[${codes.join(";")}m`

            lastFg = fg
            lastBg = bg
            lastBold = bold
            lastItalic = italic
            lastUnderline = underline
            lastDim = dim
          }

          lineStr += char
        }

        // 重置样式并去除尾部空格
        if (lastFg !== undefined || lastBg !== undefined || lastBold || lastItalic || lastUnderline || lastDim) {
          lineStr += "\x1b[0m"
        }
        lines.push(lineStr.trimEnd())
      }

      return lines.join("\n")
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
