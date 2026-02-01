<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { agentTerminalApi } from '../api/client'

const props = defineProps<{
  terminalId: string  // 终端 ID，用于调用 API
  screen: string
  screenAnsi: string
  cursor?: { row: number; col: number }
  rows?: number
  cols?: number
  status?: 'running' | 'exited'  // 终端状态
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

// 当前后端终端的尺寸
let currentBackendRows = props.rows || 24
let currentBackendCols = props.cols || 120

onMounted(() => {
  if (!terminalRef.value) return

  // 根据终端状态决定是否允许输入
  const isRunning = props.status === 'running'

  terminal = new Terminal({
    rows: props.rows || 24,
    cols: props.cols || 120,
    cursorBlink: isRunning,  // 运行中时光标闪烁
    disableStdin: false,  // 允许输入
    theme: {
      background: '#1a1b26',
      foreground: '#a9b1d6',
      cursor: '#c0caf5',
      cursorAccent: '#1a1b26',
      selectionBackground: '#33467c',
      black: '#32344a',
      red: '#f7768e',
      green: '#9ece6a',
      yellow: '#e0af68',
      blue: '#7aa2f7',
      magenta: '#ad8ee6',
      cyan: '#449dab',
      white: '#787c99',
      brightBlack: '#444b6a',
      brightRed: '#ff7a93',
      brightGreen: '#b9f27c',
      brightYellow: '#ff9e64',
      brightBlue: '#7da6ff',
      brightMagenta: '#bb9af7',
      brightCyan: '#0db9d7',
      brightWhite: '#acb0d0',
    },
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

  // 初始显示（使用带 ANSI 的内容）
  updateScreen(props.screenAnsi)

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
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

// 发送用户输入到后端
async function sendInput(data: string) {
  try {
    await agentTerminalApi.write(props.terminalId, data)
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
      await agentTerminalApi.resize(props.terminalId, newRows, newCols)
      currentBackendRows = newRows
      currentBackendCols = newCols
      emit('resize', newRows, newCols)
    } catch (error) {
      console.error('Failed to resize terminal:', error)
    }
  }
}

// 监听屏幕内容变化（使用带 ANSI 的内容）
watch(() => props.screenAnsi, (newScreen) => {
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
  background: #1a1b26;
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
  background: rgba(247, 118, 142, 0.8);
  color: white;
  font-size: 11px;
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
