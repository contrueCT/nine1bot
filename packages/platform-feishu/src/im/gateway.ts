import type { FeishuIMAccount, FeishuIMIncomingMessage } from './types'

export type FeishuIMGatewayEvent = {
  accountId: string
  message: FeishuIMIncomingMessage
}

export type FeishuIMGatewayOptions = {
  account: FeishuIMAccount
  onMessage: (event: FeishuIMGatewayEvent) => void | Promise<void>
}

export type FeishuIMGatewayHandle = {
  start(): Promise<void>
  stop(): Promise<void>
  injectMessage(message: FeishuIMIncomingMessage): Promise<void>
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
    isStarted() {
      return started
    },
  }
}
