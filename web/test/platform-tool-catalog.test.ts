import { describe, expect, test } from 'bun:test'
import { platformToolRows, stalePlatformToolIDs } from '../src/utils/platform-tool-catalog'
import type { PlatformToolSummary } from '../src/api/client'

describe('platform tool catalog rows', () => {
  test('keeps selectable status while hiding declared-only and disabling unavailable rows', () => {
    const rows = platformToolRows([
      summary('demo_ready', 'user-selectable', 'registered'),
      summary('demo_hidden', 'declared-only', 'registered'),
      summary('demo_auth', 'user-selectable', 'auth-required'),
      summary('demo_conflict', 'user-selectable', 'conflict'),
      summary('demo_error', 'user-selectable', 'error'),
      summary('demo_unavailable', 'user-selectable', 'unavailable'),
    ])

    expect(rows.map((row) => row.id)).toEqual([
      'demo_auth',
      'demo_conflict',
      'demo_error',
      'demo_ready',
      'demo_unavailable',
    ])
    expect(rows.find((row) => row.id === 'demo_ready')?.selectable).toBe(true)
    expect(rows.find((row) => row.id === 'demo_auth')).toMatchObject({
      selectable: false,
      canOpenSettings: true,
    })
    expect(rows.find((row) => row.id === 'demo_conflict')).toMatchObject({
      selectable: false,
      canOpenSettings: false,
    })
    expect(rows.find((row) => row.id === 'demo_error')).toMatchObject({
      selectable: true,
      canOpenSettings: true,
    })
  })

  test('does not classify saved tools as stale when the catalog failed to load', () => {
    const rows = platformToolRows([summary('demo_ready', 'user-selectable', 'registered')])

    expect(stalePlatformToolIDs(['demo_ready', 'demo_missing'], rows, false)).toEqual([])
    expect(stalePlatformToolIDs(['demo_ready', 'demo_missing'], rows, true)).toEqual(['demo_missing'])
  })
})

function summary(
  id: string,
  catalogVisibility: PlatformToolSummary['catalogVisibility'],
  status: PlatformToolSummary['status'],
): PlatformToolSummary {
  return {
    id,
    ownerId: 'demo-platform',
    description: `Use ${id}`,
    catalogVisibility,
    status,
    generation: 1,
  }
}
