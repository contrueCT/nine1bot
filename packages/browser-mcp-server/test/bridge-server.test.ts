import { describe, expect, test } from 'bun:test'
import { BridgeServer } from '../src/bridge/server'

describe('BridgeServer form fill', () => {
  test('treats target-looking refs as stable target IDs', async () => {
    const bridge = new BridgeServer()
    let expression = ''
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => [],
      sendCommand: async (_method: string, params: { expression?: string }) => {
        expression = params.expression ?? ''
        return {
          result: {
            value: JSON.stringify({ success: true, elementType: 'input' }),
          },
        }
      },
    }

    const result = await bridge.fillForm('123', 'target_abc123', 'hello', 'user')

    expect(result.success).toBe(true)
    expect(expression).toContain('resolveElement(targetId)')
    expect(expression).toContain('target_abc123')
    expect(expression).not.toContain('Element with ref')
  })

  test('normalizes invalid locate results before callers read matches', async () => {
    const bridge = new BridgeServer()
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => [],
      sendCommand: async () => ({ result: { value: '{}' } }),
    }

    const result = await bridge.locateElements('123', { query: 'missing' }, 'user')

    expect(result.matches).toEqual([])
    expect(result.warnings[0]).toContain('invalid')
  })

  test('mentions targetId in click argument validation', async () => {
    const bridge = new BridgeServer()

    await expect(bridge.clickElement('123', {}, 'bot')).rejects.toThrow('targetId')
  })

  test('rebuilds stable extension targets from authoritative tab scans', async () => {
    const bridge = new BridgeServer()
    let relayTargets: Array<{
      sessionId: string
      targetId: string
      targetInfo: { targetId: string; title: string; url: string; type: string }
    }> = []
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => ['tabs_context_mcp'],
      getTargets: () => relayTargets,
      upsertTargetsFromTabs: (tabs: Array<{ id: string; title: string; url: string; sessionId?: string }>) => {
        relayTargets = tabs.map((tab) => ({
          sessionId: tab.sessionId ?? `tab_${tab.id}`,
          targetId: String(tab.id),
          targetInfo: {
            targetId: String(tab.id),
            title: tab.title,
            url: tab.url,
            type: 'page',
          },
        }))
        return relayTargets
      },
      sendCommand: async () => ({
        content: [{
          type: 'text',
          text: JSON.stringify({
            allTabs: [{
              id: 12,
              title: 'Authoritative Tab',
              url: 'https://example.com',
              active: true,
              windowId: 7,
            }],
            tabScanStatus: {
              source: 'authoritative_group_scan',
              reasonCode: 'ok',
            },
          }),
        }],
      }),
      getHealth: () => null,
      getDiagnostics: () => null,
      getHelloAt: () => null,
      getHello: () => null,
      getAgentStates: () => [],
    }

    const status = await bridge.getStatus()

    expect(status.user?.tabs[0]?.sessionId).toBe('tab_12')
    expect(status.user?.tabListSource).toBe('authoritative_group_scan')
    expect(status.runtime?.issues.map((issue) => issue.code)).toContain('relay_cache_empty')
  })

  test('falls back to relay cache when authoritative tab scans fail', async () => {
    const bridge = new BridgeServer()
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => ['tabs_context_mcp'],
      getTargets: () => [{
        sessionId: 'tab_44',
        targetId: '44',
        targetInfo: {
          targetId: '44',
          title: 'Cached Tab',
          url: 'https://cached.example.com',
          type: 'page',
        },
      }],
      upsertTargetsFromTabs: () => [],
      sendCommand: async () => {
        throw new Error('boom')
      },
      getHealth: () => null,
      getDiagnostics: () => null,
      getHelloAt: () => null,
      getHello: () => null,
      getAgentStates: () => [],
    }

    const status = await bridge.getStatus()
    const issueCodes = status.runtime?.issues.map((issue) => issue.code) ?? []

    expect(status.user?.tabs[0]?.id).toBe('44')
    expect(status.user?.tabListSource).toBe('relay_cache_fallback')
    expect(issueCodes).toContain('tab_scan_failed')
    expect(issueCodes).toContain('relay_cache_fallback')
  })

  test('surfaces extension tool errors from authoritative tab scans', async () => {
    const bridge = new BridgeServer()
    const bridgeWithRelay = bridge as any

    bridgeWithRelay.relay = {
      extensionConnected: () => true,
      getTools: () => ['tabs_context_mcp'],
      getTargets: () => [],
      upsertTargetsFromTabs: () => [],
      sendCommand: async () => ({
        isError: true,
        content: [{
          type: 'text',
          text: 'Error getting tabs context: no active group',
        }],
      }),
      getHealth: () => null,
      getDiagnostics: () => null,
      getHelloAt: () => null,
      getHello: () => null,
      getAgentStates: () => [],
    }

    const status = await bridge.getStatus()

    expect(status.user?.tabs).toEqual([])
    expect(status.runtime?.issues).toContainEqual({
      code: 'tab_scan_failed',
      severity: 'error',
      message: 'Extension tab scan failed: Error getting tabs context: no active group',
    })
  })
})
