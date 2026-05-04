import type { FeishuIMReplyPresentation } from './types'

export type FeishuIMReplyTarget = 'message' | 'thread'

export type FeishuIMResolvedPresentation = Exclude<FeishuIMReplyPresentation, 'auto'>

export type FeishuIMCard = Record<string, unknown>

export type FeishuIMReplyDelivery = {
  chatId: string
  rootMessageId?: string
  replyTarget: FeishuIMReplyTarget
}

export type FeishuIMSentMessage = {
  messageId?: string
  cardId?: string
  raw?: unknown
}

export type FeishuIMCardEntity = {
  cardId: string
  raw?: unknown
}

export type FeishuIMReplyClient = {
  sendText(input: FeishuIMReplyDelivery & {
    text: string
  }): Promise<FeishuIMSentMessage>
  sendCard(input: FeishuIMReplyDelivery & {
    card: FeishuIMCard
  }): Promise<FeishuIMSentMessage>
  updateCard(input: {
    messageId?: string
    cardId?: string
    card: FeishuIMCard
  }): Promise<FeishuIMSentMessage>
  createCardEntity?(input: {
    card: FeishuIMCard
  }): Promise<FeishuIMCardEntity>
  sendCardEntity?(input: FeishuIMReplyDelivery & {
    cardId: string
  }): Promise<FeishuIMSentMessage>
  streamCardContent?(input: {
    cardId: string
    elementId: string
    content: string
    sequence: number
  }): Promise<void>
  updateCardEntity?(input: {
    cardId: string
    card: FeishuIMCard
    sequence: number
  }): Promise<void>
  setCardStreamingMode?(input: {
    cardId: string
    streaming: boolean
    sequence: number
  }): Promise<void>
}

export type FeishuIMReplyClientTelemetry = {
  sentText: number
  sentCards: number
  updatedCards: number
}

export class MemoryFeishuIMReplyClient implements FeishuIMReplyClient {
  readonly texts: Array<FeishuIMReplyDelivery & { text: string }> = []
  readonly cards: Array<FeishuIMReplyDelivery & { card: FeishuIMCard }> = []
  readonly updates: Array<{ messageId?: string; cardId?: string; card: FeishuIMCard }> = []

  async sendText(input: FeishuIMReplyDelivery & { text: string }): Promise<FeishuIMSentMessage> {
    this.texts.push(clone(input))
    return { messageId: `text_${this.texts.length}` }
  }

  async sendCard(input: FeishuIMReplyDelivery & { card: FeishuIMCard }): Promise<FeishuIMSentMessage> {
    this.cards.push(clone(input))
    return {
      messageId: `card_message_${this.cards.length}`,
      cardId: `card_${this.cards.length}`,
    }
  }

  async updateCard(input: { messageId?: string; cardId?: string; card: FeishuIMCard }): Promise<FeishuIMSentMessage> {
    this.updates.push(clone(input))
    return {
      messageId: input.messageId,
      cardId: input.cardId,
    }
  }

  telemetry(): FeishuIMReplyClientTelemetry {
    return {
      sentText: this.texts.length,
      sentCards: this.cards.length,
      updatedCards: this.updates.length,
    }
  }
}

function clone<T>(input: T): T {
  return JSON.parse(JSON.stringify(input)) as T
}
