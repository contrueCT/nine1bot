export type SettingsDeepLink = {
  section: 'platforms'
  platformId?: string
}

const PLATFORM_ID = /^[a-z][a-z0-9_-]{0,63}$/

export function isSafePlatformId(value: unknown): value is string {
  return typeof value === 'string' && PLATFORM_ID.test(value)
}

export function platformSettingsUrl(baseUrl: string, platformId: string): string {
  if (!isSafePlatformId(platformId)) throw new Error('Invalid platform ID')
  const base = new URL(baseUrl)
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('Unsupported platform settings URL protocol')
  }

  const target = new URL('/', base.origin)
  target.searchParams.set('settings', 'platforms')
  target.searchParams.set('platform', platformId)
  return target.toString()
}

export function parseSettingsDeepLink(url: string): SettingsDeepLink | undefined {
  try {
    const target = new URL(url)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined
    if (target.searchParams.get('settings') !== 'platforms') return undefined
    const platformId = target.searchParams.get('platform')
    if (platformId !== null && !isSafePlatformId(platformId)) return undefined
    return {
      section: 'platforms',
      ...(platformId ? { platformId } : {}),
    }
  } catch {
    return undefined
  }
}
