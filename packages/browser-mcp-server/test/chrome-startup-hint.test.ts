import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { chromeStartupHint } from '../src/core/chrome'

test.each([
  ['ENOENT', 'browser.executablePath'],
  ['No such file or directory', 'browser.executablePath'],
  ['EACCES', 'account running Nine1Bot'],
  ['Permission denied', 'account running Nine1Bot'],
  ['No usable SANDBOX', 'do not disable the sandbox'],
  ['Missing display', 'browser.headless'],
  ['Missing X server', 'browser.headless'],
  ['Failed to initialize Ozone', 'browser.headless'],
  ['Failed to create SingletonLock', 'do not delete an active profile lock'],
  ['PROFILE is already in USE', 'do not delete an active profile lock'],
  ['profile could not acquire a lock', 'do not delete an active profile lock'],
  ['profile profile profile locked', 'do not delete an active profile lock'],
  ['profile\t is in use', 'do not delete an active profile lock'],
  ['CDP endpoint not available', 'configured CDP port'],
])('keeps actionable startup guidance for %s', (message, hint) => {
  expect(chromeStartupHint(message)).toContain(hint)
})

test('preserves diagnostic precedence and does not cross profile line boundaries', () => {
  expect(chromeStartupHint('ENOENT sandbox profile locked')).toContain('browser.executablePath')
  expect(chromeStartupHint('permission denied profile locked')).toContain('account running Nine1Bot')
  expect(chromeStartupHint('sandbox display profile locked')).toContain('do not disable the sandbox')
  expect(chromeStartupHint('display profile locked')).toContain('browser.headless')
  expect(chromeStartupHint('CDP endpoint not available: profile locked')).toContain('do not delete an active profile lock')
  for (const separator of ['\n', '\r', '\r\n', '\u2028', '\u2029']) {
    expect(chromeStartupHint(`profile${separator}locked`)).toBe('')
    expect(chromeStartupHint(`profile${separator}in use`)).toBe('')
    expect(chromeStartupHint(`profile${separator}another profile in use`)).toContain('profile is already in use')
    expect(chromeStartupHint(`profile${separator}SingletonLock`)).toContain('profile is already in use')
  }
  for (const message of ['', 'unknown startup error', 'profile', 'locked before profile', 'use another profile']) {
    expect(chromeStartupHint(message)).toBe('')
  }
})

test('bounds adversarial repeated-prefix classification without launching Chrome', () => {
  // A separate Bun process provides a hard deadline even if a synchronous regex
  // regression blocks its event loop. The former profile.* pattern exceeds it.
  const moduleUrl = new URL('../src/core/chrome.ts', import.meta.url).href
  const result = spawnSync(process.execPath, ['--eval', `
    import { chromeStartupHint } from ${JSON.stringify(moduleUrl)}
    const repeated = 'profile'.repeat(200_000)
    for (const message of [repeated, repeated + '\\nlocked', repeated + '\\ruse', repeated + '\\u2028lock', repeated + '\\u2029use']) {
      if (chromeStartupHint(message) !== '') throw new Error('Unexpected profile-lock match')
    }
    if (!chromeStartupHint(repeated + ' locked').includes('profile is already in use')) throw new Error('Missing lock guidance')
    if (!chromeStartupHint(repeated + '\\nprofile in use').includes('profile is already in use')) throw new Error('Missing later-line guidance')
    if (!chromeStartupHint(repeated + '\\nCDP endpoint not available').includes('configured CDP port')) throw new Error('Missing CDP guidance')
    console.log('classified')
  `], { encoding: 'utf8', timeout: 2000 })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout.trim()).toBe('classified')
})
