import { FeishuEventDeduplicator } from '../dedup'
import { parseFeishuCardAction } from '../interactions'
import { parseFeishuIMEvent } from '../inbound/parse'
import {
  formatFeishuCardActionResponse,
  type FeishuIMGatewayCardActionEvent,
  type FeishuIMGatewayCardActionResponse,
  type FeishuIMGatewayConnectionState,
  type FeishuIMGatewayEvent,
  type FeishuIMGatewayHandle,
} from '../gateway-interface'
import type { FeishuIMCard } from '../reply-client'
import type { FeishuIMAccount } from '../types'

export type FeishuNodeIMGatewayOptions = {
  account: FeishuIMAccount
  appSecret: string
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
  onCardAction?: (event: FeishuIMGatewayCardActionEvent) => FeishuIMCard | undefined | Promise<FeishuIMCard | undefined>
  onConnectionStateChange?: (event: {
    accountId: string
    state: FeishuIMGatewayConnectionState
    at: string
    message?: string
  }) => void | Promise<void>
  onOperationalError?: (error: Error) => void | Promise<void>
}

type FeishuSdkDomain = {
  Feishu: unknown
}

type FeishuSdkLoggerLevel = {
  info: unknown
}

type FeishuSdkEventDispatcherInstance = {
  register(events: Record<string, (input: unknown) => unknown>): unknown
}

type FeishuSdkEventDispatcher = new (input: Record<string, never>) => FeishuSdkEventDispatcherInstance

type FeishuSdkWsClientInstance = {
  start(input: unknown): Promise<void>
  close(input: { force: boolean }): void
}

type FeishuSdkWsClient = new (input: {
  appId: string
  appSecret: string
  domain: unknown
  logger: ReturnType<typeof createLogger>
  loggerLevel: unknown
  autoReconnect: boolean
}) => FeishuSdkWsClientInstance

type FeishuNodeGatewaySdkModule = {
  Domain: FeishuSdkDomain
  EventDispatcher: FeishuSdkEventDispatcher
  LoggerLevel: FeishuSdkLoggerLevel
  WSClient: FeishuSdkWsClient
}

let sdkLoader: (() => Promise<FeishuNodeGatewaySdkModule>) | undefined

export function setFeishuNodeGatewaySdkLoaderForTesting(
  loader?: () => Promise<FeishuNodeGatewaySdkModule>,
) {
  sdkLoader = loader
}

export function createFeishuNodeIMGateway(options: FeishuNodeIMGatewayOptions): FeishuIMGatewayHandle {
  const dedup = new FeishuEventDeduplicator()
  let wsClient: FeishuSdkWsClientInstance | undefined
  let started = false

  const handleRawMessage = async (raw: unknown) => {
    if (senderType(raw) && senderType(raw) !== 'user') return
    const message = parseFeishuIMEvent(raw)
    if (!message) return
    if (!dedup.accept(message.eventId)) return
    if (!dedup.accept(`message:${message.messageId}`)) return
    try {
      await options.onMessage({
        accountId: options.account.id,
        message,
      })
    } catch (error) {
      await emitOperationalError(options, error)
    }
  }

  const handleRawCardAction = async (raw: unknown): Promise<FeishuIMGatewayCardActionResponse | undefined> => {
    if (!options.onCardAction) return undefined
    const parsed = parseFeishuCardAction(raw)
    if (!parsed.ok) {
      await emitOperationalError(options, new Error(`Invalid Feishu card action: ${parsed.reason}`))
      return undefined
    }
    if (!dedup.accept(`card-action:${parsed.payload.nonce}`)) return undefined
    try {
      const card = await options.onCardAction({
        accountId: options.account.id,
        payload: parsed.payload,
        value: parsed.value,
        raw,
      })
      return formatFeishuCardActionResponse(raw, card)
    } catch (error) {
      await emitOperationalError(options, error)
      return undefined
    }
  }

  return {
    async start() {
      if (started) return
      const { Domain, EventDispatcher, LoggerLevel, WSClient } = await loadSdk()
      wsClient = new WSClient({
        appId: options.account.appId,
        appSecret: options.appSecret,
        domain: Domain.Feishu,
        logger: createLogger(options),
        loggerLevel: LoggerLevel.info,
        autoReconnect: true,
      })
      await wsClient.start({
        eventDispatcher: new EventDispatcher({}).register({
          'im.message.receive_v1': handleRawMessage,
          'im.message.message_read_v1': async () => {},
          'card.action.trigger': handleRawCardAction,
          'card.action.trigger_v1': handleRawCardAction,
        }),
      })
      started = true
      await emitConnectionState(options, 'connected')
    },
    async stop() {
      if (!started) return
      started = false
      dedup.clear()
      wsClient?.close({ force: true })
      wsClient = undefined
      await emitConnectionState(options, 'stopped')
    },
    async injectMessage(message) {
      if (!started) return
      if (!dedup.accept(message.eventId)) return
      if (!dedup.accept(`message:${message.messageId}`)) return
      try {
        await options.onMessage({
          accountId: options.account.id,
          message,
        })
      } catch (error) {
        await emitOperationalError(options, error)
      }
    },
    async injectCardAction(input) {
      if (!started) return undefined
      return await handleRawCardAction(input)
    },
    isStarted() {
      return started
    },
  }
}

function senderType(raw: unknown): string | undefined {
  const envelope = asRecord(raw)
  const event = asRecord(envelope?.event) ?? envelope
  const sender = asRecord(event?.sender)
  return stringValue(sender?.sender_type)
}

function createLogger(options: Pick<FeishuNodeIMGatewayOptions, 'account' | 'onConnectionStateChange' | 'onOperationalError'>) {
  return {
    error: (...msg: unknown[]) => {
      const rendered = msg.map(String).join(' ')
      void emitConnectionState(options, 'connection-error', rendered)
    },
    warn: (...msg: unknown[]) => {
      const rendered = msg.map(String).join(' ')
      if (isReconnectLikeWarning(rendered)) {
        void emitConnectionState(options, 'reconnecting', rendered)
        return
      }
      void emitOperationalError(options, new Error(rendered))
    },
    info: () => {},
    debug: () => {},
    trace: () => {},
  }
}

async function loadSdk(): Promise<FeishuNodeGatewaySdkModule> {
  if (sdkLoader) return await sdkLoader()
  return await import('@larksuiteoapi/node-sdk') as unknown as FeishuNodeGatewaySdkModule
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function isReconnectLikeWarning(message: string): boolean {
  const lowered = message.toLowerCase()
  return lowered.includes('reconnect')
    || lowered.includes('disconnect')
    || lowered.includes('close')
    || lowered.includes('socket')
}

async function emitConnectionState(
  options: Pick<FeishuNodeIMGatewayOptions, 'account' | 'onConnectionStateChange'>,
  state: FeishuIMGatewayConnectionState,
  message?: string,
) {
  await options.onConnectionStateChange?.({
    accountId: options.account.id,
    state,
    at: new Date().toISOString(),
    message,
  })
}

async function emitOperationalError(
  options: Pick<FeishuNodeIMGatewayOptions, 'onOperationalError'>,
  error: unknown,
) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  await options.onOperationalError?.(normalized)
}
