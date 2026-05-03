import type {
  PlatformContextBlock as ProtocolPlatformContextBlock,
  PlatformPagePayload,
  PlatformResourceContribution as ProtocolPlatformResourceContribution,
} from '@nine1bot/platform-protocol'

export type KnownFeishuPageType =
  | 'feishu-docx'
  | 'feishu-wiki'
  | 'feishu-sheet'
  | 'feishu-bitable'
  | 'feishu-folder'
  | 'feishu-slides'
  | 'feishu-unknown'

export type FeishuBrand = 'feishu' | 'lark'

export type FeishuRoute =
  | 'docx'
  | 'wiki'
  | 'sheets'
  | 'base'
  | 'drive/folder'
  | 'slides'
  | 'unknown'

export type FeishuObjType =
  | 'docx'
  | 'wiki'
  | 'sheet'
  | 'bitable'
  | 'folder'
  | 'slides'
  | 'unknown'

export type PageContextPayload = PlatformPagePayload

export interface FeishuUrlInfo {
  host: string
  brand: FeishuBrand
  tenant?: string
  pageType: KnownFeishuPageType
  objectKey: string
  route: FeishuRoute
  token?: string
  objType: FeishuObjType
  tableId?: string
  viewId?: string
  query?: Record<string, string>
}

export type PlatformContextBlock = ProtocolPlatformContextBlock

export type PlatformResourceContribution = ProtocolPlatformResourceContribution
