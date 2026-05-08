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

export type FeishuIMGatewayConnectionState = 'connected' | 'reconnecting' | 'connection-error' | 'stopped'

export type FeishuIMGatewayConnectionStateEvent = {
  accountId: string
  state: FeishuIMGatewayConnectionState
  at: string
  message?: string
}

export type FeishuIMGatewayOptions = {
  account: FeishuIMAccount
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
  onCardAction?: (event: FeishuIMGatewayCardActionEvent) => FeishuIMCard | undefined | Promise<FeishuIMCard | undefined>
  onConnectionStateChange?: (event: FeishuIMGatewayConnectionStateEvent) => void | Promise<void>
  onOperationalError?: (error: Error) => void | Promise<void>
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
      if (started) return
      started = true
      await emitConnectionState(options, 'connected')
    },
    async stop() {
      if (!started) return
      started = false
      await emitConnectionState(options, 'stopped')
    },
    async injectMessage(message) {
      if (!started) return
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
      if (!started || !options.onCardAction) return undefined
      const parsed = parseFeishuCardAction(input)
      if (!parsed.ok) {
        await emitOperationalError(options, new Error(`Invalid Feishu card action: ${parsed.reason}`))
        return undefined
      }
      try {
        const card = await options.onCardAction({
          accountId: options.account.id,
          payload: parsed.payload,
          value: parsed.value,
          raw: input,
        })
        return formatFeishuCardActionResponse(input, card)
      } catch (error) {
        await emitOperationalError(options, error)
        return undefined
      }
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

async function emitConnectionState(
  options: Pick<FeishuIMGatewayOptions, 'account' | 'onConnectionStateChange'>,
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
  options: Pick<FeishuIMGatewayOptions, 'onOperationalError'>,
  error: unknown,
) {
  const normalized = error instanceof Error ? error : new Error(String(error))
  await options.onOperationalError?.(normalized)
}
