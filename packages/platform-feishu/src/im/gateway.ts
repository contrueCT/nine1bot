import { parseFeishuCardAction, type FeishuCardActionPayload, type FeishuCardActionValue } from './interactions'
import type { FeishuIMCard } from './reply-client'
import type { FeishuIMAccount, FeishuIMIncomingMessage } from './types'

export type FeishuIMGatewayEvent = {
  accountId: string
  message: FeishuIMIncomingMessage
}

export type FeishuIMGatewayCardActionEvent = {
  accountId: string
  payload: FeishuCardActionPayload
  value: FeishuCardActionValue
  raw: unknown
}

export type FeishuIMGatewayCardActionResponse = FeishuIMCard | {
  toast: {
    type: 'success' | 'info' | 'warning' | 'error'
    content: string
  }
  card: {
    type: 'raw'
    data: FeishuIMCard
  }
}

export type FeishuIMGatewayOptions = {
  account: FeishuIMAccount
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
  onCardAction?: (event: FeishuIMGatewayCardActionEvent) => FeishuIMCard | undefined | Promise<FeishuIMCard | undefined>
}

export type FeishuIMGatewayHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  injectMessage(message: FeishuIMIncomingMessage): Promise<void>
  injectCardAction(input: unknown): Promise<FeishuIMGatewayCardActionResponse | undefined>
  isStarted(): boolean
}

export function createFeishuIMGateway(options: FeishuIMGatewayOptions): FeishuIMGatewayHandle {
  let started = false

  return {
    async start() {
      started = true
    },
    async stop() {
      started = false
    },
    async injectMessage(message) {
      if (!started) return
      await options.onMessage({
        accountId: options.account.id,
        message,
      })
    },
    async injectCardAction(input) {
      if (!started || !options.onCardAction) return undefined
      const parsed = parseFeishuCardAction(input)
      if (!parsed.ok) return undefined
      const card = await options.onCardAction({
        accountId: options.account.id,
        payload: parsed.payload,
        value: parsed.value,
        raw: input,
      })
      return formatFeishuCardActionResponse(input, card)
    },
    isStarted() {
      return started
    },
  }
}

export function formatFeishuCardActionResponse(
  raw: unknown,
  card: FeishuIMCard | undefined,
): FeishuIMGatewayCardActionResponse | undefined {
  if (!card) return undefined
  if (cardActionEventType(raw) === 'card.action.trigger') {
    return {
      toast: {
        type: 'success',
        content: '操作已处理',
      },
      card: {
        type: 'raw',
        data: card,
      },
    }
  }
  return card
}

function cardActionEventType(raw: unknown): string | undefined {
  const record = asRecord(raw)
  return stringValue(record?.event_type)
    ?? stringValue(asRecord(record?.header)?.event_type)
    ?? stringValue(record?.type)
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
