export {
  buildFeishuPageContextPayload,
  buildFeishuPageContextPayload as buildPageContextPayload,
  feishuTemplateIdsForPage,
  isFeishuPagePayload,
  parseFeishuUrl,
} from './browser'
export {
  createFeishuPlatformAdapter,
  feishuPlatformContribution,
  feishuPlatformDescriptor,
  normalizeFeishuPagePayload,
} from './runtime'
export type { FeishuPlatformAdapter } from './runtime'
export type * from './types'
