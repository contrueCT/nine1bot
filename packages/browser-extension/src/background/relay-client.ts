/**
 * Relay Client - 连接到 Nine1Bot Bridge Server 的 Extension Relay
 *
 * 负责：
 * 1. 建立与 Bridge Server 的 WebSocket 连接
 * 2. 接收并执行 CDP 命令
 * 3. 将 CDP 事件转发回 Bridge Server
 * 4. 维护命令生命周期（超时、取消、状态心跳）
 */

import { toolExecutors } from '../tools'
import { executePageCdpCommand } from './page-cdp'
import { InputOwnership } from './input-ownership'
import {
  DEFAULT_SERVER_ORIGIN,
  SERVER_ORIGIN_STORAGE_KEY,
  readStoredServerOrigin,
  serverOriginToRelayUrl,
  normalizeServerOrigin,
} from '../shared/server-config'
import type { ToolExecutionContext } from '../tools/execution-context'
import { setupDiagnosticsListeners } from './diagnostics-buffer'
import {
  addTabToNine1Group,
  getDefaultNine1Tab,
  getActiveNine1GroupId,
  getActiveNine1GroupSnapshot,
  getNine1GroupRevision,
  getTabsInActiveNine1Group,
  getTabsInGroupByTab,
  isTabInActiveNine1Group,
  setNine1GroupActive,
  setNine1GroupIdle,
  setupTabGroupCleanup,
} from './tab-group-manager'

const EXTENSION_PROTOCOL_VERSION = '2026-03-15'

const RECONNECT_BASE_INTERVAL = 5000
const RECONNECT_MAX_INTERVAL = 60000
const HEALTH_REPORT_INTERVAL = 60000
const AGENT_HEARTBEAT_INTERVAL = 1500
const DEFAULT_COMMAND_TIMEOUT_MS = 30000
// The bridge stops waiting after 30s; a command must not outlive that budget.
const MAX_COMMAND_TIMEOUT_MS = 30000

function normalizeCommandTimeoutMs(timeoutMs: unknown): number {
  // Invalid input must not disable the deadline. Rounding a finite positive
  // value up guarantees a minimum delay of 1ms.
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS
  }
  const roundedMs = Math.ceil(timeoutMs)
  if (roundedMs > MAX_COMMAND_TIMEOUT_MS) {
    return MAX_COMMAND_TIMEOUT_MS
  }
  return roundedMs
}

let configuredServerOrigin = DEFAULT_SERVER_ORIGIN
let pairedInstanceId: string | null = null

async function fetchBootstrap(serverOrigin: string): Promise<{ serverOrigin?: string; instanceId?: string } | null> {
  try {
    const response = await fetch(`${serverOrigin}/browser/bootstrap`)
    if (!response.ok) return null
    return await response.json() as { serverOrigin?: string; instanceId?: string }
  } catch {
    return null
  }
}

async function getConfiguredRelayUrl(generation: number): Promise<string | null> {
  const storedServerOrigin = await readStoredServerOrigin().catch(() => DEFAULT_SERVER_ORIGIN)
  if (generation !== connectionGeneration) return null
  const bootstrap = await fetchBootstrap(storedServerOrigin)
  if (generation !== connectionGeneration) return null
  configuredServerOrigin = normalizeServerOrigin(bootstrap?.serverOrigin ?? storedServerOrigin)
  pairedInstanceId = typeof bootstrap?.instanceId === 'string' ? bootstrap.instanceId : null

  try {
    await chrome.storage.sync.set({ [SERVER_ORIGIN_STORAGE_KEY]: configuredServerOrigin })
  } catch {
    // ignore storage sync failures
  }

  return serverOriginToRelayUrl(configuredServerOrigin)
}

interface RunningCommand {
  generation: number
  stopVersion: number
  id: number
  tabId?: number
  method: string
  toolName?: string
  sessionId?: string
  startedAt: number
  controller: AbortController
  cancelReason?: string
  taskLabel?: string
  activeCounted?: boolean
  groupRevision?: number
}

// WebSocket 连接状态
let ws: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let healthTimer: ReturnType<typeof setInterval> | null = null
let agentHeartbeatTimer: ReturnType<typeof setInterval> | null = null
let isConnecting = false
let connectionGeneration = 0
let reconnectAttempt = 0
let lastPongAt = 0

// 当前活动的标签页 session
const activeSessions = new Map<number, string>() // tabId -> sessionId
const attachedTabs = new Set<number>()

