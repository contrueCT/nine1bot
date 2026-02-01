import { ref, computed } from 'vue'
import type { SSEEvent } from '../api/client'
import { agentTerminalApi } from '../api/client'

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
  screenAnsi: string
  cursor: { row: number; col: number }
}

const terminals = ref<Map<string, AgentTerminalInfo>>(new Map())
const terminalScreens = ref<Map<string, TerminalScreen>>(new Map())
const activeTerminalId = ref<string | null>(null)
const isPanelOpen = ref(false)
const isInitialized = ref(false)

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

  /**
   * 初始化：从后端加载现有终端列表
   * 应该在 SSE 连接建立后调用
   * @param force 强制重新初始化，忽略 isInitialized 标志
   */
  async function initialize(force = false) {
    if (isInitialized.value && !force) {
      console.log('[AgentTerminal] Already initialized, skipping')
      return
    }

    console.log('[AgentTerminal] Initializing...')

    try {
      const list = await agentTerminalApi.list()
      console.log('[AgentTerminal] Fetched terminals:', list.length)

      for (const info of list) {
        terminals.value.set(info.id, info)
        // 获取每个终端的屏幕内容
        try {
          const screenData = await agentTerminalApi.getScreen(info.id)
          terminalScreens.value.set(info.id, {
            id: info.id,
            ...screenData
          })
          console.log(`[AgentTerminal] Loaded screen for terminal ${info.id}`)
        } catch (e) {
          console.warn(`[AgentTerminal] Failed to get screen for terminal ${info.id}:`, e)
        }
      }

      // 如果有终端，选中第一个并打开面板
      if (list.length > 0) {
        activeTerminalId.value = list[0].id
        isPanelOpen.value = true
        console.log('[AgentTerminal] Auto-selected terminal:', list[0].id)
      }

      isInitialized.value = true
      console.log('[AgentTerminal] Initialization complete')
    } catch (e) {
      console.error('[AgentTerminal] Failed to initialize:', e)
    }
  }

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event

    switch (type) {
      case 'server.connected': {
        // SSE 连接建立后，初始化终端列表
        console.log('[AgentTerminal] Received server.connected, triggering initialize')
        initialize()
        break
      }

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
        // 不自动清理，让用户决定是否关闭
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

  /**
   * 向终端发送输入
   */
  async function writeToTerminal(id: string, data: string): Promise<boolean> {
    try {
      return await agentTerminalApi.write(id, data)
    } catch (e) {
      console.error('Failed to write to terminal:', e)
      return false
    }
  }

  /**
   * 关闭指定终端
   */
  async function closeTerminal(id: string): Promise<boolean> {
    try {
      return await agentTerminalApi.close(id)
    } catch (e) {
      console.error('Failed to close terminal:', e)
      return false
    }
  }

  function clearTerminals() {
    terminals.value.clear()
    terminalScreens.value.clear()
    activeTerminalId.value = null
    isInitialized.value = false
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
    initialize,
    handleSSEEvent,
    selectTerminal,
    togglePanel,
    openPanel,
    closePanel,
    writeToTerminal,
    closeTerminal,
    clearTerminals,
  }
}
