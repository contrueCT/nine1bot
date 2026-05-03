import {
  enrichFeishuPageContext,
  type FeishuContextEnrichmentSummary,
  type FeishuCliRunner,
} from '@nine1bot/platform-feishu/node'
import { getBuiltinPlatformManager } from './builtin'
import type { RuntimeControllerProtocol } from '../../../../opencode/packages/opencode/src/runtime/controller/protocol'
import type { PlatformPagePayload } from '@nine1bot/platform-protocol'

export type FeishuControllerMessageContextResult = {
  body: RuntimeControllerProtocol.MessageSendRequest
  contextEnrichment?: FeishuContextEnrichmentSummary
}

export type FeishuControllerMessageContextOptions = {
  env?: Record<string, string | undefined>
  runner?: FeishuCliRunner
}

export async function prepareFeishuControllerMessageContext(
  body: RuntimeControllerProtocol.MessageSendRequest,
  options: FeishuControllerMessageContextOptions = {},
): Promise<FeishuControllerMessageContextResult> {
  if (!shouldEnhance(body.entry)) return { body }
  const page = body.context?.page as PlatformPagePayload | undefined
  if (!page || !isFeishuPage(page)) return { body }

  const manager = getBuiltinPlatformManager()
  const record = manager.get('feishu')
  if (!record?.enabled) return { body }

  const result = await enrichFeishuPageContext({
    page,
    settings: record.settings,
    env: options.env ?? process.env,
    runner: options.runner,
  })

  return {
    body: {
      ...body,
      context: {
        ...(body.context ?? {}),
        page: result.page,
        blocks: [
          ...((body.context?.blocks ?? []) as unknown[]),
          ...result.blocks,
        ],
      },
    },
    contextEnrichment: result.summary && result.summary.status !== 'not_applicable'
      ? result.summary
      : undefined,
  }
}

function shouldEnhance(entry?: RuntimeControllerProtocol.Entry) {
  return entry?.source === 'browser-extension' || entry?.mode === 'browser-sidepanel'
}

function isFeishuPage(page: PlatformPagePayload) {
  return page.platform === 'feishu' || Boolean(page.url && isFeishuUrl(page.url))
}

function isFeishuUrl(input: string) {
  try {
    const hostname = new URL(input).hostname.toLowerCase()
    return hostname === 'feishu.cn'
      || hostname.endsWith('.feishu.cn')
      || hostname === 'larksuite.com'
      || hostname.endsWith('.larksuite.com')
  } catch {
    return false
  }
}
