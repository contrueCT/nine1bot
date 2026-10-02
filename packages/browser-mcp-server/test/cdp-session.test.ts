import { describe, expect, test, spyOn } from 'bun:test'
import { EventEmitter } from 'node:events'
import { CDPSession } from '../src/core/cdp'

class SocketStub extends EventEmitter {
  readyState = 1
  sent: any[] = []
  error?: Error
  throwOnSend = false
  send(message: string, callback: (error?: Error) => void) {
    if (this.throwOnSend) throw new Error('Synchronous send failure')
    this.sent.push(JSON.parse(message))
    callback(this.error)
  }
  close() { this.readyState = 3; this.emit('close') }
}

function setup() {
  const socket = new SocketStub()
  const session = new CDPSession(socket as any)
  return { socket, session }
}

describe('CDPSession pending commands', () => {
  test('clears timers on replies and protocol errors', async () => {
    const { socket, session } = setup()
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      const success = session.send('Page.enable')
      socket.emit('message', JSON.stringify({ id: 1, result: { enabled: true } }))
      expect(await success).toEqual({ enabled: true })
      const failure = session.send('Page.reload')
      socket.emit('message', JSON.stringify({ id: 2, error: { message: 'Reload failed' } }))
      await expect(failure).rejects.toThrow('Reload failed')
      expect(clear).toHaveBeenCalledTimes(2)
    } finally {
      clear.mockRestore()
      session.close()
    }
  })

  test('rejects outstanding commands and subsequent sends when locally closed', async () => {
    const { session } = setup()
    const pending = session.send('Runtime.evaluate')
    session.close()
    await expect(pending).rejects.toThrow('CDP session closed')
    await expect(session.send('Page.reload')).rejects.toThrow('CDP session closed')
  })

  test('rejects outstanding commands on remote close and websocket error', async () => {
    for (const event of ['close', 'error']) {
      const { socket, session } = setup()
      const pending = session.send('Runtime.evaluate')
      socket.emit(event, ...(event === 'error' ? [new Error('Transport failed')] : []))
      await expect(pending).rejects.toThrow(event === 'error' ? 'Transport failed' : 'CDP session closed')
      session.close()
    }
  })

  test('cleans up callback and synchronous send failures', async () => {
    const { socket, session } = setup()
    const clear = spyOn(globalThis, 'clearTimeout')
    try {
      socket.error = new Error('Send failed')
      await expect(session.send('Page.reload')).rejects.toThrow('Send failed')
      socket.throwOnSend = true
      await expect(session.send('Page.reload')).rejects.toThrow('Synchronous send failure')
      expect(clear).toHaveBeenCalledTimes(2)
    } finally {
      clear.mockRestore()
      session.close()
    }
  })
})
