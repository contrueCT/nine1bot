import { afterEach, describe, expect, test } from 'bun:test'
import { parseFeishuIMEvent } from '../src/im'
import {
  createFeishuNodeIMGateway,
  setFeishuNodeGatewaySdkLoaderForTesting,
} from '../src/im/node/ws-gateway'

type FakeWsClientInstance = {
  logger: {
    error: (...message: unknown[]) => void
    warn: (...message: unknown[]) => void
    info: (...message: unknown[]) => void
    debug: (...message: unknown[]) => void
    trace: (...message: unknown[]) => void
  }
  eventDispatcher?: {
    handlers?: Record<string, (input: unknown) => unknown>
  }
}

const fakeWsClients: FakeWsClientInstance[] = []
let startBehavior: (() => Promise<void>) | undefined

afterEach(() => {
  fakeWsClients.length = 0
  startBehavior = undefined
  setFeishuNodeGatewaySdkLoaderForTesting(undefined)
})

describe('Feishu node gateway lifecycle', () => {
  test('emits connected and stopped around gateway lifecycle', async () => {
    const states: string[] = []
    installFakeSdk()

    const gateway = createFeishuNodeIMGateway({
      account: {
        id: 'default',
        enabled: true,
        appId: 'cli_xxx',
        appSecretRef: { provider: 'env', key: 'FEISHU_SECRET' },
        connectionMode: 'websocket',
      },
      appSecret: 'secret',
      onMessage: async () => {},
      onConnectionStateChange: async (event) => {
        states.push(event.state)
      },
    })

    await gateway.start()
    await gateway.stop()

    expect(states).toEqual(['connected', 'stopped'])
  })

  test('classifies reconnect warnings separately from operational warnings and errors', async () => {
    const states: Array<{ state: string; message?: string }> = []
    const operationalErrors: string[] = []
    installFakeSdk()

    const gateway = createFeishuNodeIMGateway({
      account: {
        id: 'default',
        enabled: true,
        appId: 'cli_xxx',
        appSecretRef: { provider: 'env', key: 'FEISHU_SECRET' },
        connectionMode: 'websocket',
      },
      appSecret: 'secret',
      onMessage: async () => {},
      onConnectionStateChange: async (event) => {
        states.push({ state: event.state, message: event.message })
      },
      onOperationalError: async (error) => {
        operationalErrors.push(error.message)
      },
    })

    await gateway.start()

    fakeWsClients[0]!.logger.warn('socket closed by peer')
    fakeWsClients[0]!.logger.warn('unexpected handler warning')
    fakeWsClients[0]!.logger.error('websocket fatal error')

    expect(states).toEqual([
      { state: 'connected', message: undefined },
      { state: 'reconnecting', message: 'socket closed by peer' },
      { state: 'connection-error', message: 'websocket fatal error' },
    ])
    expect(operationalErrors).toEqual(['unexpected handler warning'])
  })

  test('routes invalid card actions and message handler failures to operational errors', async () => {
    const operationalErrors: string[] = []
    installFakeSdk()

    const gateway = createFeishuNodeIMGateway({
      account: {
        id: 'default',
        enabled: true,
        appId: 'cli_xxx',
        appSecretRef: { provider: 'env', key: 'FEISHU_SECRET' },
        connectionMode: 'websocket',
      },
      appSecret: 'secret',
      onMessage: async () => {
        throw new Error('message handler failed')
      },
      onCardAction: async () => undefined,
      onOperationalError: async (error) => {
        operationalErrors.push(error.message)
      },
    })

    await gateway.start()
    await gateway.injectCardAction({ invalid: true })
    await gateway.injectMessage(parseFeishuIMEvent({
      event: {
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_p2p',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      },
    })!)

    expect(operationalErrors).toEqual([
      expect.stringContaining('Invalid Feishu card action'),
      'message handler failed',
    ])
  })
})

function installFakeSdk() {
  setFeishuNodeGatewaySdkLoaderForTesting(async () => ({
    Domain: { Feishu: 'feishu' },
    LoggerLevel: { info: 'info' },
    EventDispatcher: class FakeEventDispatcher {
      handlers: Record<string, (input: unknown) => unknown> = {}

      register(events: Record<string, (input: unknown) => unknown>) {
        this.handlers = { ...this.handlers, ...events }
        return this
      }
    },
    WSClient: class FakeWSClient {
      readonly logger
      eventDispatcher?: { handlers?: Record<string, (input: unknown) => unknown> }

      constructor(input: FakeWsClientInstance) {
        this.logger = input.logger
        fakeWsClients.push(this)
      }

      async start(input: { eventDispatcher: { handlers?: Record<string, (input: unknown) => unknown> } }) {
        this.eventDispatcher = input.eventDispatcher
        await startBehavior?.()
      }

      close() {}
    } as any,
  }))
}