// 命令状态
const runningCommands = new Map<number, RunningCommand>()
const tabActiveCommandCount = new Map<number, number>()
const tabStopRequestedAt = new Map<number, number>()
const tabStopVersions = new Map<number, number>()
const inputOwnership = new InputOwnership()
let stopRequestVersion = 0
const tabStateVersions = new Map<number, number>()
let tabStateVersion = 0

/**
 * 生成唯一的 session ID
 */
function generateSessionId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `session_${Date.now()}_${hex}`
}

/**
 * 发送消息到 Relay Server
 */
function sendToRelay(message: unknown): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message))
  }
}

/**
 * 发送 CDP 事件到 Relay Server
 */
function forwardCdpEvent(method: string, params?: unknown, sessionId?: string): void {
  sendToRelay({
    method: 'forwardCDPEvent',
    params: { method, params, sessionId },
  })
}

function isAutomatableTabUrl(url?: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return ['http:', 'https:', 'file:'].includes(parsed.protocol)
  } catch {
    return false
  }
}

function targetInfoForTab(tab: chrome.tabs.Tab) {
  return {
    targetId: String(tab.id),
    type: 'page',
    title: tab.title || '',
    url: tab.url || '',
    attached: true,
  }
}

function detachManagedTarget(tabId: number, reason = 'target_detached'): void {
  const sessionId = activeSessions.get(tabId)
  const hasCommand = Array.from(runningCommands.values()).some(command => command.tabId === tabId)
  if (!sessionId && !hasCommand) {
    inputOwnership.forgetTab(tabId)
    return
  }

  if (sessionId) {
    forwardCdpEvent('Target.detachedFromTarget', {
      sessionId,
      targetId: String(tabId),
    })
    activeSessions.delete(tabId)
  }
  attachedTabs.delete(tabId)
  cancelRunningCommands({ tabId, reason })
  tabActiveCommandCount.delete(tabId)
  tabStopRequestedAt.delete(tabId)
  inputOwnership.forgetTab(tabId)
  tabStateVersions.delete(tabId)
}

function detachAllActiveSessions(): void {
  for (const tabId of Array.from(activeSessions.keys())) {
    detachManagedTarget(tabId, 'tab_group_changed')
  }
}

async function attachManagedTarget(tab: chrome.tabs.Tab, generation = connectionGeneration): Promise<string | null> {
  if (!tab.id) return null
  if (!isAutomatableTabUrl(tab.url)) return null
  if (!await isTabInActiveNine1Group(tab.id)) return null
  if (generation !== connectionGeneration || !isRelayConnected()) return null

  const existing = activeSessions.get(tab.id)
  if (existing) return existing

  const sessionId = generateSessionId()
  activeSessions.set(tab.id, sessionId)

  forwardCdpEvent('Target.attachedToTarget', {
    sessionId,
    targetInfo: targetInfoForTab(tab),
    waitingForDebugger: false,
  })

  return sessionId
}

function sendExtensionHello(): void {
  sendToRelay({
    method: 'extension.hello',
    params: {
      version: chrome.runtime.getManifest().version,
      protocolVersion: EXTENSION_PROTOCOL_VERSION,
      serverOrigin: configuredServerOrigin,
      pairedInstanceId,
      tools: Object.keys(toolExecutors),
      capabilities: {
        cancelCDPCommand: true,
        agentState: true,
        diagnostics: true,
      },
    },
  })
}

function sendExtensionHealth(): void {
  sendToRelay({
    method: 'extension.health',
    params: {
      timestamp: Date.now(),
      lastPongAt,
      activeCommands: runningCommands.size,
      reconnectAttempt,
    },
  })
}

