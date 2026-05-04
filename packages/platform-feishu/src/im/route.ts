import type { FeishuIMIncomingMessage } from './types'

export type FeishuIMRouteKey = {
  platform: 'feishu'
  chatId: string
  chatType: FeishuIMIncomingMessage['chatType']
  threadId?: string
}

export function routeKeyForFeishuMessage(message: FeishuIMIncomingMessage): FeishuIMRouteKey {
  return {
    platform: 'feishu',
    chatId: message.chatId,
    chatType: message.chatType,
    threadId: message.rootId || message.parentId,
  }
}

export function serializeFeishuRouteKey(key: FeishuIMRouteKey): string {
  return [
    key.platform,
    key.chatType,
    key.chatId,
    key.threadId,
  ].filter(Boolean).join(':')
}
