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

export function parseFeishuRouteKey(input: string): FeishuIMRouteKey | undefined {
  const parts = input.split(':')
  if (parts[0] !== 'feishu') return undefined
  const accountId = parts[1]
  const kind = parts[2]
  if (!accountId) return undefined
  if (kind === 'dm') {
    const openId = parts[3]
    if (!openId) return undefined
    return {
      platform: 'feishu',
      accountId,
      kind,
      chatId: openId,
      openId,
    }
  }
  if (kind === 'group') {
    const chatId = parts[3]
    if (!chatId) return undefined
    return {
      platform: 'feishu',
      accountId,
      kind,
      chatId,
    }
  }
  if (kind === 'thread') {
    const chatId = parts[3]
    const threadId = parts[4]
    if (!chatId || !threadId) return undefined
    return {
      platform: 'feishu',
      accountId,
      kind,
      chatId,
      threadId,
    }
  }
  return undefined
}