async function sendAgentStateToTabs(tabId: number, taskLabel?: string, generation = connectionGeneration, stateVersion = tabStateVersions.get(tabId), groupRevision = getNine1GroupRevision()): Promise<void> {
  const ownsState = () => generation === connectionGeneration && stateVersion === tabStateVersions.get(tabId) &&
    groupRevision === getNine1GroupRevision()
  const activeForTab = (tabActiveCommandCount.get(tabId) ?? 0) > 0
  const stopRequestedAt = tabStopRequestedAt.get(tabId) ?? 0
  const isStopping = !activeForTab && stopRequestedAt > 0 && Date.now() - stopRequestedAt < 5000
  const state: 'active' | 'idle' | 'stopping' = activeForTab ? 'active' : isStopping ? 'stopping' : 'idle'
  let groupTabs: number[] = [tabId]

  try {
    groupTabs = await getTabsInGroupByTab(tabId)
  } catch {
    groupTabs = [tabId]
  }

  if (!ownsState()) return
  const now = Date.now()
  const sendPromises = groupTabs.map(async (targetTabId) => {
    try {
      await chrome.tabs.sendMessage(targetTabId, {
        type: 'nine1bot-agent-state',
        state,
        heartbeatAt: now,
        activeInThisTab: (activeForTab || isStopping) && targetTabId === tabId,
        sameGroupActive: activeForTab && targetTabId !== tabId,
        taskLabel,
      })
    } catch {
      // ignore tabs where content script is unavailable
    }
  })

  await Promise.all(sendPromises)
  if (!ownsState()) return

  sendToRelay({
    method: 'extension.agentState',
    params: {
      tabId,
      state,
      heartbeatAt: now,
      taskLabel,
    },
  })

  if (!isStopping && stopRequestedAt > 0) {
    tabStopRequestedAt.delete(tabId)
  }
}

function bumpTabActiveCount(tabId: number, delta: number): number {
  const next = Math.max(0, (tabActiveCommandCount.get(tabId) ?? 0) + delta)
  if (next === 0) {
    tabActiveCommandCount.delete(tabId)
  } else {
    tabActiveCommandCount.set(tabId, next)
  }
  return next
}

async function markCommandStart(command: RunningCommand): Promise<void> {
  if (command.generation !== connectionGeneration || command.controller.signal.aborted) return
  if (command.tabId === undefined) return
  tabStopRequestedAt.delete(command.tabId)
  command.activeCounted = true
  bumpTabActiveCount(command.tabId, 1)
  const version = ++tabStateVersion
  tabStateVersions.set(command.tabId, version)
  const ownsState = () => command.generation === connectionGeneration &&
    command.groupRevision === getNine1GroupRevision() && !command.controller.signal.aborted &&
    tabStateVersions.get(command.tabId!) === version
  await setNine1GroupActive(command.tabId, command.taskLabel, ownsState)
  if (ownsState()) await sendAgentStateToTabs(command.tabId, command.taskLabel, command.generation, version, command.groupRevision)
}

function markCommandFinish(command: RunningCommand): void {
  if (command.generation !== connectionGeneration || command.tabId === undefined || !command.activeCounted) return
  command.activeCounted = false
  const tabId = command.tabId
  const remaining = bumpTabActiveCount(tabId, -1)
  const version = ++tabStateVersion
  tabStateVersions.set(tabId, version)
  const ownsState = () => command.generation === connectionGeneration &&
    command.groupRevision === getNine1GroupRevision() && tabStateVersions.get(tabId) === version
  // UI reporting must never delay cancellation/timeout responses. Every eventual
  // write is guarded so an obsolete idle update cannot overwrite newer activity.
  void (async () => {
    if (remaining === 0) await setNine1GroupIdle(tabId, ownsState)
    if (ownsState()) await sendAgentStateToTabs(tabId, command.taskLabel, command.generation, version, command.groupRevision)
  })().catch(() => {})
}

function startHealthReporting(): void {
  if (healthTimer) return
  healthTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendExtensionHealth()
    }
  }, HEALTH_REPORT_INTERVAL)
}

function startAgentHeartbeat(): void {
  if (agentHeartbeatTimer) return
  agentHeartbeatTimer = setInterval(() => {
    const activeTabs = Array.from(tabActiveCommandCount.keys())
    for (const tabId of activeTabs) {
      sendAgentStateToTabs(tabId).catch(() => {
        // ignore heartbeat send errors
      })
    }
  }, AGENT_HEARTBEAT_INTERVAL)
}

function stopTimers(): void {
  if (healthTimer) {
    clearInterval(healthTimer)
    healthTimer = null
  }
  if (agentHeartbeatTimer) {
    clearInterval(agentHeartbeatTimer)
    agentHeartbeatTimer = null
  }
}

function cancelRunningCommands(options: {
  commandId?: number
  tabId?: number
  reason: string
}): number {
  const { commandId, tabId, reason } = options
  if (commandId === undefined && tabId !== undefined) tabStopVersions.set(tabId, ++stopRequestVersion)
  let cancelled = 0

  for (const [id, command] of runningCommands) {
    if (commandId !== undefined && id !== commandId) continue
    if (tabId !== undefined && command.tabId !== tabId) continue
    if (command.controller.signal.aborted) continue

    command.cancelReason = reason
    command.controller.abort(reason)
    cancelled += 1
  }

  return cancelled
}

