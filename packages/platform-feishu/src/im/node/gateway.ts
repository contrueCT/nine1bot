import { AppType, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk'
import { FeishuEventDeduplicator } from '../dedup'
import { parseFeishuCardAction } from '../interactions'
import { parseFeishuIMEvent } from '../inbound/parse'
import {
  formatFeishuCardActionResponse,
  type FeishuIMGatewayCardActionEvent,
  type FeishuIMGatewayCardActionResponse,
  type FeishuIMGatewayEvent,
  type FeishuIMGatewayHandle,
} from '../gateway'
import type { FeishuIMCard } from '../reply-client'
import type { FeishuIMAccount } from '../types'

export type FeishuNodeIMGatewayOptions = {
  account: FeishuIMAccount
  appSecret: string
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
  onCardAction?: (event: FeishuIMGatewayCardActionEvent) => FeishuIMCard | undefined | Promise<FeishuIMCard | undefined>
  onError?: (error: Error) => void | Promise<void>
}

export function createFeishuNodeIMGateway(options: FeishuNodeIMGatewayOptions): FeishuIMGatewayHandle {
  const dedup = new FeishuEventDeduplicator()
  const wsClient = new WSClient({
    appId: options.account.appId,
    appSecret: options.appSecret,
    domain: Domain.Feishu,
    logger: createLogger(options.onError),
    loggerLevel: LoggerLevel.info,
    autoReconnect: true,
  })
  let started = false

  const handleRawMessage = async (raw: unknown) => {
    if (senderType(raw) && senderType(raw) !== 'user') return
    const message = parseFeishuIMEvent(raw)
    if (!message) return
    if (!dedup.accept(message.eventId)) return
    if (!dedup.accept(`message:${message.messageId}`)) return
    await options.onMessage({
      accountId: options.account.id,
      message,
    })
  }

  const handleRawCardAction = async (raw: unknown): Promise<FeishuIMGatewayCardActionResponse | undefined> => {
    if (!options.onCardAction) return undefined
    const parsed = parseFeishuCardAction(raw)
    if (!parsed.ok) {
      await options.onError?.(new Error(`Invalid Feishu card action: ${parsed.reason}`))
      return undefined
    }
    if (!dedup.accept(`card-action:${parsed.payload.nonce}`)) return undefined
    const card = await options.onCardAction({
      accountId: options.account.id,
      payload: parsed.payload,
      value: parsed.value,
      raw,
    })
    return formatFeishuCardActionResponse(raw, card)
  }

  return {
    async start() {
      if (started) return
      await wsClient.start({
        eventDispatcher: new EventDispatcher({}).register({
          'im.message.receive_v1': handleRawMessage,
          'im.message.message_read_v1': async () => {},
          'card.action.trigger': handleRawCardAction,
          'card.action.trigger_v1': handleRawCardAction,
        }),
      })
      started = true
    },
    async stop() {
      if (!started) return
      started = false
      dedup.clear()
      wsClient.close({ force: true })
    },
    async injectMessage(message) {
      if (!started) return
      if (!dedup.accept(message.eventId)) return
      if (!dedup.accept(`message:${message.messageId}`)) return
      await options.onMessage({
        accountId: options.account.id,
        message,
      })
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

function createLogger(onError: FeishuNodeIMGatewayOptions['onError']) {
  return {
    error: (...msg: unknown[]) => {
      void onError?.(new Error(msg.map(String).join(' ')))
    },
    warn: (...msg: unknown[]) => {
      const rendered = msg.map(String).join(' ')
      if (rendered.toLowerCase().includes('reconnect')) return
      void onError?.(new Error(rendered))
    },
    info: () => {},
    debug: () => {},
    trace: () => {},
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
