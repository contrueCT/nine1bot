import type { Message, MessagePart } from '../api/client'

/** 折叠区里的一项：工具调用、思考，或执行过程中说的话 */
export type ProcessItem =
  | { kind: 'tool'; part: MessagePart }
  | { kind: 'reasoning'; part: MessagePart }
  | { kind: 'narration'; part: MessagePart }

/** 折叠区下面、始终可见的最终回复 */
export type ReplyItem =
  | { kind: 'text'; part: MessagePart }
  | { kind: 'file'; part: MessagePart }

export interface AgentTimeline {
  process: ProcessItem[]
  reply: ReplyItem[]
}

/**
 * 按时间顺序切开一轮回复：最后一个工具（或思考）之前说的话是过程中的旁白，
 * 和工具调用穿插排进折叠区；之后的文字才是最终回复。文件产出始终算回复。
 *
 * 生成中分不清尾巴上那段是旁白还是结论。已经调过工具的话，先把它留在折叠区里：
 * 否则每说一句都要先在回复区出现、等下一个工具来了再挪进折叠区，整段文字会跳一次。
 * 一轮结束时才把结论拿出来，这一下刚好和折叠区收起同时发生。
 */
export function buildAgentTimeline(messages: Message[], options: { streaming?: boolean } = {}): AgentTimeline {
  const ordered: Array<ProcessItem | ReplyItem> = []
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === 'tool') ordered.push({ kind: 'tool', part })
      else if (part.type === 'reasoning') ordered.push({ kind: 'reasoning', part })
      else if (part.type === 'text' && !part.synthetic && part.text) ordered.push({ kind: 'text', part })
      else if (part.type === 'file') ordered.push({ kind: 'file', part })
    }
  }

  let lastProcessIndex = -1
  ordered.forEach((item, index) => {
    if (item.kind === 'tool' || item.kind === 'reasoning') lastProcessIndex = index
  })
  if (options.streaming && ordered.some(item => item.kind === 'tool')) lastProcessIndex = ordered.length

  const timeline: AgentTimeline = { process: [], reply: [] }
  ordered.forEach((item, index) => {
    if (item.kind === 'file') timeline.reply.push(item)
    else if (item.kind === 'text') {
      if (index < lastProcessIndex) timeline.process.push({ kind: 'narration', part: item.part })
      else timeline.reply.push(item)
    } else timeline.process.push(item)
  })
  return timeline
}