async function executeExtensionToolCommand(options: {
  commandId: number
  tabId?: number
  sessionId?: string
  toolName: string
  args: Record<string, unknown>
  timeoutMs?: number
  taskLabel?: string
}, context: ToolExecutionContext): Promise<unknown> {
  const { tabId, toolName, args } = options

  const ALLOWED_TOOLS: ReadonlySet<string> = new Set(Object.keys(toolExecutors))
  if (!ALLOWED_TOOLS.has(toolName)) {
    throw new Error(`Unknown extension tool: ${toolName}. Available: ${[...ALLOWED_TOOLS].join(', ')}`)
  }

  const executor = toolExecutors[toolName as keyof typeof toolExecutors]
  const toolArgs: Record<string, unknown> = { ...(args || {}) }
  if (tabId !== undefined) {
    toolArgs.tabId = tabId
  }

  const result = await executor(toolArgs, context)
  if (result.isError && result.content[0]?.text === 'Cancelled') throw new Error('Command cancelled (tool cooperative stop)')
  return result
}

async function executeTrackedCommand<T>(options: {
  commandId: number
  tabId?: number
  sessionId?: string
  method: string
  toolName?: string
  timeoutMs?: number
  taskLabel?: string
  requirePage: boolean
}, executor: (context: ToolExecutionContext, command: RunningCommand) => Promise<T>): Promise<T> {
  const { commandId, tabId, sessionId, method, toolName, timeoutMs, taskLabel, requirePage } = options
  if (runningCommands.has(commandId)) throw new Error(`Browser command is already running: ${commandId}`)
  const controller = new AbortController()
  const command: RunningCommand = {
    generation: connectionGeneration,
    stopVersion: stopRequestVersion,
    id: commandId,
    method,
    toolName,
    tabId,
    sessionId,
    startedAt: Date.now(),
    controller,
    taskLabel,
  }

  runningCommands.set(commandId, command)

  const assertOwned = () => {
    controller.signal.throwIfAborted()
    if (command.groupRevision !== undefined && command.groupRevision !== getNine1GroupRevision()) {
      command.cancelReason = 'active_group_changed'
      controller.abort(command.cancelReason)
      controller.signal.throwIfAborted()
    }
    if (command.generation !== connectionGeneration || runningCommands.get(commandId) !== command) {
      throw new Error('Browser command no longer owns this relay connection')
    }
  }
  const assertActive = async () => {
    assertOwned()
    if (command.tabId !== undefined) {
      if ((tabStopVersions.get(command.tabId) ?? 0) > command.stopVersion) {
        command.cancelReason = 'tab_stop_requested'
        controller.abort(command.cancelReason)
        controller.signal.throwIfAborted()
      }
      const { groupId, revision: groupRevision } = await getActiveNine1GroupSnapshot()
      assertOwned()
      const tab = await chrome.tabs.get(command.tabId)
      assertOwned()
      if (groupRevision !== getNine1GroupRevision() || groupId === null || tab.groupId !== groupId || (requirePage && !isAutomatableTabUrl(tab.url))) {
        command.cancelReason = 'target_no_longer_managed_or_automatable'
        controller.abort(command.cancelReason)
        controller.signal.throwIfAborted()
      }
      command.groupRevision = groupRevision
    }
  }

  const releaseOwnedInput = async (method: string, params: Record<string, unknown>) => {
    if (!((method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') ||
          (method === 'Input.dispatchKeyEvent' && params.type === 'keyUp'))) {
      throw new Error('Input cleanup only permits release events')
    }
    const assertLease = () => {
      if (command.generation !== connectionGeneration || command.tabId === undefined || command.groupRevision !== getNine1GroupRevision()) {
        throw new Error('Input cleanup no longer owns its target')
      }
    }
    assertLease()
    const assertInput = await inputOwnership.assertOwned(command, command.tabId!, method, params)
    assertLease()
    const { groupId, revision: groupRevision } = await getActiveNine1GroupSnapshot()
    assertLease()
    if (groupRevision !== command.groupRevision) throw new Error('Input cleanup no longer owns its target')
    const tab = await chrome.tabs.get(command.tabId!)
    assertLease()
    if (groupId === null || tab.groupId !== groupId || !isAutomatableTabUrl(tab.url)) {
      throw new Error('Input cleanup target is no longer managed or automatable')
    }
    // No await between the final lease check and dispatch.
    assertLease()
    assertInput()
    await inputOwnership.send(command, command.tabId!, method, params, () => {
      assertLease()
      assertInput()
      return chrome.debugger.sendCommand({ tabId: command.tabId! }, method, params)
    })
  }
  const dispatchInput = async (method: string, params: Record<string, unknown>) => {
    await assertActive()
    if (command.tabId === undefined) throw new Error('Input command requires a managed target')
    return inputOwnership.send(command, command.tabId, method, params, () => {
      assertOwned()
      return chrome.debugger.sendCommand({ tabId: command.tabId! }, method, params)
    })
  }

  const deadlineMs = normalizeCommandTimeoutMs(timeoutMs)
  const timeoutHandle = setTimeout(() => {
    command.cancelReason = 'timeout'
    controller.abort('timeout')
  }, deadlineMs)

  let rejectOnAbort: (() => void) | undefined
  try {
    const aborted = new Promise<never>((_, reject) => {
      rejectOnAbort = () => reject(new Error('Command aborted'))
      controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
      if (controller.signal.aborted) rejectOnAbort()
    })
    const result = await Promise.race([
      (async () => {
        assertOwned()
        return executor({ signal: controller.signal, commandId, tabId, assertActive, releaseOwnedInput, dispatchInput }, command)
      })(),
      aborted,
    ])

    if (controller.signal.aborted) {
      const reason = command.cancelReason ?? 'cancelled'
      throw new Error(reason === 'timeout' ? 'Command timeout' : `Command cancelled (${reason})`)
    }

    return result
  } catch (error) {
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const reason = command.cancelReason ?? 'cancelled'
      throw new Error(reason === 'timeout' ? 'Command timeout' : `Command cancelled (${reason})`)
    }
    throw error
  } finally {
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
    clearTimeout(timeoutHandle)
    if (runningCommands.get(commandId) === command) {
      runningCommands.delete(commandId)
      markCommandFinish(command)
    }
  }
}

