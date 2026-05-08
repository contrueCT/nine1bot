import {
  createFeishuCardActionPayload,
  type FeishuCardActionContext,
  type FeishuCardActionPayload,
  type FeishuCardActionType,
} from './interactions'
import { serializeFeishuRouteKey, type FeishuIMRouteKey } from './route'
import type { FeishuIMCard } from './reply-client'
import type { FeishuIMControlResult } from './types'

export type FeishuTurnCardStatus = 'running' | 'final' | 'error' | 'timeout'

export const FEISHU_STREAMING_CARD_CONTENT_ELEMENT_ID = 'nine1bot_streaming_content'
export const FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID = 'nine1bot_streaming_tool_status'

export type FeishuStreamingToolStatus = {
  id: string
  name: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  detail?: string
  durationMs?: number
  error?: string
}

export type FeishuTurnCardInput = {
  status: FeishuTurnCardStatus
  title?: string
  content?: string
  routeKey: FeishuIMRouteKey
  sessionId?: string
  turnSnapshotId?: string
  continueUrl?: string
  error?: string
  resourceFailure?: string
}

export type FeishuStreamingTurnCardInput = FeishuTurnCardInput & {
  accountId: string
  maxChars: number
  tools?: FeishuStreamingToolStatus[]
  transport?: 'cardkit' | 'patch' | 'text'
  fallbackReason?: string
}

export type FeishuInteractionCardInput = {
  accountId: string
  routeKey: FeishuIMRouteKey
  sessionId?: string
  turnSnapshotId?: string
  requestId: string
  continueUrl?: string
  data: Record<string, unknown>
}

export function renderFeishuTurnCard(input: FeishuTurnCardInput): FeishuIMCard {
  const statusText = {
    running: '处理中',
    final: '已完成',
    error: '失败',
    timeout: '超时',
  }[input.status]
  return card({
    title: input.title ?? 'Nine1Bot',
    template: input.status === 'final' ? 'green' : input.status === 'running' ? 'blue' : 'red',
    elements: [
      markdown([
        `**状态**：${statusText}`,
        input.content ? `\n${input.content}` : undefined,
        input.error ? `\n**错误**：${input.error}` : undefined,
        input.resourceFailure ? `\n**资源提示**：${input.resourceFailure}` : undefined,
      ].filter(Boolean).join('\n')),
      ...(input.continueUrl ? [actions([linkButton('Web 打开', input.continueUrl)])] : []),
    ],
  })
}

export function renderFeishuStreamingTurnCard(input: FeishuStreamingTurnCardInput): FeishuIMCard {
  const statusText = {
    running: '生成中',
    final: '已完成',
    error: '失败',
    timeout: '超时',
  }[input.status]
  const content = trimStreamingContent(input.content, input.maxChars)
  const context = cardContext(input.accountId, input.routeKey, {
    sessionId: input.sessionId,
    turnSnapshotId: input.turnSnapshotId,
  })
  const actionItems = [
    input.status === 'running' && input.sessionId
      ? actionButton('停止', 'turn.abort', context, { type: 'danger' })
      : undefined,
    input.continueUrl ? linkButton(input.status === 'running' ? 'Web 继续' : 'Web 打开', input.continueUrl) : undefined,
  ].filter(Boolean)
  return card({
    title: input.title ?? 'Nine1Bot 正在回复',
    template: input.status === 'final' ? 'green' : input.status === 'running' ? 'blue' : 'red',
    elements: [
      markdown(`**状态**：${statusText}`),
      markdown(content.text || '正在等待 Agent 输出...'),
      content.truncated
        ? markdown('内容较长，已在飞书卡片中截断。可以在 Web 端查看完整输出。')
        : undefined,
      input.status === 'running' && input.tools?.length ? markdown(renderToolStatusLines(input.tools)) : undefined,
      input.error ? markdown(`**错误**：${input.error}`) : undefined,
      input.resourceFailure ? markdown(`**资源提示**：${input.resourceFailure}`) : undefined,
      actionItems.length > 0 ? actions(actionItems) : undefined,
    ].filter(Boolean),
  })
}

