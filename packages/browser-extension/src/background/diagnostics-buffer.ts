import { abortableDelay, throwIfAborted } from '../tools/execution-context'

export interface ConsoleMessageEntry {
  timestamp: number
  level: string
  text: string
  source?: string
  url?: string
  line?: number
  column?: number
}

export interface NetworkRequestEntry {
  timestamp: number
  requestId: string
  url: string
  method: string
  resourceType?: string
  status?: number
  statusText?: string
  mimeType?: string
  failed?: boolean
  errorText?: string
  durationMs?: number
}

interface TabDiagnostics {
  console: ConsoleMessageEntry[]
  network: NetworkRequestEntry[]
  requestStarts: Map<string, { startedAt: number; url: string; method: string; resourceType?: string }>
}

const MAX_BUFFER_SIZE = 300

const tabBuffers = new Map<number, TabDiagnostics>()
const debuggerEnabledTabs = new Set<number>()
let listenersSetup = false

function pushLimited<T>(arr: T[], item: T): void {
  arr.push(item)
  if (arr.length > MAX_BUFFER_SIZE) {
    arr.splice(0, arr.length - MAX_BUFFER_SIZE)
  }
}

function getOrCreateTabDiagnostics(tabId: number): TabDiagnostics {
  let diagnostics = tabBuffers.get(tabId)
  if (!diagnostics) {
    diagnostics = {
      console: [],
      network: [],
      requestStarts: new Map(),
    }
    tabBuffers.set(tabId, diagnostics)
  }
  return diagnostics
}

function tryGetTabId(target: chrome.debugger.Debuggee): number | null {
  return target.tabId ?? null
}

export function setupDiagnosticsListeners(): void {
  if (listenersSetup) return
  listenersSetup = true

  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = tryGetTabId(source)
    if (tabId === null) return

    const diagnostics = getOrCreateTabDiagnostics(tabId)
    const now = Date.now()

    if (method === 'Runtime.consoleAPICalled') {
      const payload = params as {
        type?: string
        args?: Array<{ value?: unknown; description?: string }>
        stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number; columnNumber?: number }> }
      }
      const text = (payload.args ?? [])
        .map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description ?? ''))
        .join(' ')
        .trim()
      const frame = payload.stackTrace?.callFrames?.[0]
      pushLimited(diagnostics.console, {
        timestamp: now,
        level: payload.type ?? 'log',
        text: text || '(empty console message)',
        source: 'Runtime.consoleAPICalled',
        url: frame?.url,
        line: frame?.lineNumber,
        column: frame?.columnNumber,
      })
      return
    }

    if (method === 'Log.entryAdded') {
      const payload = params as {
        entry?: {
          level?: string
          text?: string
          source?: string
          url?: string
          lineNumber?: number
        }
      }
      const entry = payload.entry
      if (!entry) return
      pushLimited(diagnostics.console, {
        timestamp: now,
        level: entry.level ?? 'info',
        text: entry.text ?? '',
        source: entry.source,
        url: entry.url,
        line: entry.lineNumber,
      })
      return
    }

    if (method === 'Network.requestWillBeSent') {
      const payload = params as {
        requestId?: string
        request?: { url?: string; method?: string }
        type?: string
      }
      if (!payload.requestId) return
      diagnostics.requestStarts.set(payload.requestId, {
        startedAt: now,
        url: payload.request?.url ?? '',
        method: payload.request?.method ?? 'GET',
        resourceType: payload.type,
      })
      return
    }

    if (method === 'Network.responseReceived') {
      const payload = params as {
        requestId?: string
        type?: string
        response?: { url?: string; status?: number; statusText?: string; mimeType?: string }
      }
      if (!payload.requestId) return
      const start = diagnostics.requestStarts.get(payload.requestId)
      const response = payload.response
      pushLimited(diagnostics.network, {
        timestamp: now,
        requestId: payload.requestId,
        url: response?.url ?? start?.url ?? '',
        method: start?.method ?? 'GET',
        resourceType: payload.type ?? start?.resourceType,
        status: response?.status,
        statusText: response?.statusText,
        mimeType: response?.mimeType,
        durationMs: start ? now - start.startedAt : undefined,
      })
      return
    }

    if (method === 'Network.loadingFailed') {
      const payload = params as {
        requestId?: string
        type?: string
        errorText?: string
      }
      if (!payload.requestId) return
      const start = diagnostics.requestStarts.get(payload.requestId)
      pushLimited(diagnostics.network, {
        timestamp: now,
        requestId: payload.requestId,
        url: start?.url ?? '',
        method: start?.method ?? 'GET',
        resourceType: payload.type ?? start?.resourceType,
        failed: true,
        errorText: payload.errorText,
        durationMs: start ? now - start.startedAt : undefined,
      })
    }
  })

  chrome.debugger.onDetach.addListener((source) => {
    const tabId = tryGetTabId(source)
    if (tabId === null) return
    debuggerEnabledTabs.delete(tabId)
  })
}

async function ensureDebuggerEnabled(tabId: number): Promise<void> {
  setupDiagnosticsListeners()

  if (!debuggerEnabledTabs.has(tabId)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('already attached'))) {
        throw error
      }
    }
  }

  await chrome.debugger.sendCommand({ tabId }, 'Log.enable')
  await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable')
  debuggerEnabledTabs.add(tabId)
}

export async function sampleConsoleMessages(options: {
  tabId: number
  sampleMs?: number
  max?: number
  sinceMs?: number
  level?: string
  signal?: AbortSignal
}): Promise<ConsoleMessageEntry[]> {
  const { tabId, sampleMs = 1500, max = 50, sinceMs, level, signal } = options
  throwIfAborted(signal)
  await ensureDebuggerEnabled(tabId)
  const startedAt = Date.now()
  await abortableDelay(sampleMs, signal)
  throwIfAborted(signal)

  const diagnostics = getOrCreateTabDiagnostics(tabId)
  const sinceTs = sinceMs !== undefined ? Date.now() - sinceMs : startedAt

  return diagnostics.console
    .filter((item) => item.timestamp >= sinceTs)
    .filter((item) => (level ? item.level.toLowerCase() === level.toLowerCase() : true))
    .slice(-max)
}

export async function sampleNetworkRequests(options: {
  tabId: number
  sampleMs?: number
  max?: number
  sinceMs?: number
  resourceType?: string
  signal?: AbortSignal
}): Promise<NetworkRequestEntry[]> {
  const { tabId, sampleMs = 1500, max = 50, sinceMs, resourceType, signal } = options
  throwIfAborted(signal)
  await ensureDebuggerEnabled(tabId)
  const startedAt = Date.now()
  await abortableDelay(sampleMs, signal)
  throwIfAborted(signal)

  const diagnostics = getOrCreateTabDiagnostics(tabId)
  const sinceTs = sinceMs !== undefined ? Date.now() - sinceMs : startedAt

  return diagnostics.network
    .filter((item) => item.timestamp >= sinceTs)
    .filter((item) => (resourceType ? (item.resourceType ?? '').toLowerCase() === resourceType.toLowerCase() : true))
    .slice(-max)
}