async function resolveManagedCommandTab(sessionId?: string, targetId?: string, requirePage = true): Promise<number> {
  let tab: chrome.tabs.Tab | null = null
  if (sessionId) {
    const entry = Array.from(activeSessions).find(([, sid]) => sid === sessionId)
    if (!entry) throw new Error(`Browser session not found in active Nine1Bot tab group: ${sessionId}`)
    if (targetId !== undefined && targetId !== String(entry[0])) throw new Error('Browser session and target disagree')
    tab = await chrome.tabs.get(entry[0])
  } else if (targetId !== undefined) {
    if (!/^\d+$/.test(targetId) || !Number.isSafeInteger(Number(targetId))) throw new Error(`Invalid browser target: ${targetId}`)
    tab = await chrome.tabs.get(Number(targetId))
  } else {
    tab = await getDefaultNine1Tab()
    if (requirePage && tab && !isAutomatableTabUrl(tab.url)) {
      tab = (await getTabsInActiveNine1Group()).find(candidate => isAutomatableTabUrl(candidate.url)) ?? tab
    }
  }
  if (tab?.id === undefined) {
    throw new Error('No active Nine1Bot tab group. Open the Nine1Bot side panel from the extension icon first.')
  }
  if (!await isTabInActiveNine1Group(tab.id)) {
    throw new Error(`Browser target is outside the active Nine1Bot tab group: ${tab.id}`)
  }
  if (requirePage && !isAutomatableTabUrl(tab.url)) {
    throw new Error('Browser target is not an automatable http/https/file tab.')
  }
  await attachManagedTarget(tab)
  return tab.id
}

/**
 * 处理来自 Relay Server 的消息
 */