export function renderFeishuStreamingCardKitInitialCard(input: FeishuStreamingTurnCardInput): FeishuIMCard {
  const context = cardContext(input.accountId, input.routeKey, {
    sessionId: input.sessionId,
    turnSnapshotId: input.turnSnapshotId,
  })
  const elements: unknown[] = [
    {
      tag: 'markdown',
      element_id: FEISHU_STREAMING_CARD_CONTENT_ELEMENT_ID,
      content: '正在等待 Agent 输出...',
      text_align: 'left',
      text_size: 'normal_v2',
    },
    {
      tag: 'markdown',
      element_id: FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID,
      content: '',
      text_size: 'notation',
    },
  ]
  if (input.status === 'running' && input.sessionId) {
    elements.push(actionButton2('停止', 'turn.abort', context, { type: 'danger' }))
  }
  if (input.continueUrl) {
    elements.push(linkButton2(input.status === 'running' ? 'Web 继续' : 'Web 打开', input.continueUrl))
  }
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      update_multi: true,
      width_mode: 'fill',
      summary: {
        content: 'Nine1Bot 正在回复',
      },
    },
    header: {
      template: 'blue',
      title: {
        tag: 'plain_text',
        content: input.title ?? 'Nine1Bot 正在回复',
      },
    },
    body: {
      elements,
    },
  }
}

export function renderFeishuStreamingCardKitFinalCard(input: FeishuStreamingTurnCardInput): FeishuIMCard {
  const statusText = {
    running: '生成中',
    final: '已完成',
    error: '失败',
    timeout: '超时',
  }[input.status]
  const content = trimStreamingContent(input.content, input.maxChars)
  const elements: unknown[] = [
    {
      tag: 'markdown',
      element_id: FEISHU_STREAMING_CARD_CONTENT_ELEMENT_ID,
      content: content.text || '已完成。',
      text_align: 'left',
      text_size: 'normal_v2',
    },
    content.truncated
      ? {
          tag: 'markdown',
          content: '内容较长，已在飞书卡片中截断。可以在 Web 端查看完整输出。',
        }
      : undefined,
    {
      tag: 'markdown',
      content: `状态：${statusText}`,
      text_size: 'notation',
    },
    input.error ? { tag: 'markdown', content: `**错误**：${input.error}` } : undefined,
    input.resourceFailure ? { tag: 'markdown', content: `**资源提示**：${input.resourceFailure}` } : undefined,
    input.continueUrl ? linkButton2('Web 打开', input.continueUrl) : undefined,
  ].filter(Boolean)
  return {
    schema: '2.0',
    config: {
      streaming_mode: false,
      update_multi: true,
      width_mode: 'fill',
      summary: {
        content: statusText,
      },
    },
    header: {
      template: input.status === 'final' ? 'green' : input.status === 'running' ? 'blue' : 'red',
      title: {
        tag: 'plain_text',
        content: input.title ?? 'Nine1Bot',
      },
    },
    body: {
      elements,
    },
  }
}

export function renderFeishuControlCard(input: {
  accountId: string
  routeKey: FeishuIMRouteKey
  result: FeishuIMControlResult
  sessionId?: string
  continueUrl?: string
}): FeishuIMCard {
  const context = cardContext(input.accountId, input.routeKey, {
    sessionId: input.sessionId,
  })
  return card({
    title: 'Nine1Bot 控制面',
    template: input.result.type === 'failed' ? 'red' : 'blue',
    elements: [
      markdown(renderControlSummary(input.result, input.routeKey)),
      actions([
        actionButton('新对话', 'control.newSession', context),
        actionButton('项目列表', 'control.projectList', context),
        actionButton('查看目录', 'control.showCwd', context),
        ...(input.continueUrl ? [linkButton('Web 打开', input.continueUrl)] : []),
        actionButton('帮助', 'control.help', context),
      ]),
    ],
  })
}

