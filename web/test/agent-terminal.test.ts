import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { useAgentTerminal, TERMINAL_SCREEN_LIMITS } from '../src/composables/useAgentTerminal'
import { agentTerminalApi } from '../src/api/client'

const originalFetch = globalThis.fetch
const originalMethods = { ...agentTerminalApi }
const mockState = {
  agtBChunks: [] as Array<{ seq: number; data: string }>,
  pauseAAfterSeq1: false,
  resumeAAfterSeq1: undefined as (() => void) | undefined,
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetchMock() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const parsed = new URL(url, 'http://localhost')

    if (parsed.pathname === '/agent-terminal' && parsed.searchParams.get('sessionID') === 'ses_a') {
      return jsonResponse([
        {
          id: 'agt_a',
          name: 'A',
          sessionID: 'ses_a',
          status: 'running',
          rows: 24,
          cols: 80,
          createdAt: 1,
          lastActivity: 1,
        },
      ])
    }

    if (parsed.pathname === '/agent-terminal' && parsed.searchParams.get('sessionID') === 'ses_b') {
      return jsonResponse([
        {
          id: 'agt_b',
          name: 'B',
          sessionID: 'ses_b',
          status: 'running',
          rows: 24,
          cols: 80,
          createdAt: 1,
          lastActivity: 1,
        },
      ])
    }

    if (parsed.pathname === '/agent-terminal/agt_a/screen') {
      return jsonResponse({
        sessionID: 'ses_a',
        screen: 'ready',
        screenAnsi: 'ready',
        cursor: { row: 0, col: 5 },
      })
    }

    if (parsed.pathname === '/agent-terminal/agt_b/screen') {
      return jsonResponse({
        sessionID: 'ses_b',
        screen: 'b ready',
        screenAnsi: 'b ready',
        cursor: { row: 0, col: 7 },
      })
    }

    if (parsed.pathname === '/agent-terminal/agt_a/buffer' && parsed.searchParams.get('afterSeq') === '1') {
      if (mockState.pauseAAfterSeq1) {
        await new Promise<void>((resolve) => {
          mockState.resumeAAfterSeq1 = resolve
        })
      }
      return jsonResponse({
        buffer: '',
        chunks: [
          { seq: 2, data: 'two' },
          { seq: 3, data: 'three' },
        ],
        latestSeq: 3,
        firstSeq: 1,
        reset: false,
      })
    }

    if (parsed.pathname === '/agent-terminal/agt_a/buffer' && parsed.searchParams.get('afterSeq') === '0') {
      return jsonResponse({
        buffer: '',
        chunks: [],
        latestSeq: 0,
        firstSeq: 1,
        reset: false,
      })
    }

    if (parsed.pathname === '/agent-terminal/agt_b/buffer' && parsed.searchParams.get('afterSeq') === '0') {
      return jsonResponse({
        buffer: '',
        chunks: mockState.agtBChunks,
        latestSeq: mockState.agtBChunks.at(-1)?.seq ?? 0,
        firstSeq: 1,
        reset: false,
      })
    }

    return jsonResponse({ buffer: 'trimmed-tail', chunks: [], latestSeq: 0, firstSeq: 1, reset: true })
  }) as typeof fetch
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  useAgentTerminal().clearTerminals()
  mockState.agtBChunks = []
  mockState.pauseAAfterSeq1 = false
  mockState.resumeAAfterSeq1 = undefined
  installFetchMock()
})

afterEach(() => {
  useAgentTerminal().clearTerminals()
  globalThis.fetch = originalFetch
  Object.assign(agentTerminalApi, originalMethods)
})

