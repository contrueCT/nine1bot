import { ref, computed } from 'vue'
import type { SSEEvent } from '../api/client'

export interface AgentTerminalInfo {
  id: string
  name: string
  sessionID: string
  status: 'running' | 'exited'
  rows: number
  cols: number
  createdAt: number
  lastActivity: number
}

export interface TerminalScreen {
  id: string
  screen: string
  cursor: { row: number; col: number }
}

const terminals = ref<Map<string, AgentTerminalInfo>>(new Map())
const terminalScreens = ref<Map<string, TerminalScreen>>(new Map())
const activeTerminalId = ref<string | null>(null)
const isPanelOpen = ref(false)

export function useAgentTerminal() {
  const terminalList = computed(() => Array.from(terminals.value.values()))

  const activeTerminal = computed(() => {
    if (!activeTerminalId.value) return null
    return terminals.value.get(activeTerminalId.value) || null
  })

  const activeScreen = computed(() => {
    if (!activeTerminalId.value) return null
    return terminalScreens.value.get(activeTerminalId.value) || null
  })

  const hasTerminals = computed(() => terminals.value.size > 0)

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'agent-terminal.created': {
        const info = properties.info as AgentTerminalInfo
        terminals.value.set(info.id, info)
        // 自动选中新创建的终端并打开面板
        activeTerminalId.value = info.id
        isPanelOpen.value = true
        break
      }

      case 'agent-terminal.updated': {
        const info = properties.info as AgentTerminalInfo
        terminals.value.set(info.id, info)
        break
      }

      case 'agent-terminal.screen': {
        const screen = properties as TerminalScreen
        terminalScreens.value.set(screen.id, screen)
        break
      }

      case 'agent-terminal.exited': {
        const { id } = properties as { id: string; exitCode: number }
        const terminal = terminals.value.get(id)
        if (terminal) {
          terminal.status = 'exited'
          terminals.value.set(id, { ...terminal })
        }
        break
      }

      case 'agent-terminal.closed': {
        const { id } = properties as { id: string }
        terminals.value.delete(id)
        terminalScreens.value.delete(id)
        // 如果关闭的是当前活跃终端，切换到其他终端
        if (activeTerminalId.value === id) {
          const remaining = Array.from(terminals.value.keys())
          activeTerminalId.value = remaining[0] || null
        }
        // 如果没有终端了，关闭面板
        if (terminals.value.size === 0) {
          isPanelOpen.value = false
        }
        break
      }
    }
  }

  function selectTerminal(id: string) {
    if (terminals.value.has(id)) {
      activeTerminalId.value = id
    }
  }

  function togglePanel() {
    isPanelOpen.value = !isPanelOpen.value
  }

  function openPanel() {
    isPanelOpen.value = true
  }

  function closePanel() {
    isPanelOpen.value = false
  }

  function clearTerminals() {
    terminals.value.clear()
    terminalScreens.value.clear()
    activeTerminalId.value = null
  }

  return {
    // State
    terminals: terminalList,
    activeTerminalId,
    activeTerminal,
    activeScreen,
    isPanelOpen,
    hasTerminals,

    // Actions
    handleSSEEvent,
    selectTerminal,
    togglePanel,
    openPanel,
    closePanel,
    clearTerminals,
  }
}
