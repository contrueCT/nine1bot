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
