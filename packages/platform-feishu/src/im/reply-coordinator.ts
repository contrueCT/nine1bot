import { renderControlText, renderFeishuControlCard, renderFeishuInteractionAnsweredCard } from './cards'
import type { FeishuControllerBridge } from './controller-bridge'
import type { FeishuIMGatewayCardActionEvent } from './gateway-interface'
import { answerFeishuCardInteraction, routeFromFeishuCardAction } from './interactions'
import { FeishuReplySink } from './reply-sink'
import type { FeishuIMReplyClient } from './reply-client'
import type {
  FeishuIMAccount,
  FeishuIMControlResult,
  FeishuIMHandleMessageResult,
  FeishuIMNormalizedConfig,
} from './types'
import type {
  FeishuIMImmediateReplyInput,
  FeishuIMReplySinkFactoryInput,
  FeishuIMReplySinkHandle,
  FeishuIMSessionManager,
} from './session-manager'

export type FeishuIMReplyCoordinatorOptions = {
  account: FeishuIMAccount
  config: FeishuIMNormalizedConfig
  controller: FeishuControllerBridge
  client: FeishuIMReplyClient
  continueUrlForSession?: (sessionId: string) => string | undefined
}

export function createFeishuIMReplySinkFactory(
  options: FeishuIMReplyCoordinatorOptions,
): (input: FeishuIMReplySinkFactoryInput) => FeishuIMReplySinkHandle {
  return (input) => new FeishuReplySink({
    accountId: options.account.id,
    routeKey: input.routeKey,
    sessionId: input.binding.sessionId,
    directory: input.binding.directory,
    controller: options.controller,
    client: options.client,
    replyMode: options.config.policy.replyMode,
    presentation: options.config.policy.replyPresentation,
    timeoutMs: options.config.policy.replyTimeoutMs,
    streamingCardUpdateMs: options.config.policy.streamingCardUpdateMs,
    streamingCardMaxChars: options.config.policy.streamingCardMaxChars,
    rootMessageId: input.rootMessageId,
    continueUrl: options.continueUrlForSession?.(input.binding.sessionId),
  })
}

export function createFeishuIMImmediateReplyHandler(
  options: Pick<FeishuIMReplyCoordinatorOptions, 'account' | 'config' | 'client' | 'continueUrlForSession'>,
): (input: FeishuIMImmediateReplyInput) => Promise<void> {
  return async (input) => {
    const routeKey = input.routeKey
    if (!routeKey) return
    const delivery = {
      chatId: routeKey.chatId,
      replyTarget: options.config.policy.replyMode,
    } as const
    if (
      input.result.status === 'busy' ||
      input.result.status === 'failed' ||
      input.result.status === 'aborted' ||
      input.result.status === 'abort-noop' ||
      input.result.status === 'buffer-cancelled'
    ) {
      await options.client.sendText({
        ...delivery,
        text: textForImmediate(input.result),
      })
      return
    }
    if (input.result.status === 'control') {
      const sessionId = sessionIdFromControl(input.result)
      await options.client.sendCard({
        ...delivery,
        card: renderFeishuControlCard({
          accountId: options.account.id,
          routeKey,
          result: input.result.control,
          sessionId,
          continueUrl: sessionId ? options.continueUrlForSession?.(sessionId) : undefined,
        }),
      })
    }
  }
}

export function createFeishuIMCardActionHandler(
  options: Pick<FeishuIMReplyCoordinatorOptions, 'account' | 'controller' | 'continueUrlForSession'> & {
    manager: FeishuIMSessionManager
  },
): (input: FeishuIMGatewayCardActionEvent) => Promise<Record<string, unknown> | undefined> {
  return async (input) => {
    const payload = input.payload
    if (isInteractionAction(payload.action)) {
      const result = await answerFeishuCardInteraction({
        controller: options.controller,
        payload,
        value: input.value,
        expected: {
          accountId: options.account.id,
          maxAgeMs: 24 * 60 * 60 * 1000,
        },
      })
      return renderFeishuInteractionAnsweredCard({
        title: result.status === 'answered' ? '已处理' : '操作失败',
        message: result.status === 'answered'
          ? '操作已提交。'
          : `操作未处理：${result.reason}`,
      })
    }

    const routeKey = routeFromFeishuCardAction(payload)
    if (!routeKey) {
      return renderFeishuInteractionAnsweredCard({
        title: '操作失败',
        message: '卡片路由已失效，请重新发送 /control 打开控制面。',
      })
    }

    const result = await options.manager.handleCardAction(payload, input.value)
    const sessionId = sessionIdFromControlResult(result) ?? payload.sessionId
    return renderFeishuControlCard({
      accountId: options.account.id,
      routeKey,
      result,
      sessionId,
      continueUrl: sessionId ? options.continueUrlForSession?.(sessionId) : undefined,
    })
  }
}

function textForImmediate(result: FeishuIMHandleMessageResult): string {
  if (result.status === 'busy') return result.message
  if (result.status === 'failed') return result.message
  if (result.status === 'aborted') return result.message
  if (result.status === 'abort-noop') return result.message
  if (result.status === 'buffer-cancelled') return result.message
  if (result.status === 'control') return renderControlText(result.control)
  return ''
}

function sessionIdFromControl(result: Extract<FeishuIMHandleMessageResult, { status: 'control' }>): string | undefined {
  return sessionIdFromControlResult(result.control)
}

function sessionIdFromControlResult(control: FeishuIMControlResult): string | undefined {
  return 'sessionId' in control ? control.sessionId : undefined
}

function isInteractionAction(action: string): boolean {
  return action.startsWith('permission.') || action.startsWith('question.')
}
