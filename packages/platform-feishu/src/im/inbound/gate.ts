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
  if (!config.enabled) return { allowed: false, reason: 'not-allowlisted' }

  if (config.policy.allowFrom.length > 0 && !matchesAllowList(message, config.policy.allowFrom)) {
    return { allowed: false, reason: 'not-allowlisted' }
  }

  if (message.chatType === 'p2p') {
    return config.policy.dmPolicy === 'deny'
      ? { allowed: false, reason: 'dm-denied' }
      : { allowed: true }
  }

  if (message.chatType === 'group') {
    if (config.policy.groupPolicy === 'deny') {
      return { allowed: false, reason: 'group-denied' }
    }
    if ((config.policy.groupPolicy === 'mention-only' || config.policy.requireMention) && !mentionsBot(message, options)) {
      return { allowed: false, reason: 'mention-required' }
    }
    return { allowed: true }
  }

  return { allowed: false, reason: 'not-allowlisted' }
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
  if (!options.botOpenId && !options.botUserId) return false
  return message.mentions.some((mention) => (
    (options.botOpenId && mention.openId === options.botOpenId) ||
    (options.botUserId && mention.userId === options.botUserId)
  ))
}
