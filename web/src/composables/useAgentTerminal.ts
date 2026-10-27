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
  sessionID: string
  screen: string
  screenAnsi: string
  cursor: { row: number; col: number }
  outputData?: string
  /** Character offset of the retained output within the current reset epoch. */
  outputOffset?: number
  /** Start of the coherent screen patch, if this epoch includes one. */
  outputSnapshotOffset?: number
  outputSeq?: number
  outputResetToken?: number
  latestSeq?: number
}

// Keep one visible screen. Other terminals and sessions are recovered on demand
// from the server ring buffer. UTF-16 payloads stay within a 6 MiB budget.
export const TERMINAL_SCREEN_LIMITS = {
  screen: 256 * 1024,
  screenAnsi: 512 * 1024,
  outputData: 2 * 1024 * 1024,
} as const
const terminals = ref<Map<string, AgentTerminalInfo>>(new Map())
const terminalScreen = ref<TerminalScreen | null>(null)
const selectedTerminalID = ref<string | null>(null)
const currentSessionID = ref<string | null>(null)
const isPanelOpen = ref(false)
let initialized = false
let contextGeneration = 0
let screenGeneration = 0
let initializeRequest = 0
let resetTokenCounter = 0
const closedTerminals = new Set<string>()
type Recovery = {
  id: string; generation: number; queued: boolean; full?: boolean
  live: Array<{ seq: number; data: string }>; liveSize: number; overflow: boolean
}
let recovering: Recovery | undefined

function emptyScreen(id: string, sessionID: string): TerminalScreen {
  return { id, sessionID, screen: '', screenAnsi: '', cursor: { row: 0, col: 0 }, outputSeq: 0, latestSeq: 0 }
}

function isVisibleSession(sessionID?: string) {
  return Boolean(sessionID && sessionID === currentSessionID.value)
}

function currentActiveTerminalId() {
  const id = selectedTerminalID.value
  if (id && terminals.value.has(id)) return id
  return terminals.value.keys().next().value || null
}

function isCurrentScreen(id: string, sessionID: string, generation: number) {
  return generation === screenGeneration && isVisibleSession(sessionID)
    && currentActiveTerminalId() === id && terminals.value.has(id) && !closedTerminals.has(id)
}

function boundedTail(value: string, limit: number) {
  if (value.length <= limit) return value
  // JSON round-trip detaches the tail from a potentially huge backing string.
  return JSON.parse(JSON.stringify(value.slice(-limit))) as string
}

function storeScreen(screen: TerminalScreen) {
  // Trim in large steps so a terminal at capacity does not copy 2 MiB on every
  // tiny output event. Offsets let a mounted viewer append without losing history.
  const outputData = screen.outputData === undefined ? undefined : boundedTail(screen.outputData,
    screen.outputData.length > TERMINAL_SCREEN_LIMITS.outputData ? TERMINAL_SCREEN_LIMITS.outputData / 2 : TERMINAL_SCREEN_LIMITS.outputData)
  terminalScreen.value = {
    id: screen.id,
    sessionID: screen.sessionID,
    screen: boundedTail(screen.screen, TERMINAL_SCREEN_LIMITS.screen),
    screenAnsi: boundedTail(screen.screenAnsi, TERMINAL_SCREEN_LIMITS.screenAnsi),
    cursor: screen.cursor,
    outputData,
    outputOffset: (screen.outputOffset ?? 0) + (screen.outputData?.length ?? 0) - (outputData?.length ?? 0),
    outputSnapshotOffset: screen.outputSnapshotOffset,
    outputSeq: screen.outputSeq,
    outputResetToken: screen.outputResetToken,
    latestSeq: screen.latestSeq,
  }
}

function invalidateScreen() {
  screenGeneration++
  terminalScreen.value = null
  recovering = undefined
}

async function refreshScreen(id: string, sessionID: string, generation = screenGeneration): Promise<TerminalScreen | undefined> {
  try {
    const data = await agentTerminalApi.getScreen(id, sessionID)
    if (!isCurrentScreen(id, sessionID, generation)) return
    const existing = terminalScreen.value
    const screen = { ...emptyScreen(id, sessionID), ...data, id, sessionID }
    storeScreen({
      ...screen,
      outputData: existing?.outputData,
      outputOffset: existing?.outputOffset,
      outputSnapshotOffset: existing?.outputSnapshotOffset,
      outputSeq: existing?.outputSeq,
      outputResetToken: existing?.outputResetToken,
      latestSeq: existing?.latestSeq,
    })
    return screen
  } catch (error) {
    if (isCurrentScreen(id, sessionID, generation)) {
      console.warn(`[AgentTerminal] Failed to refresh screen for terminal ${id}:`, error)
    }
  }
}

