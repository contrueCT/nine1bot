import { renderControlText, renderFeishuControlCard } from './cards'
import type { FeishuControllerBridge } from './controller-bridge'
import { FeishuReplySink } from './reply-sink'
import type { FeishuIMReplyClient } from './reply-client'
import type {
  FeishuIMAccount,
  FeishuIMHandleMessageResult,
  FeishuIMNormalizedConfig,
} from './types'
import type {
  FeishuIMImmediateReplyInput,
  FeishuIMReplySinkFactoryInput,
  FeishuIMReplySinkHandle,
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
    controller: options.controller,
    client: options.client,
    replyMode: options.config.policy.replyMode,
    presentation: options.config.policy.replyPresentation,
    timeoutMs: options.config.policy.replyTimeoutMs,
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
    if (input.result.status === 'busy' || input.result.status === 'failed') {
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

function textForImmediate(result: FeishuIMHandleMessageResult): string {
  if (result.status === 'busy') return result.message
  if (result.status === 'failed') return result.message
  if (result.status === 'control') return renderControlText(result.control)
  return ''
}

function sessionIdFromControl(result: Extract<FeishuIMHandleMessageResult, { status: 'control' }>): string | undefined {
  const control = result.control
  return 'sessionId' in control ? control.sessionId : undefined
}