export function renderFeishuPermissionCard(input: FeishuInteractionCardInput): FeishuIMCard {
  const context = cardContext(input.accountId, input.routeKey, {
    sessionId: input.sessionId,
    turnSnapshotId: input.turnSnapshotId,
    requestId: input.requestId,
  })
  const permission = stringValue(input.data.permission) ?? 'unknown'
  const patterns = arrayString(input.data.patterns)
  return card({
    title: '需要权限确认',
    template: 'yellow',
    elements: [
      markdown([
        `**权限**：${permission}`,
        patterns.length ? `**范围**：${patterns.join(', ')}` : undefined,
      ].filter(Boolean).join('\n')),
      actions([
        actionButton('允许一次', 'permission.allowOnce', context),
        actionButton('允许本对话', 'permission.allowSession', context),
        actionButton('拒绝', 'permission.deny', context, { type: 'danger' }),
        ...(input.continueUrl ? [linkButton('Web 继续', input.continueUrl)] : []),
      ]),
    ],
  })
}

export function renderFeishuQuestionCard(input: FeishuInteractionCardInput): FeishuIMCard {
  const context = cardContext(input.accountId, input.routeKey, {
    sessionId: input.sessionId,
    turnSnapshotId: input.turnSnapshotId,
    requestId: input.requestId,
  })
  const questions = Array.isArray(input.data.questions) ? input.data.questions : []
  const first = questions[0] && typeof questions[0] === 'object'
    ? questions[0] as Record<string, unknown>
    : undefined
  const question = stringValue(first?.question) ?? '需要你回答一个问题。'
  const options = Array.isArray(first?.options)
    ? first.options
      .filter((option): option is Record<string, unknown> => Boolean(option && typeof option === 'object'))
      .map((option) => stringValue(option.label))
      .filter((option): option is string => Boolean(option))
    : []
  const simple = questions.length === 1 && options.length > 0 && options.length <= 4 && first?.multiple !== true
  return card({
    title: '需要补充信息',
    template: 'blue',
    elements: [
      markdown(question),
      simple
        ? actions([
            ...options.map((option) => actionButton(option, 'question.answer', context, { value: { answer: option } })),
            actionButton('拒绝', 'question.deny', context, { type: 'danger' }),
            ...(input.continueUrl ? [linkButton('Web 继续', input.continueUrl)] : []),
          ])
        : {
            tag: 'input',
            name: 'answer',
            placeholder: {
              tag: 'plain_text',
              content: '输入回答',
            },
          },
      simple
        ? undefined
        : actions([
            actionButton('提交', 'question.answer', context),
            actionButton('拒绝', 'question.deny', context, { type: 'danger' }),
            ...(input.continueUrl ? [linkButton('Web 继续', input.continueUrl)] : []),
          ]),
    ].filter(Boolean),
  })
}

export function renderFeishuInteractionAnsweredCard(input: {
  title?: string
  message: string
}): FeishuIMCard {
  return card({
    title: input.title ?? '已处理',
    template: 'green',
    elements: [
      markdown(input.message),
    ],
  })
}

export function renderControlText(result: FeishuIMControlResult): string {
  return renderControlSummary(result)
}

function renderControlSummary(result: FeishuIMControlResult, routeKey?: FeishuIMRouteKey): string {
  const route = routeKey ? `\n**Route**：${serializeFeishuRouteKey(routeKey)}` : ''
  switch (result.type) {
    case 'control-panel':
      return [
        '**当前控制面**',
        `**Session**：${result.sessionId}`,
        result.projectName || result.projectId ? `**项目**：${result.projectName ?? result.projectId}` : undefined,
        result.directory ? `**目录**：${result.directory}` : undefined,
        route.trim() ? route.trim() : undefined,
      ].filter(Boolean).join('\n')
    case 'new-session':
      return `已开启新对话。\n**Session**：${result.sessionId}${result.directory ? `\n**目录**：${result.directory}` : ''}`
    case 'cwd-current':
      return `当前目录：${result.directory ?? '未设置'}\nSession：${result.sessionId}`
    case 'cwd-switched':
      return `已切换目录：${result.directory}\nSession：${result.sessionId}`
    case 'project-current':
      return `当前项目：${result.projectName ?? result.projectId ?? '未绑定'}\n目录：${result.directory ?? '未设置'}\nSession：${result.sessionId}`
    case 'project-list':
      return [
        '**可用项目**',
        ...result.projects.map((project, index) =>
          `${index + 1}. ${project.name ?? project.id} (${project.id})${project.directory ? ` · ${project.directory}` : ''}`
        ),
      ].join('\n')
    case 'project-switched':
      return `已切换项目：${result.projectName ?? result.projectId}\n目录：${result.directory}\nSession：${result.sessionId}`
    case 'unknown-command':
      return `未知命令：${result.command}`
    case 'failed':
      return `命令失败：${result.message}`
    case 'help':
      return ['可用命令：', ...result.commands.map((command) => `- ${command}`)].join('\n')
    case 'turn-aborted':
      return result.message
  }
}

