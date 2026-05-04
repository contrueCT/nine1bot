import type { FeishuIMIncomingMessage } from './types'

export const FEISHU_IM_ABORT_TEXTS = [
  '停止',
  '取消',
  '中止',
  'abort',
  'cancel',
  'stop',
  '/abort',
  '/cancel',
  '/stop',
] as const

const ABORT_TEXTS = new Set<string>(FEISHU_IM_ABORT_TEXTS)

export function isFeishuIMAbortMessage(message: FeishuIMIncomingMessage): boolean {
  return isFeishuIMAbortText(message.text)
}

export function isFeishuIMAbortText(input: string | undefined): boolean {
  const normalized = normalizeAbortText(input)
  return Boolean(normalized && ABORT_TEXTS.has(normalized))
}

export function normalizeAbortText(input: string | undefined): string | undefined {
  if (!input) return undefined
  let text = input.trim()
  while (/^@\S+\s+/.test(text)) {
    text = text.replace(/^@\S+\s+/, '').trim()
  }
  text = text.replace(/\s+/g, ' ').toLowerCase()
  return text || undefined
}
