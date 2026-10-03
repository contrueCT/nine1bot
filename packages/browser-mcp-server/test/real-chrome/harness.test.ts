import { describe, expect, test } from 'bun:test'
import { assertChromeForTestingVersion, chromeArguments, eventually, parseDebuggingPort, within } from './harness'

describe('real-Chrome harness unit checks (synthetic; do not launch Chrome)', () => {
  test('requires the actual Chrome for Testing brand, not a branded Chrome channel or CDP version', () => {
    expect(() => assertChromeForTestingVersion('Google Chrome for Testing 154.0.8037.97 \n')).not.toThrow()
    for (const invalid of [
      'Google Chrome 154.0.8037.97 \n',
      'Google Chrome for Testing',
      'Chromium 154.0.8037.97',
      'Chrome/154.0.8037.97',
      'HeadlessChrome/154.0.8037.97',
      'Chrome Headless Shell 154.0.8037.97',
      '',
    ]) {
      expect(() => assertChromeForTestingVersion(invalid)).toThrow('Expected the full Chrome for Testing binary')
    }
  })
  test('launch arguments use isolated profiles without disabling browser security', () => {
    const args = chromeArguments('/tmp/disposable profile', '/tmp/built extension')
    expect(args).toContain('--user-data-dir=/tmp/disposable profile')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--load-extension=/tmp/built extension')
    expect(args.some(arg => /no-sandbox|disable-.*security|ignore-certificate|disable-extensions|disable-site-isolation|enable-unsafe/.test(arg))).toBe(false)
    expect(chromeArguments('/tmp/bot').some(arg => arg.startsWith('--load-extension'))).toBe(false)
  })
  test('accepts only valid owned-profile debugging ports', () => {
    expect(parseDebuggingPort('43210\n/devtools/browser/example')).toBe(43210)
    for (const invalid of ['', '0', '-1', '65536', '123x', '1.5', ' 4096']) {
      expect(() => parseDebuggingPort(invalid)).toThrow('Invalid DevToolsActivePort')
    }
  })
  test('readiness retries transient errors and returns observed value', async () => {
    let calls = 0
    const value = await eventually('synthetic ready', async () => {
      if (++calls === 1) throw new Error('not yet')
      return 'observed'
    }, 1000)
    expect(value).toBe('observed')
    expect(calls).toBe(2)
  })
  test('bounds hung readiness checks and operations', async () => {
    await expect(within('synthetic pending', new Promise(() => {}), 10)).rejects.toThrow('exceeded')
    await expect(eventually('synthetic hung check', () => new Promise(() => {}), 10)).rejects.toThrow('within 10ms')
  })
})
