import type { FeishuIMIncomingMessage } from './types'

export type FeishuIMRouteKey = {
  platform: 'feishu'
  accountId: string
  kind: 'dm' | 'group' | 'thread'
  chatId: string
  openId?: string
  threadId?: string
}

export function routeKeyForFeishuMessage(
  message: FeishuIMIncomingMessage,
  options: {
    accountId?: string
  } = {},
): FeishuIMRouteKey {
  const accountId = options.accountId || 'default'
  const threadId = message.rootId || message.parentId
  if (message.chatType === 'p2p') {
    return {
      platform: 'feishu',
      accountId,
      kind: 'dm',
      chatId: message.chatId,
      openId: message.sender.openId || message.sender.userId || message.sender.unionId || message.chatId,
    }
  }

  return {
    platform: 'feishu',
    accountId,
    kind: threadId ? 'thread' : 'group',
    chatId: message.chatId,
    threadId,
  }
}

export function serializeFeishuRouteKey(key: FeishuIMRouteKey): string {
  if (key.kind === 'dm') {
    return [key.platform, key.accountId, 'dm', key.openId || key.chatId].join(':')
  }
  if (key.kind === 'thread') {
    return [key.platform, key.accountId, 'thread', key.chatId, key.threadId || 'root'].join(':')
  }
  return [key.platform, key.accountId, 'group', key.chatId].join(':')
}
