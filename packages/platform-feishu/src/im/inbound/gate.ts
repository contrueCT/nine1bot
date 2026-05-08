import type {
  FeishuIMGateDecision,
  FeishuIMIncomingMessage,
  FeishuIMNormalizedConfig,
} from '../types'

export function evaluateFeishuIMGate(
  message: FeishuIMIncomingMessage,
  config: FeishuIMNormalizedConfig,
  options: {
    botOpenId?: string
    botUserId?: string
  } = {},
): FeishuIMGateDecision {
  if (!config.enabled) return { action: 'drop', allowed: false, reason: 'not-allowlisted' }

  if (config.policy.allowFrom.length > 0 && !matchesAllowList(message, config.policy.allowFrom)) {
    return { action: 'drop', allowed: false, reason: 'not-allowlisted' }
  }

  if (message.chatType === 'p2p') {
    return config.policy.dmPolicy === 'deny'
      ? { action: 'drop', allowed: false, reason: 'dm-denied' }
      : { action: 'dispatch', allowed: true }
  }

  if (message.chatType === 'group') {
    if (config.policy.groupPolicy === 'deny') {
      return { action: 'drop', allowed: false, reason: 'group-denied' }
    }
    if (config.policy.groupPolicy === 'allow') {
      return { action: 'dispatch', allowed: true }
    }
    if (mentionsBot(message, options)) {
      return { action: 'dispatch', allowed: true }
    }
    return { action: 'history', allowed: false, reason: 'mention-required' }
  }

  return { action: 'drop', allowed: false, reason: 'not-allowlisted' }
}

function matchesAllowList(message: FeishuIMIncomingMessage, allowFrom: string[]): boolean {
  const candidates = new Set([
    message.chatId,
    message.sender.openId,
    message.sender.userId,
    message.sender.unionId,
  ].filter((item): item is string => Boolean(item)))
  return allowFrom.some((item) => candidates.has(item))
}

function mentionsBot(
  message: FeishuIMIncomingMessage,
  options: {
    botOpenId?: string
    botUserId?: string
  },
): boolean {
  if (!options.botOpenId && !options.botUserId) return message.mentions.length > 0
  return message.mentions.some((mention) => (
    (options.botOpenId && mention.openId === options.botOpenId) ||
    (options.botUserId && mention.userId === options.botUserId)
  ))
}