function card(input: {
  title: string
  template: 'blue' | 'green' | 'yellow' | 'red'
  elements: unknown[]
}): FeishuIMCard {
  return {
    config: {
      wide_screen_mode: true,
      update_multi: true,
    },
    header: {
      template: input.template,
      title: {
        tag: 'plain_text',
        content: input.title,
      },
    },
    elements: input.elements,
  }
}

function markdown(content: string) {
  return {
    tag: 'markdown',
    content,
  }
}

function actions(actions: unknown[]) {
  return {
    tag: 'action',
    actions,
  }
}

function actionButton(
  text: string,
  action: FeishuCardActionType,
  context: FeishuCardActionContext,
  options: {
    type?: 'default' | 'primary' | 'danger'
    value?: Record<string, unknown>
  } = {},
) {
  const payload = createFeishuCardActionPayload(action, context)
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: text,
    },
    type: options.type ?? 'default',
    value: {
      nine1bot: payload,
      ...options.value,
    },
  }
}

function linkButton(text: string, url: string) {
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: text,
    },
    type: 'default',
    url,
  }
}

function actionButton2(
  text: string,
  action: FeishuCardActionType,
  context: FeishuCardActionContext,
  options: {
    type?: 'default' | 'primary' | 'danger'
  } = {},
) {
  const payload = createFeishuCardActionPayload(action, context)
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: text,
    },
    type: options.type ?? 'default',
    value: {
      nine1bot: payload,
    },
  }
}

function linkButton2(text: string, url: string) {
  return {
    tag: 'button',
    text: {
      tag: 'plain_text',
      content: text,
    },
    type: 'default',
    url,
  }
}

function cardContext(
  accountId: string,
  routeKey: FeishuIMRouteKey,
  extra: Partial<Pick<FeishuCardActionPayload, 'sessionId' | 'turnSnapshotId' | 'requestId'>>,
): FeishuCardActionContext {
  return {
    accountId,
    routeKey,
    sessionId: extra.sessionId,
    turnSnapshotId: extra.turnSnapshotId,
    requestId: extra.requestId,
  }
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function arrayString(input: unknown): string[] {
  return Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
}

function trimStreamingContent(input: string | undefined, maxChars: number): { text: string; truncated: boolean } {
  const text = input?.trim() ?? ''
  if (!text || text.length <= maxChars) return { text, truncated: false }
  return {
    text: `${text.slice(0, maxChars).trimEnd()}\n\n...`,
    truncated: true,
  }
}

function renderToolStatusLines(tools: FeishuStreamingToolStatus[]): string {
  const statusText = {
    pending: '等待',
    running: '运行中',
    completed: '已完成',
    failed: '失败',
  }
  return [
    '**工具状态**',
    ...tools.slice(-5).map((tool) => {
      const duration = tool.durationMs === undefined
        ? ''
        : tool.durationMs < 1000
          ? ` · ${tool.durationMs}ms`
          : ` · ${(tool.durationMs / 1000).toFixed(1)}s`
      const detail = tool.error ?? tool.detail
      return `- ${statusText[tool.status]} ${tool.name}${duration}${detail ? `：${detail}` : ''}`
    }),
  ].join('\n')
}
