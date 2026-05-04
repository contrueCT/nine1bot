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
    cardkit?: {
      v1?: {
        card?: FeishuNodeCardKitCardApi
        cardElement?: FeishuNodeCardKitElementApi
      }
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

type FeishuNodeCardKitCardApi = {
  create?: (input: unknown) => Promise<unknown>
  update?: (input: unknown) => Promise<unknown>
  settings?: (input: unknown) => Promise<unknown>
}

type FeishuNodeCardKitElementApi = {
  content?: (input: unknown) => Promise<unknown>
}

export function createFeishuNodeReplyClient(options: FeishuNodeReplyClientOptions): FeishuIMReplyClient {
  const receiveIdType = options.receiveIdType ?? 'chat_id'
  const messageApi = options.client.im?.message
  const cardApi = options.client.cardkit?.v1?.card
  const cardElementApi = options.client.cardkit?.v1?.cardElement
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
      const method = messageApi.patch ?? messageApi.update!
      return normalizeSentMessage(await method({
        path: {
          message_id: input.messageId,
        },
        data: {
          content: JSON.stringify(input.card),
        },
      }))
    },
    async createCardEntity(input) {
      if (!cardApi?.create) throw new Error('Feishu CardKit create API is unavailable')
      const response = await cardApi.create({
        data: {
          type: 'card_json',
          data: JSON.stringify(input.card),
        },
      })
      assertFeishuOk(response, 'cardkit.card.create')
      const cardId = stringValue(asRecord(asRecord(response)?.data)?.card_id)
        ?? stringValue(asRecord(response)?.card_id)
      if (!cardId) throw new Error('Feishu CardKit create response did not include card_id')
      return { cardId, raw: response }
    },
    async sendCardEntity(input) {
      return normalizeSentMessage(await sendMessage(
        messageApi,
        input,
        'interactive',
        { type: 'card', data: { card_id: input.cardId } },
        receiveIdType,
      ))
    },
    async streamCardContent(input) {
      if (!cardElementApi?.content) throw new Error('Feishu CardKit content API is unavailable')
      const response = await cardElementApi.content({
        path: {
          card_id: input.cardId,
          element_id: input.elementId,
        },
        data: {
          content: input.content,
          sequence: input.sequence,
        },
      })
      assertFeishuOk(response, 'cardkit.cardElement.content')
    },
    async updateCardEntity(input) {
      if (!cardApi?.update) throw new Error('Feishu CardKit update API is unavailable')
      const response = await cardApi.update({
        path: {
          card_id: input.cardId,
        },
        data: {
          card: {
            type: 'card_json',
            data: JSON.stringify(input.card),
          },
          sequence: input.sequence,
        },
      })
      assertFeishuOk(response, 'cardkit.card.update')
    },
    async setCardStreamingMode(input) {
      if (!cardApi?.settings) throw new Error('Feishu CardKit settings API is unavailable')
      const response = await cardApi.settings({
        path: {
          card_id: input.cardId,
        },
        data: {
          settings: JSON.stringify({
            config: {
              streaming_mode: input.streaming,
            },
          }),
          sequence: input.sequence,
        },
      })
      assertFeishuOk(response, 'cardkit.card.settings')
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
        reply_in_thread: input.replyTarget === 'thread',
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

function assertFeishuOk(input: unknown, api: string): void {
  const record = asRecord(input)
  const code = typeof record?.code === 'number' ? record.code : 0
  if (code && code !== 0) {
    const message = stringValue(record?.msg) ?? `${api} failed with code ${code}`
    throw new Error(message)
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
