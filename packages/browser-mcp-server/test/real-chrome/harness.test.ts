import { describe, expect, test } from 'bun:test'
import { chromeArguments, eventually, parseDebuggingPort, within } from './harness'

describe('real-Chrome harness unit checks (synthetic; do not launch Chrome)', () => {
  test('launch arguments use isolated profiles without disabling browser security', () => {
    const args = chromeArguments('/tmp/disposable profile', '/tmp/built extension')
    expect(args).toContain('--user-data-dir=/tmp/disposable profile')
    expect(args).toContain('--remote-debugging-port=0')
    expect(args).toContain('--remote-debugging-address=127.0.0.1')
    expect(args).toContain('--load-extension=/tmp/built extension')
    expect(args.some(arg => /no-sandbox|disable-.*security|ignore-certificate|disable-extensions|disable-site-isolation/.test(arg))).toBe(false)
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
