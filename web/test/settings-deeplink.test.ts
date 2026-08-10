import { describe, expect, test } from 'bun:test'
import { parseSettingsDeepLink, platformSettingsUrl } from '../src/utils/settings-deeplink'

describe('platform settings deep links', () => {
  test('builds and parses a platform settings URL', () => {
    const url = platformSettingsUrl('http://127.0.0.1:4096', 'demo-platform')
    expect(url).toBe('http://127.0.0.1:4096/?settings=platforms&platform=demo-platform')
    expect(parseSettingsDeepLink(url)).toEqual({
      section: 'platforms',
      platformId: 'demo-platform',
    })
  })

  test('rejects unsafe owner IDs and unsupported protocols', () => {
    for (const ownerId of [
      'https://evil.example',
      'demo\nplatform',
      'demo/platform',
      'demo?platform=evil',
    ]) {
      expect(() => platformSettingsUrl('http://127.0.0.1:4096', ownerId)).toThrow()
    }
    expect(() => platformSettingsUrl('javascript:alert(1)', 'demo-platform')).toThrow()
    expect(parseSettingsDeepLink('http://127.0.0.1:4096/?settings=platforms&platform=https://evil.example')).toBeUndefined()
    expect(parseSettingsDeepLink('http://127.0.0.1:4096/?settings=models&platform=demo-platform')).toBeUndefined()
  })
})
