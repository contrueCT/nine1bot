<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import type { ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { agentTerminalApi } from '../api/client'

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
  outputSeq?: number
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
// 标记是否已初始化（已加载历史缓冲）
let isInitialized = false
let lastAppliedSeq = 0
const pendingOutput: Array<{ seq?: number; data: string; resetToken?: number }> = []

onMounted(async () => {
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

  // 从后端加载完整的历史缓冲区
  try {
    const { buffer, latestSeq } = await agentTerminalApi.getBuffer(props.terminalId, props.sessionId)
    if (buffer && terminal) {
      terminal.write(buffer)
    }
    lastAppliedSeq = latestSeq
    isInitialized = true
    flushPendingOutput()
  } catch (e) {
    console.warn('Failed to load terminal buffer, falling back to screen:', e)
    // 回退到屏幕内容
    updateScreen(props.screenAnsi)
    isInitialized = true
    flushPendingOutput()
  }

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
watch([() => props.outputSeq, () => props.outputResetToken, () => props.outputData], ([seq, resetToken, data]) => {
  if (data === undefined && !resetToken && seq === undefined) return
  const item = { seq, data: data || '', resetToken }
  if (!terminal || !isInitialized) {
    pendingOutput.push(item)
    return
  }
  applyOutput(item)
})

// 监听屏幕内容变化（仅在没有 outputData 时作为回退）
// 注意：如果使用了 outputData 模式，screenAnsi 的变化会被忽略
watch(() => props.screenAnsi, (newScreen) => {
  // 如果已初始化并且有 outputData 支持，不再使用 screen 更新
  // 因为 outputData 会直接追加原始数据
  if (isInitialized && props.outputData !== undefined) return
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

function applyScreenSnapshot(screen: string) {
  if (!terminal || !screen) return

  terminal.write('\x1b[H\x1b[2J')
  const lines = screen.split('\n')
  for (let i = 0; i < lines.length; i++) {
    terminal.write(lines[i])
    if (i < lines.length - 1) {
      terminal.write('\r\n')
    }
  }

  if (props.cursor) {
    terminal.write(`\x1b[${props.cursor.row + 1};${props.cursor.col + 1}H`)
  }
}

function flushPendingOutput() {
  while (pendingOutput.length > 0) {
    applyOutput(pendingOutput.shift()!)
  }
}

function applyOutput(item: { seq?: number; data: string; resetToken?: number }) {
  if (!terminal) return

  if (item.resetToken) {
    terminal.clear()
    terminal.reset()
    if (item.data) terminal.write(item.data)
    applyScreenSnapshot(props.screenAnsi)
    lastAppliedSeq = item.seq ?? lastAppliedSeq
    return
  }

  if (item.seq !== undefined) {
    if (item.seq <= lastAppliedSeq) return
    lastAppliedSeq = item.seq
  }
  if (item.data) terminal.write(item.data)
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