async function recoverTerminalOutput(id: string, afterSeq?: number) {
  const sessionID = terminals.value.get(id)?.sessionID
  const generation = screenGeneration
  if (!sessionID || !isCurrentScreen(id, sessionID, generation)) return
  if (recovering?.id === id && recovering.generation === generation) {
    recovering.queued = true
    if (afterSeq === undefined) recovering.full = true
    return
  }
  const operation: Recovery = { id, generation, queued: false, live: [], liveSize: 0, overflow: false }
  recovering = operation
  try {
    const snapshot = await agentTerminalApi.getBuffer(id, sessionID, afterSeq)
    if (!isCurrentScreen(id, sessionID, generation)) return
    const existing = terminalScreen.value || emptyScreen(id, sessionID)
    if (snapshot.reset) {
      // A response may describe an older instant than SSE output already applied
      // while it was in flight. Merge the contiguous live tail before publishing
      // the reset; never wait for another request between reading and committing.
      let latestSeq = snapshot.latestSeq
      let tail = ''
      for (const chunk of operation.live) {
        if (chunk.seq <= latestSeq) continue
        if (chunk.seq !== latestSeq + 1) break
        tail += chunk.data
        latestSeq = chunk.seq
      }
      if (latestSeq < (existing.latestSeq ?? 0)) {
        operation.queued = operation.full = true
        return // An overflowed/incomplete tail needs a fresh full snapshot.
      }
      storeScreen({
        ...existing,
        // The raw ring can start mid-escape or omit a still-visible prompt.
        // Restore the screen at the snapshot's sequence, then replay live tail.
        outputData: snapshot.buffer + (snapshot.screen
          ? '\x18\x1b[0m\x1b[H\x1b[2J' + snapshot.screen.screenAnsi.replace(/\n/g, '\r\n')
            + `\x1b[${snapshot.screen.cursor.row + 1};${snapshot.screen.cursor.col + 1}H`
          : '') + tail,
        outputOffset: 0,
        outputSnapshotOffset: snapshot.screen ? snapshot.buffer.length : undefined,
        outputSeq: latestSeq,
        outputResetToken: ++resetTokenCounter,
        latestSeq,
      })
      return
    }
    const latestSeq = existing.latestSeq ?? existing.outputSeq ?? afterSeq ?? 0
    const chunks = snapshot.chunks.filter((chunk) => chunk.seq > latestSeq)
    if (chunks.length) {
      const outputSeq = chunks[chunks.length - 1]!.seq
      storeScreen({ ...existing, outputData: (existing.outputData ?? '') + chunks.map((chunk) => chunk.data).join(''), outputSeq,
        latestSeq: Math.max(outputSeq, snapshot.latestSeq) })
    } else {
      storeScreen({ ...existing, latestSeq: Math.max(latestSeq, snapshot.latestSeq) })
    }
  } catch (error) {
    if (isCurrentScreen(id, sessionID, generation)) console.warn(`[AgentTerminal] Failed to recover terminal ${id}:`, error)
  } finally {
    // A prior session's completion must not clear or restart the new recovery.
    if (recovering === operation) {
      recovering = undefined
      if (operation.queued && isCurrentScreen(id, sessionID, generation)) {
        void recoverTerminalOutput(id, operation.full ? undefined : terminalScreen.value?.latestSeq ?? afterSeq)
      }
    }
  }
}

function selectTerminal(id: string) {
  const terminal = terminals.value.get(id)
  if (!terminal || !isVisibleSession(terminal.sessionID)) return
  if (selectedTerminalID.value === id && terminalScreen.value?.id === id) return
  selectedTerminalID.value = id
  invalidateScreen()
  const generation = screenGeneration
  void refreshScreen(id, terminal.sessionID, generation)
  void recoverTerminalOutput(id, 0)
}

function removeTerminal(id: string) {
  initializeRequest++
  closedTerminals.add(id)
  // Tombstones only protect recently closed IDs from delayed events.
  if (closedTerminals.size > 128) closedTerminals.delete(closedTerminals.values().next().value!)
  terminals.value.delete(id)
  if (selectedTerminalID.value === id) {
    selectedTerminalID.value = null
    invalidateScreen()
    const next = currentActiveTerminalId()
    if (next) selectTerminal(next)
  }
  if (!terminals.value.size) isPanelOpen.value = false
}

function clearTerminals() {
  contextGeneration++
  initializeRequest++
  invalidateScreen()
  terminals.value.clear()
  selectedTerminalID.value = null
  currentSessionID.value = null
  closedTerminals.clear()
  initialized = false
  isPanelOpen.value = false
}

async function initialize(force = false) {
  const sessionID = currentSessionID.value
  if (!sessionID || (initialized && !force)) return
  const generation = contextGeneration
  const request = ++initializeRequest
  try {
    const list = await agentTerminalApi.list(sessionID)
    if (generation !== contextGeneration || request !== initializeRequest || !isVisibleSession(sessionID)) return
    const visible = list.filter((info) => info.sessionID === sessionID && !closedTerminals.has(info.id))
    terminals.value = new Map(visible.map((info) => [info.id, info]))
    const id = currentActiveTerminalId()
    if (id) {
      const existing = terminalScreen.value?.id === id ? terminalScreen.value : null
      if (selectedTerminalID.value !== id || !existing) selectTerminal(id)
      else {
        await refreshScreen(id, sessionID)
        if (generation !== contextGeneration || request !== initializeRequest) return
        await recoverTerminalOutput(id, existing.latestSeq ?? 0)
      }
    } else {
      selectedTerminalID.value = null
      invalidateScreen()
    }
    if (generation !== contextGeneration || request !== initializeRequest) return
    if (visible.length) isPanelOpen.value = true
    initialized = true
  } catch (error) {
    if (generation === contextGeneration) console.error('[AgentTerminal] Failed to initialize:', error)
  }
}