async function handleRelayMessage(data: string, socket: WebSocket, generation: number): Promise<void> {
  const reply = (message: unknown) => {
    if (ws === socket && generation === connectionGeneration) sendToRelay(message)
  }
  let message: any
  try {
    message = JSON.parse(data)
  } catch {
    console.error('[Relay Client] Failed to parse message:', data)
    return
  }

  // 处理 ping
  if (message.method === 'ping') {
    lastPongAt = Date.now()
    reply({ method: 'pong' })
    return
  }

  if (message.method === 'cancelCDPCommand') {
    const cancelled = cancelRunningCommands({
      commandId: typeof message.params?.commandId === 'number' ? message.params.commandId : undefined,
      tabId: typeof message.params?.tabId === 'number' ? message.params.tabId : undefined,
      reason: message.params?.reason || 'server_cancel',
    })
    reply({ id: message.id, result: { cancelled } })
    return
  }

  // 处理 CDP 命令转发请求
  if (message.method === 'forwardCDPCommand') {
    const { id } = message
    const { method, params, sessionId, targetId } = message.params || {}

    try {
      const result = await handleCdpCommand(id, method, params, sessionId, targetId, generation)
      reply({ id, result })
    } catch (error) {
      reply({
        id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }
}

/**
 * 处理 CDP 命令
 */
async function handleCdpCommand(commandId: number, method: string, params: any, sessionId?: string, targetId?: string, generation = connectionGeneration): Promise<unknown> {
  if (method === 'cancelCDPCommand') {
    return { cancelled: cancelRunningCommands({
      commandId: typeof params?.commandId === 'number' ? params.commandId : undefined,
      tabId: typeof params?.tabId === 'number' ? params.tabId : undefined,
      reason: params?.reason || 'cancelCDPCommand',
    }) }
  }
  const toolName = method === 'Extension.callTool' ? params?.toolName : undefined
  const requestedTab = params?.args?.tabId
  const knownTabId = sessionId
    ? Array.from(activeSessions).find(([, sid]) => sid === sessionId)?.[0]
    : typeof targetId === 'string' && /^\d+$/.test(targetId)
      ? Number(targetId)
      : typeof requestedTab === 'number' && Number.isSafeInteger(requestedTab) ? requestedTab : undefined
  return executeTrackedCommand({
    commandId, tabId: knownTabId, sessionId, method, toolName,
    timeoutMs: typeof params?.timeoutMs === 'number' ? params.timeoutMs : undefined,
    taskLabel: typeof params?.taskLabel === 'string' ? params.taskLabel : undefined,
    requirePage: method !== 'Page.navigate' && toolName !== 'navigate',
  }, async (context, command) => {
    console.log('[Relay Client] Handling CDP command:', method, 'sessionId:', sessionId)

    // The bridge uses an empty tab ID for untargeted creation/navigation.
    if (targetId === '') targetId = undefined
    const tabManagement = toolName === 'tabs_context_mcp' || toolName === 'tabs_create_mcp'
    const navigation = method === 'Page.navigate' || toolName === 'navigate'
    const toolTabId = method === 'Extension.callTool' ? params?.args?.tabId : undefined
    if (toolTabId !== undefined) {
      if (!Number.isSafeInteger(toolTabId) || toolTabId < 0) throw new Error('Invalid tool tabId')
      if (targetId !== undefined && targetId !== String(toolTabId)) throw new Error('Browser target and tool tabId disagree')
      targetId = String(toolTabId)
    }
    if (method === 'Target.getTargets') {
      const tabs = await getTabsInActiveNine1Group()
      return { targetInfos: tabs.map(targetInfoForTab) }
    }
    if (method === 'Target.setAutoAttach' || method === 'Target.setDiscoverTargets') return {}
    const needsTab = !tabManagement || sessionId !== undefined || targetId !== undefined
    const tabId = needsTab ? await resolveManagedCommandTab(sessionId, targetId, !tabManagement && !navigation && method !== 'Target.getTargetInfo') : undefined
    if (generation !== connectionGeneration) throw new Error('Relay connection changed before command execution')
    if (method === 'Target.getTargetInfo') return { targetInfo: targetInfoForTab(await chrome.tabs.get(tabId!)) }
    command.tabId = tabManagement ? undefined : tabId
    context.tabId = command.tabId
    await context.assertActive!()
    await markCommandStart(command)
    await context.assertActive!()

    // 根据 CDP method 调用相应的工具
    switch (method) {
      // 扩展工具直接转发（不受 CSP 限制）
      case 'Extension.callTool': {
        const { toolName, args, timeoutMs, taskLabel } = params || {}

        if (typeof toolName !== 'string') {
          throw new Error('toolName is required for Extension.callTool')
        }

        return await executeExtensionToolCommand({
          commandId,
          tabId: tabManagement ? undefined : tabId,
          sessionId,
          toolName,
          args: (args ?? {}) as Record<string, unknown>,
          timeoutMs: typeof timeoutMs === 'number' ? timeoutMs : undefined,
          taskLabel: typeof taskLabel === 'string' ? taskLabel : undefined,
        }, context)
      }

      default: {
        if (tabId === undefined) throw new Error('A valid managed browser tab is required')

        // Debugger attachment is unavailable on chrome:// pages. Bootstrap
        // navigation via tabs.update, under the same cancellation/target owner.
        if (method === 'Page.navigate') {
          const tab = await chrome.tabs.get(tabId)
          await context.assertActive!()
          if (!isAutomatableTabUrl(tab.url)) {
            if (!isAutomatableTabUrl(params?.url) && params?.url !== 'about:blank') throw new Error('Navigation requires an http/https/file URL or about:blank')
            await chrome.tabs.update(tabId, { url: params.url })
            return { frameId: 'main' }
          }
        }
        return executePageCdpCommand(tabId, method, params, ensureDebuggerAttached, context.assertActive, context.releaseOwnedInput, context.dispatchInput)
      }
    }
  })
}

async function ensureDebuggerAttached(tabId: number): Promise<void> {
  if (attachedTabs.has(tabId)) return

  try {
    await chrome.debugger.attach({ tabId }, '1.3')
    attachedTabs.add(tabId)
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('already attached'))) {
      throw error
    }
    attachedTabs.add(tabId)
  }
}

/**
 * 监听标签页变化并通知 Relay Server
 */
function setupTabListeners(): void {
  // 新标签页创建
  chrome.tabs.onCreated.addListener((tab) => {
    if (!tab.id) return
    setTimeout(() => {
      chrome.tabs.get(tab.id!).then((freshTab) => attachManagedTarget(freshTab)).catch(() => {})
    }, 150)
  })

  // 标签页更新（URL/标题变化）
  chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    if (changeInfo.groupId !== undefined) {
      if (activeSessions.has(tabId) && !await isTabInActiveNine1Group(tabId)) {
        detachManagedTarget(tabId, 'tab_left_nine1_group')
        return
      }
      await attachManagedTarget(tab).catch(() => {})
    }

    if (changeInfo.url || changeInfo.title) {
      if (!await isTabInActiveNine1Group(tabId)) {
        detachManagedTarget(tabId, 'tab_left_nine1_group')
        return
      }
      const sessionId = activeSessions.get(tabId)
      if (!sessionId) {
        await attachManagedTarget(tab).catch(() => {})
        return
      }
      forwardCdpEvent('Target.targetInfoChanged', {
        targetInfo: targetInfoForTab(tab),
      })
    }
  })

  // 标签页关闭
  chrome.tabs.onRemoved.addListener((tabId) => {
    detachManagedTarget(tabId, 'tab_removed')
  })

  // 标签页激活
  chrome.tabs.onActivated.addListener(async (activeInfo) => {
    const tab = await chrome.tabs.get(activeInfo.tabId)
    await attachManagedTarget(tab)
  })
}

