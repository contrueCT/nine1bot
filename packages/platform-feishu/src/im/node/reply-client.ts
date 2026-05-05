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

type FeishuMessageIdentity = Pick<FeishuIMSentMessage, 'messageId' | 'cardId'>

export function createFeishuNodeReplyClient(options: FeishuNodeReplyClientOptions): FeishuIMReplyClient {
  const receiveIdType = options.receiveIdType ?? 'chat_id'
  const messageApi = options.client.im?.message
  const cardApi = options.client.cardkit?.v1?.card
  const cardElementApi = options.client.cardkit?.v1?.cardElement
  return {
    async sendText(input) {
      const response = await sendMessage(messageApi, input, 'text', { text: input.text }, receiveIdType)
      return normalizeSentMessage(response)
    },
    async sendCard(input) {
      const response = await sendMessage(messageApi, input, 'interactive', input.card, receiveIdType)
      return normalizeSentMessage(response)
    },
    async updateCard(input) {
      if (!messageApi?.update && !messageApi?.patch) {
        throw new Error('Feishu message update API is unavailable')
      }
      if (!input.messageId) {
        throw new Error('Feishu message update requires message_id')
      }
      const method = messageApi.patch ?? messageApi.update!
      const response = await method({
        path: {
          message_id: input.messageId,
        },
        data: {
          content: JSON.stringify(input.card),
        },
      })
      assertFeishuOk(response, 'im.message.patch')
      return normalizeSentMessage(response, {
        messageId: input.messageId,
        cardId: input.cardId,
      })
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
      const response = await sendMessage(
        messageApi,
        input,
        'interactive',
        { type: 'card', data: { card_id: input.cardId } },
        receiveIdType,
      )
      return normalizeSentMessage(response, { cardId: input.cardId })
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
    const response = await api.reply({
      path: {
        message_id: input.rootMessageId,
      },
      data: {
        msg_type: msgType,
        content: JSON.stringify(content),
        reply_in_thread: input.replyTarget === 'thread',
      },
    })
    assertFeishuOk(response, 'im.message.reply')
    return response
  }
  const response = await api.create!({
    params: {
      receive_id_type: receiveIdType,
    },
    data,
  })
  assertFeishuOk(response, 'im.message.create')
  return response
}

function normalizeSentMessage(input: unknown, fallback: FeishuMessageIdentity = {}): FeishuIMSentMessage {
  const record = asRecord(input)
  const data = asRecord(record?.data) ?? record
  const messageId = stringValue(data?.message_id)
    ?? stringValue(data?.messageId)
    ?? stringValue(asRecord(data?.message)?.message_id)
  return {
    messageId: messageId ?? fallback.messageId,
    cardId: stringValue(data?.card_id) ?? stringValue(data?.cardId) ?? fallback.cardId,
    raw: input,
  }
}

function assertFeishuOk(input: unknown, api: string): void {
  const record = asRecord(input)
  const code = typeof record?.code === 'number' ? record.code : 0
  if (code && code !== 0) {
    const error = asRecord(record?.error)
    const details = [
      `code=${code}`,
      stringValue(record?.msg) ? `msg=${stringValue(record?.msg)}` : undefined,
      stringValue(record?.log_id) ? `log_id=${stringValue(record?.log_id)}` : undefined,
      stringValue(error?.log_id) ? `log_id=${stringValue(error?.log_id)}` : undefined,
      stringValue(record?.troubleshooter) ? `troubleshooter=${stringValue(record?.troubleshooter)}` : undefined,
      stringValue(error?.troubleshooter) ? `troubleshooter=${stringValue(error?.troubleshooter)}` : undefined,
    ].filter(Boolean).join(', ')
    throw new Error(`${api} failed: ${details}`)
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' ? input as Record<string, unknown> : undefined
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}
