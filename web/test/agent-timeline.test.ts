import { describe, expect, it } from 'bun:test'
import type { Message, MessagePart } from '../src/api/client'
import { buildAgentTimeline } from '../src/utils/agent-timeline'

let seq = 0
function part(type: MessagePart['type'], extra: Partial<MessagePart> = {}): MessagePart {
  seq++
  return { id: `p${seq}`, sessionID: 's', messageID: 'm', type, ...extra }
}
const text = (value: string, extra: Partial<MessagePart> = {}) => part('text', { text: value, ...extra })
const tool = (name: string) => part('tool', { tool: name, state: { status: 'completed' } })

function message(...parts: MessagePart[]): Message {
  return { info: { id: `m${seq++}`, sessionID: 's', role: 'assistant', time: { created: 0 } }, parts }
}

const shape = (messages: Message[]) => {
  const { process, reply } = buildAgentTimeline(messages)
  return {
    process: process.map(item => `${item.kind}:${item.part.text ?? item.part.tool}`),
    reply: reply.map(item => `${item.kind}:${item.part.text ?? item.part.id}`),
  }
}

describe('buildAgentTimeline', () => {
  it('interleaves narration with tools and keeps only the tail as the reply', () => {
    const result = shape([
      message(part('step-start'), text('先看目录'), tool('glob'), part('step-finish')),
      message(part('step-start'), text('再读文件'), tool('read'), tool('read'), part('step-finish')),
      message(part('step-start'), text('结论'), part('step-finish')),
    ])
    expect(result.process).toEqual(['narration:先看目录', 'tool:glob', 'narration:再读文件', 'tool:read', 'tool:read'])
    expect(result.reply).toEqual(['text:结论'])
  })

  it('treats the whole answer as the reply when no tool ran', () => {
    const result = shape([message(text('第一段'), text('第二段'))])
    expect(result.process).toEqual([])
    expect(result.reply).toEqual(['text:第一段', 'text:第二段'])
  })

  it('keeps trailing text inside the process while streaming once a tool has run', () => {
    const messages = [message(tool('glob'), text('读一下 README'))]
    const live = buildAgentTimeline(messages, { streaming: true })
    expect(live.process.map(item => item.kind)).toEqual(['tool', 'narration'])
    expect(live.reply).toEqual([])
    // 结束后同一段文字才作为最终回复拿出来
    expect(shape(messages).reply).toEqual(['text:读一下 README'])
  })

  it('streams a plain answer as the reply when no tool has run', () => {
    const live = buildAgentTimeline([message(text('直接回答'))], { streaming: true })
    expect(live.process).toEqual([])
    expect(live.reply.map(item => item.part.text)).toEqual(['直接回答'])
  })

  it('counts reasoning as process and keeps files in the reply', () => {
    const file = part('file', { mime: 'text/plain' })
    const result = buildAgentTimeline([message(text('准备'), part('reasoning', { text: '想一想' }), file, text('完成'))])
    expect(result.process.map(item => item.kind)).toEqual(['narration', 'reasoning'])
    expect(result.reply.map(item => item.kind)).toEqual(['file', 'text'])
  })

  it('skips synthetic and empty text parts', () => {
    const result = shape([message(text('', {}), text('系统注入', { synthetic: true }), tool('grep'), text('结果'))])
    expect(result.process).toEqual(['tool:grep'])
    expect(result.reply).toEqual(['text:结果'])
  })
})
