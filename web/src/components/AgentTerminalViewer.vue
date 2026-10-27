<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { agentTerminalApi } from '../api/client'
import { useAgentTerminal } from '../composables/useAgentTerminal'

const props = defineProps<{
  terminalId: string  // 终端 ID，用于调用 API
  sessionId: string
  screen: string
  screenAnsi: string
  cursor?: { row: number; col: number }
  rows?: number
  cols?: number
  status?: 'running' | 'exited'  // 终端状态
  /** 原始输出增量数据 - 用于保持滚动历史 */
  outputData?: string
  outputOffset?: number
  outputNeedsRecovery?: boolean
  outputResetToken?: number
}>()

const emit = defineEmits<{
  (e: 'resize', rows: number, cols: number): void
  (e: 'input', data: string): void
}>()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let resizeTimeout: ReturnType<typeof setTimeout> | null = null
let themeObserver: MutationObserver | null = null

// 从设计 token 读取终端配色（亮/暗主题各一套，定义在 style.css）
function readTerminalTheme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string) => css.getPropertyValue(name).trim()
  return {
    background: v('--terminal-bg'),
    foreground: v('--terminal-fg'),
    cursor: v('--terminal-cursor'),
    cursorAccent: v('--terminal-bg'),
    selectionBackground: v('--terminal-selection'),
    black: v('--terminal-black'),
    red: v('--terminal-red'),
    green: v('--terminal-green'),
    yellow: v('--terminal-yellow'),
    blue: v('--terminal-blue'),
    magenta: v('--terminal-magenta'),
    cyan: v('--terminal-cyan'),
    white: v('--terminal-white'),
    brightBlack: v('--terminal-bright-black'),
    brightRed: v('--terminal-bright-red'),
    brightGreen: v('--terminal-bright-green'),
    brightYellow: v('--terminal-bright-yellow'),
    brightBlue: v('--terminal-bright-blue'),
    brightMagenta: v('--terminal-bright-magenta'),
    brightCyan: v('--terminal-bright-cyan'),
    brightWhite: v('--terminal-bright-white'),
  }
}

// 当前后端终端的尺寸
let currentBackendRows = props.rows || 24
let currentBackendCols = props.cols || 120
let outputEnd = 0
let outputEpoch: number | undefined
let hasOutput = false