describe('useAgentTerminal', () => {
  it('filters terminals by current session and ignores other session output', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()

    expect(terminal.terminals.value.map((item) => item.id)).toEqual(['agt_a'])
    expect(terminal.activeTerminalId.value).toBe('agt_a')

    terminal.handleSSEEvent({
      type: 'agent-terminal.created',
      properties: {
        info: {
          id: 'agt_b',
          name: 'B',
          sessionID: 'ses_b',
          status: 'running',
          rows: 24,
          cols: 80,
          createdAt: 1,
          lastActivity: 1,
        },
      },
    })
    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_b', sessionID: 'ses_b', seq: 1, data: 'wrong' },
    })

    expect(terminal.terminals.value.map((item) => item.id)).toEqual(['agt_a'])
    expect(terminal.activeScreen.value?.outputData).toBeUndefined()
  })

  it('refreshes a previously initialized session when switching back after hidden output', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_b')
    await settle()

    expect(terminal.activeTerminalId.value).toBe('agt_b')
    expect(terminal.activeScreen.value?.latestSeq).toBe(0)

    terminal.setSessionContext('ses_a')
    await settle()
    mockState.agtBChunks = [{ seq: 1, data: 'hidden' }]

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_b', sessionID: 'ses_b', seq: 1, data: 'hidden' },
    })
    expect(terminal.activeTerminalId.value).toBe('agt_a')

    terminal.setSessionContext('ses_b')
    await settle()

    expect(terminal.activeTerminalId.value).toBe('agt_b')
    expect(terminal.activeScreen.value?.outputData).toBe('hidden')
    expect(terminal.activeScreen.value?.latestSeq).toBe(1)
  })

  it('deduplicates output seqs and recovers gaps from the ring buffer', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'one' },
    })
    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'duplicate' },
    })

    expect(terminal.activeScreen.value?.outputData).toBe('one')
    expect(terminal.activeScreen.value?.latestSeq).toBe(1)

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 3, data: 'three' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(terminal.activeScreen.value?.outputData).toBe('onetwothree')
    expect(terminal.activeScreen.value?.latestSeq).toBe(3)
  })

  it('does not replay recovery chunks that arrived live while recovery was in flight', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'one' },
    })

    mockState.pauseAAfterSeq1 = true
    const recovery = terminal.recoverTerminalOutput('agt_a', 1)
    await settle()

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 2, data: 'two-live' },
    })
    mockState.resumeAAfterSeq1?.()
    await recovery

    expect(terminal.activeScreen.value?.outputData).toBe('onetwo-livethree')
    expect(terminal.activeScreen.value?.latestSeq).toBe(3)
  })

  it('keeps retained reset history and appends later output within the same epoch', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()

    await terminal.recoverTerminalOutput('agt_a', -1)

    expect(terminal.activeScreen.value?.screenAnsi).toBe('ready')
    expect(terminal.activeScreen.value?.outputData).toBe('trimmed-tail')
    expect(terminal.activeScreen.value?.outputResetToken).toBeGreaterThan(0)

    terminal.handleSSEEvent({
      type: 'agent-terminal.output',
      properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'after-reset' },
    })

    expect(terminal.activeScreen.value?.outputData).toBe('trimmed-tailafter-reset')
    expect(terminal.activeScreen.value?.outputResetToken).toBeGreaterThan(0)
  })

  it('merges live output that arrives while an older reset buffer is in flight', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'old' } })
    let resume!: (snapshot: Awaited<ReturnType<typeof agentTerminalApi.getBuffer>>) => void
    agentTerminalApi.getBuffer = () => new Promise(resolve => { resume = resolve })
    const recovery = terminal.recoverTerminalOutput('agt_a', -1)
    terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'agt_a', sessionID: 'ses_a', seq: 2, data: 'LIVE_TAIL' } })
    resume({ buffer: 'old', chunks: [], latestSeq: 1, firstSeq: 1, reset: true })
    await recovery
    expect(terminal.activeScreen.value?.latestSeq).toBe(2)
    expect(terminal.activeScreen.value?.outputSeq).toBe(2)
    expect(terminal.activeScreen.value?.outputData).toBe('oldLIVE_TAIL')
  })

  it('preserves reset and live output when an older screen request finishes later', async () => {
    const terminal = useAgentTerminal()
    let resume!: (screen: Awaited<ReturnType<typeof agentTerminalApi.getScreen>>) => void
    agentTerminalApi.getScreen = () => new Promise(resolve => { resume = resolve })
    agentTerminalApi.getBuffer = async () => ({ buffer: 'old', chunks: [], latestSeq: 1, firstSeq: 1, reset: true })
    terminal.setSessionContext('ses_a')
    await settle()
    terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'agt_a', sessionID: 'ses_a', seq: 2, data: 'LIVE_TAIL' } })
    resume({ sessionID: 'ses_a', screen: 'old', screenAnsi: 'old', cursor: { row: 0, col: 3 } })
    await settle()
    expect(terminal.activeScreen.value?.latestSeq).toBe(2)
    expect(terminal.activeScreen.value?.outputData).toBe('oldLIVE_TAIL')
  })

  it('gets a fresh full snapshot instead of rewinding when the bounded live journal overflows', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    let resume!: (snapshot: Awaited<ReturnType<typeof agentTerminalApi.getBuffer>>) => void
    const calls: Array<number | undefined> = []
    agentTerminalApi.getBuffer = async (_id, _sessionID, afterSeq) => {
      calls.push(afterSeq)
      if (calls.length === 1) return new Promise(resolve => { resume = resolve })
      return { buffer: 'fresh', chunks: [], latestSeq: 1100, firstSeq: 1090, reset: true }
    }
    const recovery = terminal.recoverTerminalOutput('agt_a', -1)
    for (let seq = 1; seq <= 1100; seq++) {
      terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'agt_a', sessionID: 'ses_a', seq, data: 'x' } })
    }
    resume({ buffer: 'old', chunks: [], latestSeq: 0, firstSeq: 1, reset: true })
    await recovery
    expect(terminal.activeScreen.value?.latestSeq).toBe(1100)
    await settle()
    expect(calls).toEqual([-1, undefined])
    expect(terminal.activeScreen.value?.outputData).toBe('fresh')
    expect(terminal.activeScreen.value?.latestSeq).toBe(1100)
  })

  it('preserves a queued full-snapshot request while an incremental recovery is running', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    const calls: Array<number | undefined> = []
    let resume!: (snapshot: Awaited<ReturnType<typeof agentTerminalApi.getBuffer>>) => void
    agentTerminalApi.getBuffer = async (_id, _sessionID, afterSeq) => {
      calls.push(afterSeq)
      if (calls.length === 1) return new Promise(resolve => { resume = resolve })
      return { buffer: 'full', chunks: [], latestSeq: 0, firstSeq: 1, reset: true }
    }
    const incremental = terminal.recoverTerminalOutput('agt_a', 0)
    await terminal.recoverTerminalOutput('agt_a')
    resume({ buffer: '', chunks: [], latestSeq: 0, firstSeq: 1, reset: false })
    await incremental
    await settle()
    expect(calls).toEqual([0, undefined])
    expect(terminal.activeScreen.value?.outputData).toBe('full')
  })

  it('releases screen and terminal metadata on session exit, and restores from the server on return', async () => {
    const terminal = useAgentTerminal()
    const calls: Array<number | undefined> = []
    const getBuffer = agentTerminalApi.getBuffer
    agentTerminalApi.getBuffer = async (id, sessionID, afterSeq) => {
      calls.push(afterSeq)
      return getBuffer(id, sessionID, afterSeq)
    }
    terminal.setSessionContext('ses_a')
    await settle()
    terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: { id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'old output' } })
    terminal.setSessionContext(null)
    expect(terminal.terminals.value).toEqual([])
    expect(terminal.activeScreen.value).toBeNull()
    expect(terminal.activeTerminalId.value).toBeNull()
    terminal.setSessionContext('ses_a')
    await settle()
    expect(calls).toEqual([0, 0])
    expect(terminal.activeScreen.value?.outputData).toBeUndefined()
  })

  it('does not repopulate cleared state from an old terminal list', async () => {
    const terminal = useAgentTerminal()
    let resume!: (list: Awaited<ReturnType<typeof agentTerminalApi.list>>) => void
    agentTerminalApi.list = () => new Promise(resolve => { resume = resolve })
    terminal.setSessionContext('ses_a')
    terminal.clearTerminals()
    resume([{ id: 'agt_a', name: 'A', sessionID: 'ses_a', status: 'running', rows: 24, cols: 80, createdAt: 1, lastActivity: 1 } as any])
    await settle()
    expect(terminal.terminals.value).toEqual([])
    expect(terminal.activeScreen.value).toBeNull()
    expect(terminal.isPanelOpen.value).toBe(false)
  })

  it('ignores an old recovery after switching away and back to the same session', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    mockState.pauseAAfterSeq1 = true
    const oldRecovery = terminal.recoverTerminalOutput('agt_a', 1)
    await settle()
    terminal.setSessionContext('ses_b')
    await settle()
    terminal.setSessionContext('ses_a')
    await settle()
    mockState.resumeAAfterSeq1?.()
    await oldRecovery
    expect(terminal.activeTerminalId.value).toBe('agt_a')
    expect(terminal.activeScreen.value?.latestSeq).toBe(0)
    expect(terminal.activeScreen.value?.outputData).toBeUndefined()
  })

  it('does not restart queued recovery or restore a closed terminal after a late response', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    mockState.pauseAAfterSeq1 = true
    const recovery = terminal.recoverTerminalOutput('agt_a', 1)
    await settle()
    await terminal.recoverTerminalOutput('agt_a', 1)
    expect(await terminal.closeTerminal('agt_a')).toBe(true)
    mockState.resumeAAfterSeq1?.()
    await recovery
    await settle()
    expect(terminal.terminals.value).toEqual([])
    expect(terminal.activeScreen.value).toBeNull()
    expect(terminal.isPanelOpen.value).toBe(false)
  })

  it('keeps only the selected screen and reloads terminal output when reselected', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    const info = { id: 'agt_second', name: 'Second', sessionID: 'ses_a', status: 'exited', rows: 24, cols: 80, createdAt: 1, lastActivity: 1 }
    agentTerminalApi.getScreen = async (id, sessionID) => ({ sessionID, screen: id, screenAnsi: id, cursor: { row: 0, col: 0 } })
    const recovered: string[] = []
    agentTerminalApi.getBuffer = async (id) => {
      recovered.push(id)
      return { buffer: id, chunks: [], latestSeq: 4, firstSeq: 1, reset: true }
    }
    terminal.handleSSEEvent({ type: 'agent-terminal.created', properties: { info } })
    await settle()
    expect(terminal.activeScreen.value?.id).toBe('agt_second')
    terminal.selectTerminal('agt_a')
    expect(terminal.activeScreen.value).toBeNull()
    await settle()
    terminal.handleSSEEvent({ type: 'agent-terminal.screen', properties: { id: 'agt_second', sessionID: 'ses_a', screen: 'hidden', screenAnsi: 'hidden', cursor: { row: 0, col: 0 } } })
    expect(terminal.activeScreen.value?.id).toBe('agt_a')
    terminal.selectTerminal('agt_second')
    await settle()
    expect(recovered).toEqual(['agt_second', 'agt_a', 'agt_second'])
  })

  it('bounds retained screen and output payloads even for oversized server messages', async () => {
    const terminal = useAgentTerminal()
    terminal.setSessionContext('ses_a')
    await settle()
    terminal.handleSSEEvent({ type: 'agent-terminal.screen', properties: {
      id: 'agt_a', sessionID: 'ses_a', screen: 's'.repeat(1024 * 1024), screenAnsi: 'a'.repeat(1024 * 1024),
      fullView: 'unneeded-extra-screen', cursor: { row: 0, col: 0 },
    } })
    terminal.handleSSEEvent({ type: 'agent-terminal.output', properties: {
      id: 'agt_a', sessionID: 'ses_a', seq: 1, data: 'x'.repeat(3 * 1024 * 1024),
    } })
    const screen = terminal.activeScreen.value!
    expect(screen.screen.length).toBe(TERMINAL_SCREEN_LIMITS.screen)
    expect(screen.screenAnsi.length).toBe(TERMINAL_SCREEN_LIMITS.screenAnsi)
    expect(screen.outputData!.length).toBe(TERMINAL_SCREEN_LIMITS.outputData / 2)
    expect(screen.outputOffset).toBe(2 * 1024 * 1024)
    expect('fullView' in screen).toBe(false)
    expect(2 * (screen.screen.length + screen.screenAnsi.length + screen.outputData!.length)).toBeLessThan(6 * 1024 * 1024)
  })


  it('allows all 120 departed session screens to be garbage collected', async () => {
    const terminal = useAgentTerminal()
    agentTerminalApi.list = async sessionID => [{ id: `terminal-${sessionID}`, sessionID, name: 'audit', status: 'exited', rows: 24, cols: 80, createdAt: 1, lastActivity: 1 }] as any
    agentTerminalApi.getScreen = async (_id, sessionID) => ({ sessionID, screen: 'done', screenAnsi: 'done', cursor: { row: 0, col: 0 } })
    agentTerminalApi.getBuffer = async (_id, sessionID) => ({ buffer: sessionID + 'x'.repeat(64 * 1024), chunks: [], latestSeq: 1, firstSeq: 1, reset: true })
    const screens: WeakRef<object>[] = []
    for (let index = 0; index < 120; index++) {
      terminal.setSessionContext(`session-${index}`)
      await settle()
      expect(terminal.activeScreen.value?.outputData).toBeDefined()
      screens.push(new WeakRef(terminal.activeScreen.value!))
    }
    terminal.setSessionContext(null)
    expect(terminal.activeScreen.value).toBeNull()
    await settle()
    Bun.gc(true)
    await settle()
    Bun.gc(true)
    expect(screens.filter(screen => screen.deref()).length).toBe(0)
  })

})
