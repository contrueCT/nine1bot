import { describe, expect, test } from 'bun:test'
import { getExtensionRelay } from '../src/bridge/relay-routes'

describe('extension relay target validation', () => {
  test('reports disconnected extension before validating target IDs', async () => {
    await expect(
      getExtensionRelay().sendCommand('Runtime.evaluate', { expression: '1 + 1' }, 'missing-target'),
    ).rejects.toThrow('Chrome extension not connected')
  })

  test('prunes stale cached targets when authoritative tabs are rebuilt', async () => {
    const relay = getExtensionRelay()
    await relay.stop()

    relay.upsertTargetsFromTabs([
      { id: '1', sessionId: 'tab_1', title: 'First', url: 'https://first.example.com' },
      { id: '2', sessionId: 'tab_2', title: 'Second', url: 'https://second.example.com' },
    ])
    expect(relay.getTargets().map((target) => target.targetId)).toEqual(['1', '2'])

    relay.upsertTargetsFromTabs([
      { id: '2', sessionId: 'tab_2', title: 'Second', url: 'https://second.example.com' },
    ])

    expect(relay.getTargets().map((target) => target.targetId)).toEqual(['2'])
  })
})