onMounted(() => {
  if (!terminalRef.value) return

  // 根据终端状态决定是否允许输入
  const isRunning = props.status === 'running'

  terminal = new Terminal({
    rows: props.rows || 24,
    cols: props.cols || 120,
    cursorBlink: isRunning,  // 运行中时光标闪烁
    disableStdin: false,  // 允许输入
    scrollback: 5000,  // 增加滚动历史行数
    theme: readTerminalTheme(),
    fontFamily: '"SF Mono", Menlo, Monaco, "Cascadia Code", "Roboto Mono", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1,
    letterSpacing: 0,
    fontWeight: '400',
    fontWeightBold: '600',
    drawBoldTextInBrightColors: true,
    minimumContrastRatio: 1,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)

  // 主题切换时同步终端配色
  themeObserver = new MutationObserver(() => {
    if (terminal) {
      terminal.options.theme = readTerminalTheme()
    }
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

  // 监听用户输入
  terminal.onData((data) => {
    if (props.status !== 'running') {
      // 终端已退出，不发送输入
      return
    }
    // 发送输入到后端
    sendInput(data)
    emit('input', data)
  })

  // The composable owns recovery. Its bounded output window also survives Vue
  // batching and viewer remounts, so initialization needs no second buffer fetch.
  syncOutput()

  // 适应容器大小并设置 ResizeObserver
  nextTick(() => {
    fitAndSync()
    setupResizeObserver()
  })
})

onUnmounted(() => {
  if (resizeTimeout) {
    clearTimeout(resizeTimeout)
  }
  if (resizeObserver) {
    resizeObserver.disconnect()
  }
  if (themeObserver) {
    themeObserver.disconnect()
  }
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

// 发送用户输入到后端
async function sendInput(data: string) {
  try {
    await agentTerminalApi.write(props.terminalId, data, props.sessionId)
  } catch (error) {
    console.error('Failed to send input to terminal:', error)
  }
}

// 设置容器尺寸监听
function setupResizeObserver() {
  if (!terminalRef.value) return

  resizeObserver = new ResizeObserver(() => {
    // 使用节流，避免频繁调用
    if (resizeTimeout) {
      clearTimeout(resizeTimeout)
    }
    resizeTimeout = setTimeout(() => {
      fitAndSync()
    }, 150)
  })

  resizeObserver.observe(terminalRef.value)
}

// 适配容器并同步到后端
async function fitAndSync() {
  if (!fitAddon || !terminal) return

  // 先执行 fit 来计算新尺寸
  fitAddon.fit()

  const newRows = terminal.rows
  const newCols = terminal.cols

  // 如果尺寸有变化，通知后端调整
  if (newRows !== currentBackendRows || newCols !== currentBackendCols) {
    try {
      await agentTerminalApi.resize(props.terminalId, newRows, newCols, props.sessionId)
      currentBackendRows = newRows
      currentBackendCols = newCols
      emit('resize', newRows, newCols)
    } catch (error) {
      console.error('Failed to resize terminal:', error)
    }
  }
}

// 监听原始输出增量数据
watch([() => props.outputOffset, () => props.outputResetToken, () => props.outputData], syncOutput)

// 屏幕快照只用于原始输出尚不可用时的回退。
watch(() => props.screenAnsi, (newScreen) => {
  if (props.outputData !== undefined) return
  updateScreen(newScreen)
})

// 监听后端尺寸变化
watch([() => props.rows, () => props.cols], ([newRows, newCols]) => {
  if (newRows && newCols) {
    currentBackendRows = newRows
    currentBackendCols = newCols
    // 当后端尺寸变化时，重新适配
    if (terminal && fitAddon) {
      terminal.resize(newCols, newRows)
    }
  }
})

// 监听状态变化
watch(() => props.status, (newStatus) => {
  if (terminal) {
    terminal.options.cursorBlink = newStatus === 'running'
  }
})

function updateScreen(screen: string) {
  if (!terminal) return

  // 清屏并写入新内容
  terminal.clear()
  terminal.reset()

  if (screen) {
    // 按行写入，处理换行
    const lines = screen.split('\n')
    for (let i = 0; i < lines.length; i++) {
      terminal.write(lines[i])
      if (i < lines.length - 1) {
        terminal.write('\r\n')
      }
    }
  }

  // 设置光标位置
  if (props.cursor) {
    terminal.write(`\x1b[${props.cursor.row + 1};${props.cursor.col + 1}H`)
  }
}

function syncOutput() {
  if (!terminal) return
  const data = props.outputData
  if (data === undefined) {
    updateScreen(props.screenAnsi)
    return
  }
  const start = props.outputOffset ?? 0
  const end = start + data.length
  if (!hasOutput || outputEpoch !== props.outputResetToken || outputEnd < start) {
    terminal.clear()
    terminal.reset()
    terminal.write(data)
    // Cropping can lose persistent screen state (e.g. a prompt above progress
    // updates), both on remount and when a batch outruns the retained window.
    if (props.outputNeedsRecovery) void useAgentTerminal().recoverTerminalOutput(props.terminalId)
  } else if (end > outputEnd) terminal.write(data.slice(outputEnd - start))
  hasOutput = true
  outputEpoch = props.outputResetToken
  outputEnd = end
}

// 聚焦终端
function focus() {
  terminal?.focus()
}

// 暴露方法供父组件调用
defineExpose({
  fit: () => fitAndSync(),
  focus
})
</script>

<template>
  <div class="terminal-viewer" :class="{ 'terminal-exited': status === 'exited' }">
    <div ref="terminalRef" class="terminal-container"></div>
    <div v-if="status === 'exited'" class="terminal-overlay">
      <span class="exited-badge">已退出</span>
    </div>
  </div>
</template>

<style scoped>
.terminal-viewer {
  position: relative;
  width: 100%;
  height: 100%;
  background: var(--terminal-bg);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.terminal-viewer.terminal-exited {
  opacity: 0.8;
}

.terminal-container {
  width: 100%;
  height: 100%;
  padding: 8px;
}

.terminal-overlay {
  position: absolute;
  top: 8px;
  right: 8px;
  pointer-events: none;
}

.exited-badge {
  display: inline-block;
  padding: 2px 8px;
  background: var(--error);
  color: var(--solid-fg);
  font-size: var(--text-xs);
  border-radius: 4px;
}

/* xterm.js 样式覆盖 */
:deep(.xterm) {
  height: 100%;
}

:deep(.xterm-viewport) {
  overflow-y: auto !important;
}

:deep(.xterm-screen) {
  height: 100% !important;
}

:deep(.xterm-rows) {
  letter-spacing: 0 !important;
}
</style>
