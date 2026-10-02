import { expect, test } from 'bun:test'
import { openBrowserSafely } from './open-browser'

test('delegates directly to the platform-aware browser launcher', async () => {
  const calls: string[] = []
  await openBrowserSafely('http://127.0.0.1:4096', async (url) => { calls.push(url) }, () => { throw new Error('unexpected fallback') })
  expect(calls).toEqual(['http://127.0.0.1:4096'])
})

test('a failed browser launch preserves the server and prints its URL', async () => {
  const messages: string[] = []
  await openBrowserSafely('http://127.0.0.1:4096', async () => { throw new Error('no desktop') }, (message) => messages.push(message))
  expect(messages).toHaveLength(1)
  expect(messages[0]).toContain('http://127.0.0.1:4096')
})

// Exercise the actual open(wait:false) adapter without launching a browser.
// Its Promise resolves at spawn; process errors arrive afterwards.
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { spyOn } from 'bun:test'

test('the default adapter handles late process errors and nonzero exits once', async () => {
  const child = Object.assign(new EventEmitter(), { unref() { return this } })
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => child) as unknown as typeof childProcess.spawn)
  const messages: string[] = []
  try {
    await openBrowserSafely('http://127.0.0.1:4096', undefined, message => messages.push(message))
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(child.listenerCount('error')).toBe(1)
    expect(child.listenerCount('close')).toBe(1)
    child.emit('error', new Error('ENOENT'))
    child.emit('close', 3)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('http://127.0.0.1:4096')
  } finally {
    spawn.mockRestore()
  }
})

test('the default adapter reports a failed handler exit without a spawn error', async () => {
  const child = Object.assign(new EventEmitter(), { unref() { return this } })
  const spawn = spyOn(childProcess, 'spawn').mockImplementation((() => child) as unknown as typeof childProcess.spawn)
  const messages: string[] = []
  try {
    await openBrowserSafely('http://127.0.0.1:4096', undefined, message => messages.push(message))
    child.emit('close', 3)
    expect(messages).toHaveLength(1)
  } finally {
    spawn.mockRestore()
  }
})
