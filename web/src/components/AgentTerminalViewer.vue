<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  screen: string
  cursor?: { row: number; col: number }
  rows?: number
  cols?: number
}>()

const terminalRef = ref<HTMLDivElement | null>(null)
let terminal: Terminal | null = null
let fitAddon: FitAddon | null = null

onMounted(() => {
  if (!terminalRef.value) return

  terminal = new Terminal({
    rows: props.rows || 24,
    cols: props.cols || 120,
    cursorBlink: false,
    disableStdin: true, // 只读模式
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
    fontFamily: 'Consolas, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
  })

  fitAddon = new FitAddon()
  terminal.loadAddon(fitAddon)
  terminal.open(terminalRef.value)

  // 初始显示
  updateScreen(props.screen)

  // 适应容器大小
  nextTick(() => {
    fitAddon?.fit()
  })
})

onUnmounted(() => {
  terminal?.dispose()
  terminal = null
  fitAddon = null
})

// 监听屏幕内容变化
watch(() => props.screen, (newScreen) => {
  updateScreen(newScreen)
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

// 暴露 fit 方法供父组件调用
defineExpose({
  fit: () => fitAddon?.fit()
})
</script>

<template>
  <div class="terminal-viewer">
    <div ref="terminalRef" class="terminal-container"></div>
  </div>
</template>

<style scoped>
.terminal-viewer {
  width: 100%;
  height: 100%;
  background: #1a1b26;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.terminal-container {
  width: 100%;
  height: 100%;
  padding: 8px;
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
</style>