/**
 * 发送当前 Nine1Bot 标签组信息
 */
async function sendInitialTargets(generation = connectionGeneration): Promise<void> {
  const tabs = await getTabsInActiveNine1Group()
  for (const tab of tabs) {
    await attachManagedTarget(tab, generation)
  }
}

export async function activateDedicatedNine1TabGroup(windowId?: number): Promise<{ groupId: number | null; tabId?: number }> {
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: windowId === undefined,
    ...(windowId !== undefined ? { windowId } : {}),
  })

  if (!activeTab?.id) {
    return { groupId: null }
  }

  const groupId = await addTabToNine1Group(activeTab.id)
  detachAllActiveSessions()
  await sendInitialTargets()
  return { groupId, tabId: activeTab.id }
}

function setupRuntimeListeners(): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'nine1bot-agent-stop-request') return false

    const senderTabId = sender.tab?.id
    const requestedTabId = typeof message.tabId === 'number' ? message.tabId : senderTabId
    const cancelled = cancelRunningCommands({
      tabId: requestedTabId,
      reason: 'user_stop',
    })

    if (requestedTabId !== undefined) {
      tabStopRequestedAt.set(requestedTabId, Date.now())
      sendAgentStateToTabs(requestedTabId).catch(() => {
        // ignore state send errors
      })
    }

    sendResponse({ ok: true, cancelled, tabId: requestedTabId })
    return true
  })
}

function setupServerConfigListener(): void {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return
    if (!changes[SERVER_ORIGIN_STORAGE_KEY]) return

    const nextValue = changes[SERVER_ORIGIN_STORAGE_KEY].newValue
    if (typeof nextValue !== 'string' || !nextValue.trim()) return

    const nextOrigin = normalizeServerOrigin(nextValue)
    if (nextOrigin === configuredServerOrigin && (isConnecting || isRelayConnected())) return

    console.log('[Relay Client] Server origin changed, reconnecting to:', nextOrigin)
    disconnectFromRelay()
    configuredServerOrigin = nextOrigin
    pairedInstanceId = null
    connectToRelay()
  })
}

