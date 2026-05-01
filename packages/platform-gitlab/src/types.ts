import type {
  PlatformContextBlock as ProtocolPlatformContextBlock,
  PlatformPagePayload,
  PlatformResourceContribution as ProtocolPlatformResourceContribution,
} from '@nine1bot/platform-protocol'

export type KnownGitLabPageType = 'gitlab-repo' | 'gitlab-file' | 'gitlab-mr' | 'gitlab-issue'

export type PageContextPayload = PlatformPagePayload

export interface GitLabUrlInfo {
  host: string
  projectPath: string
  pageType: KnownGitLabPageType
  objectKey: string
  ref?: string
  filePath?: string
  treePath?: string
  iid?: string
  route: 'repo' | 'blob' | 'tree' | 'merge_request' | 'issue'
}

export type PlatformContextBlock = ProtocolPlatformContextBlock

export type PlatformResourceContribution = ProtocolPlatformResourceContribution
