import { buildPageContextPayload as buildFeishuPageContextPayload } from '@nine1bot/platform-feishu/browser'
import { buildPageContextPayload as buildGitLabPageContextPayload } from '@nine1bot/platform-gitlab/browser'
import type { PlatformPagePayload } from '@nine1bot/platform-protocol'

export function buildBrowserExtensionPageContextPayload(input: {
  url: string
  title: string
  selection?: string
  visibleSummary?: string
  gitlab?: Record<string, unknown>
}): PlatformPagePayload {
  const feishu = buildFeishuPageContextPayload({
    url: input.url,
    title: input.title,
    selection: input.selection,
    visibleSummary: input.visibleSummary,
  })
  if (feishu.platform === 'feishu') return feishu

  return buildGitLabPageContextPayload({
    url: input.url,
    title: input.title,
    selection: input.selection,
    visibleSummary: input.visibleSummary,
    raw: input.gitlab ? { gitlab: input.gitlab } : undefined,
  })
}
