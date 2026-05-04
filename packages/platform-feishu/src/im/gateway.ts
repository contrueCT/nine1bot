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

export type FeishuIMGatewayOptions = {
  account: FeishuIMAccount
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
  onCardAction?: (event: FeishuIMGatewayCardActionEvent) => FeishuIMCard | undefined | Promise<FeishuIMCard | undefined>
}

export type FeishuIMGatewayHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  injectMessage(message: FeishuIMIncomingMessage): Promise<void>
  injectCardAction(input: unknown): Promise<FeishuIMCard | undefined>
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
      return await options.onCardAction({
        accountId: options.account.id,
        payload: parsed.payload,
        value: parsed.value,
        raw: input,
      })
    },
    isStarted() {
      return started
    },
  }
}
