import { asRecord } from '../../shared'
import type {
  FeishuIMChatType,
  FeishuIMIncomingMessage,
  FeishuIMMention,
  FeishuIMSender,
} from '../types'

export function parseFeishuIMEvent(input: unknown): FeishuIMIncomingMessage | undefined {
  const envelope = asRecord(input)
  const event = asRecord(envelope?.event) ?? envelope
  const message = asRecord(event?.message)
  if (!event || !message) return undefined

  const messageId = stringValue(message.message_id)
  const chatId = stringValue(message.chat_id)
  if (!messageId || !chatId) return undefined

  return {
    eventId: stringValue(asRecord(envelope?.header)?.event_id) ?? stringValue(envelope?.event_id),
    messageId,
    rootId: stringValue(message.root_id) ?? stringValue(message.thread_id),
    parentId: stringValue(message.parent_id),
    chatId,
    chatType: chatTypeValue(message.chat_type),
    messageType: stringValue(message.message_type) ?? 'unknown',
    text: textFromContent(message.content),
    sender: senderFrom(event.sender),
    mentions: mentionsFrom(message.mentions),
    createTime: numberFromString(message.create_time),
    raw: input,
  }
}

export function describeIncomingMessageSource(message: FeishuIMIncomingMessage): string {
  const sender = message.sender.name || message.sender.openId || message.sender.userId || 'unknown sender'
  const chat = message.chatType === 'p2p' ? 'private chat' : message.chatType === 'group' ? 'group chat' : 'chat'
  return `${sender} in ${chat} ${message.chatId}`
}

function senderFrom(input: unknown): FeishuIMSender {
  const sender = asRecord(input)
  const senderId = asRecord(sender?.sender_id)
  return {
    openId: stringValue(senderId?.open_id),
    userId: stringValue(senderId?.user_id),
    unionId: stringValue(senderId?.union_id),
    tenantKey: stringValue(sender?.tenant_key),
    name: stringValue(sender?.name) ?? stringValue(sender?.display_name),
  }
}

function mentionsFrom(input: unknown): FeishuIMMention[] {
  if (!Array.isArray(input)) return []
  return input.map((item) => {
    const mention = asRecord(item)
    const id = asRecord(mention?.id)
    return {
      key: stringValue(mention?.key),
      name: stringValue(mention?.name),
      openId: stringValue(id?.open_id),
      userId: stringValue(id?.user_id),
      unionId: stringValue(id?.union_id),
    }
  })
}

function textFromContent(input: unknown): string | undefined {
  if (typeof input !== 'string' || !input.trim()) return undefined
  try {
    const parsed = JSON.parse(input)
    const record = asRecord(parsed)
    return stringValue(record?.text) ?? stringValue(record?.content) ?? input
  } catch {
    return input
  }
}

function chatTypeValue(input: unknown): FeishuIMChatType {
  if (input === 'p2p' || input === 'group') return input
  return 'unknown'
}

function numberFromString(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input !== 'string') return undefined
  const value = Number(input)
  return Number.isFinite(value) ? value : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