export function useAgentTerminal() {
  const terminalList = computed(() => Array.from(terminals.value.values()))
  const activeTerminalId = computed(currentActiveTerminalId)
  const activeTerminal = computed(() => activeTerminalId.value ? terminals.value.get(activeTerminalId.value) || null : null)
  const activeScreen = computed(() => terminalScreen.value?.id === activeTerminalId.value ? terminalScreen.value : null)
  const hasTerminals = computed(() => terminalList.value.length > 0)

  function setSessionContext(sessionID?: string | null) {
    const next = sessionID || null
    if (currentSessionID.value === next) return
    clearTerminals()
    currentSessionID.value = next
    if (next) void initialize(true)
  }

  function handleSSEEvent(event: SSEEvent) {
    const { type, properties } = event
    if (type === 'server.connected') {
      void initialize(true)
      return
    }
    const info = properties.info as AgentTerminalInfo | undefined
    const sessionID = info?.sessionID || properties.sessionID as string | undefined
    if (!isVisibleSession(sessionID)) return
    const id = info?.id || properties.id as string
    if (type === 'agent-terminal.closed') {
      removeTerminal(id)
      return
    }
    if (closedTerminals.has(id)) return
    switch (type) {
      case 'agent-terminal.created':
        if (!info) break
        terminals.value.set(info.id, info)
        selectTerminal(info.id)
        isPanelOpen.value = true
        break
      case 'agent-terminal.updated':
        if (info) terminals.value.set(info.id, info)
        break
      case 'agent-terminal.screen': {
        if (id !== activeTerminalId.value) break
        const existing = terminalScreen.value
        storeScreen({ ...(properties as TerminalScreen), outputData: existing?.outputData, outputOffset: existing?.outputOffset,
          outputSnapshotOffset: existing?.outputSnapshotOffset,
          outputSeq: existing?.outputSeq, outputResetToken: existing?.outputResetToken, latestSeq: existing?.latestSeq })
        break
      }
      case 'agent-terminal.output': {
        if (id !== activeTerminalId.value) break
        const { seq, data } = properties as { seq: number; data: string }
        const existing = terminalScreen.value || emptyScreen(id, sessionID!)
        const lastSeq = existing.latestSeq ?? existing.outputSeq ?? 0
        if (seq <= lastSeq) break
        if (seq > lastSeq + 1) void recoverTerminalOutput(id, lastSeq)
        else {
          if (recovering?.id === id && recovering.generation === screenGeneration && !recovering.overflow) {
            recovering.liveSize += data.length
            if (recovering.liveSize > TERMINAL_SCREEN_LIMITS.outputData || recovering.live.length >= 1024) {
              recovering.live = []
              recovering.overflow = true
            } else recovering.live.push({ seq, data })
          }
          storeScreen({ ...existing, outputData: (existing.outputData ?? '') + data, outputSeq: seq, latestSeq: seq })
        }
        break
      }
      case 'agent-terminal.exited': {
        const terminal = terminals.value.get(id)
        if (terminal) terminals.value.set(id, { ...terminal, status: 'exited' })
        if (id === activeTerminalId.value) void refreshScreen(id, sessionID!)
        break
      }
    }
  }

  async function writeToTerminal(id: string, data: string): Promise<boolean> {
    try {
      const sessionID = terminals.value.get(id)?.sessionID
      return sessionID ? await agentTerminalApi.write(id, data, sessionID) : false
    } catch (error) {
      console.error('Failed to write to terminal:', error)
      return false
    }
  }

  async function closeTerminal(id: string): Promise<boolean> {
    const generation = contextGeneration
    try {
      const sessionID = terminals.value.get(id)?.sessionID
      if (!sessionID) return false
      const closed = await agentTerminalApi.close(id, sessionID)
      if (closed && generation === contextGeneration) removeTerminal(id)
      return closed
    } catch (error) {
      console.error('Failed to close terminal:', error)
      return false
    }
  }

  return {
    terminals: terminalList, activeTerminalId, activeTerminal, activeScreen, isPanelOpen, hasTerminals, currentSessionID,
    setSessionContext, initialize, handleSSEEvent, recoverTerminalOutput, selectTerminal,
    togglePanel: () => { isPanelOpen.value = !isPanelOpen.value },
    openPanel: () => { if (hasTerminals.value) isPanelOpen.value = true },
    closePanel: () => { isPanelOpen.value = false },
    writeToTerminal, closeTerminal, clearTerminals,
  }
}
