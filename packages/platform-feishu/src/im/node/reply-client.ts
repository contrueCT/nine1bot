import type {
  FeishuIMCard,
  FeishuIMReplyClient,
  FeishuIMReplyDelivery,
  FeishuIMSentMessage,
} from '../reply-client'

export type FeishuNodeReplyClientOptions = {
  client: {
    im?: {
      message?: FeishuNodeMessageApi
    }
  }
  receiveIdType?: 'chat_id' | 'open_id' | 'user_id' | 'union_id'
}

type FeishuNodeMessageApi = {
  create?: (input: unknown) => Promise<unknown>
  reply?: (input: unknown) => Promise<unknown>
  update?: (input: unknown) => Promise<unknown>
  patch?: (input: unknown) => Promise<unknown>
}

export function createFeishuNodeReplyClient(options: FeishuNodeReplyClientOptions): FeishuIMReplyClient {
  const receiveIdType = options.receiveIdType ?? 'chat_id'
  const messageApi = options.client.im?.message
  return {
    async sendText(input) {
      return normalizeSentMessage(await sendMessage(messageApi, input, 'text', { text: input.text }, receiveIdType))
    },
    async sendCard(input) {
      return normalizeSentMessage(await sendMessage(messageApi, input, 'interactive', input.card, receiveIdType))
    },
    async updateCard(input) {
      if (!messageApi?.update && !messageApi?.patch) {
        throw new Error('Feishu message update API is unavailable')
      }
      const method = messageApi.update ?? messageApi.patch!
      return normalizeSentMessage(await method({
        path: {
          message_id: input.messageId,
        },
        data: {
          content: JSON.stringify(input.card),
        },
      }))
    },
  }
}

async function sendMessage(
  api: FeishuNodeMessageApi | undefined,
  input: FeishuIMReplyDelivery,
  msgType: 'text' | 'interactive',
  content: { text: string } | FeishuIMCard,
  receiveIdType: string,
): Promise<unknown> {
  if (!api?.create && !api?.reply) {
    throw new Error('Feishu message send API is unavailable')
  }
  const data = {
    receive_id: input.chatId,
    msg_type: msgType,
    content: JSON.stringify(content),
  }
  if (input.rootMessageId && api.reply) {
    return api.reply({
      path: {
        message_id: input.rootMessageId,
      },
      data: {
        msg_type: msgType,
        content: JSON.stringify(content),
      },
    })
  }
  return api.create!({
    params: {
      receive_id_type: receiveIdType,
    },
    data,
  })
}

function normalizeSentMessage(input: unknown): FeishuIMSentMessage {
  const record = asRecord(input)
  const data = asRecord(record?.data) ?? record
  const messageId = stringValue(data?.message_id)
    ?? stringValue(data?.messageId)
    ?? stringValue(asRecord(data?.message)?.message_id)
  return {
    messageId,
    cardId: stringValue(data?.card_id) ?? stringValue(data?.cardId),
    raw: input,
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