/**
 * 连接到 Relay Server
 */
export function connectToRelay(url?: string): void {
  if (isConnecting || ws) return
  // A manual/config-driven attempt supersedes any older backoff. Clear its
  // timer before taking a new generation so an early failure can schedule one.
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  isConnecting = true
  const generation = ++connectionGeneration
  const open = (resolvedUrl: string | null) => {
    if (!resolvedUrl || generation !== connectionGeneration) return
    console.log('[Relay Client] Connecting to:', resolvedUrl)
    try {
      const socket = new WebSocket(resolvedUrl)
      ws = socket
      const ownsConnection = () => ws === socket && generation === connectionGeneration
      socket.onopen = () => {
        if (!ownsConnection()) return
        isConnecting = false
        reconnectAttempt = 0
        lastPongAt = Date.now()
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = null
        sendExtensionHello()
        sendExtensionHealth()
        startHealthReporting()
        startAgentHeartbeat()
        sendInitialTargets(generation).catch((error) => console.error('[Relay Client] Initial targets failed:', error))
      }
      socket.onmessage = (event) => {
        if (!ownsConnection()) return
        handleRelayMessage(event.data, socket, generation).catch((error) => console.error('[Relay Client] Message failed:', error))
      }
      socket.onclose = () => {
        if (!ownsConnection()) return
        cleanup()
        scheduleReconnect(url, connectionGeneration)
      }
      socket.onerror = (error) => {
        if (!ownsConnection()) return
        console.error('[Relay Client] WebSocket error:', error)
        cleanup()
        socket.close()
        scheduleReconnect(url, connectionGeneration)
      }
    } catch (error) {
      if (generation !== connectionGeneration) return
      console.error('[Relay Client] Failed to connect:', error)
      cleanup()
      scheduleReconnect(url, connectionGeneration)
    }
  }
  if (url) {
    open(url)
  } else {
    getConfiguredRelayUrl(generation).then(open).catch((error) => {
      if (generation !== connectionGeneration) return
      console.error('[Relay Client] Failed to resolve relay URL:', error)
      isConnecting = false
      scheduleReconnect(undefined, generation)
    })
  }
}

/** Clean up only after the calling handler has verified connection ownership. */
function cleanup(): void {
  connectionGeneration += 1
  isConnecting = false
  stopTimers()
  ws = null
  activeSessions.clear()
  for (const command of runningCommands.values()) {
    command.cancelReason = 'relay_disconnected'
    command.controller.abort('relay_disconnected')
  }
  runningCommands.clear()
  tabActiveCommandCount.clear()
  tabStopRequestedAt.clear()
  tabStopVersions.clear()
  inputOwnership.clear()
  tabStateVersions.clear()
  stopRequestVersion = 0
}

function scheduleReconnect(url: string | undefined, generation: number): void {
  if (reconnectTimer || generation !== connectionGeneration) return
  reconnectAttempt += 1
  const base = Math.min(RECONNECT_BASE_INTERVAL * 2 ** Math.max(0, reconnectAttempt - 1), RECONNECT_MAX_INTERVAL)
  const delay = base + Math.floor(Math.random() * 1000)
  const timer = setTimeout(() => {
    if (reconnectTimer !== timer || generation !== connectionGeneration) return
    reconnectTimer = null
    connectToRelay(url)
  }, delay)
  reconnectTimer = timer
}

export function disconnectFromRelay(): void {
  // Invalidate pending bootstrap reads and all callbacks before closing the socket.
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  const socket = ws
  cleanup()
  socket?.close()
}

/**
 * 获取连接状态
 */
export function isRelayConnected(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN
}

/**
 * 初始化 Relay Client
 */
export function initRelayClient(): void {
  console.log('[Relay Client] Initializing...')

  setupTabListeners()
  setupRuntimeListeners()
  setupServerConfigListener()
  setupDiagnosticsListeners()
  setupTabGroupCleanup()
  console.log('[Relay Client] Tab/runtime listeners set up')

  // 监听 debugger 断开
  chrome.debugger.onDetach.addListener((source) => {
    if (source.tabId) {
      attachedTabs.delete(source.tabId)
    }
  })

  // 尝试连接（使用 chrome.storage 中配置的 URL）
  connectToRelay()
}
