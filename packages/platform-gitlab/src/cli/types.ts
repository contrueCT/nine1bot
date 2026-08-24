import type { GitLabDiffManifest, GitLabInlinePosition } from '../review/types'

export type GitLabTarget =
  | {
      kind: 'project'
      host?: string
      projectPath: string
    }
  | {
      kind: 'merge_request'
      host?: string
      projectPath: string
      iid: string
    }
  | {
      kind: 'commit'
      host?: string
      projectPath: string
      sha: string
    }

export type GitLabCliStatus = {
  available: boolean
  version?: string
  authenticated: boolean
  host?: string
  user?: string
  message: string
}

export type GitLabCliRunResult = {
  stdout: string
  stderr: string
  exitCode: number
  command: string
  args: string[]
  cancelled?: boolean
  outputTooLarge?: boolean
}

export type GitLabCliRunner = (args: string[], options?: GitLabCliRunOptions) => Promise<GitLabCliRunResult>

export type GitLabCliRunOptions = {
  cwd?: string
  timeoutMs?: number
  signal?: AbortSignal
  stdin?: string
}

export type GitLabCliToolErrorCode =
  | 'glab_not_installed'
  | 'glab_not_authenticated'
  | 'target_not_found'
  | 'invalid_input'
  | 'command_cancelled'
  | 'command_failed'
  | 'invalid_output'
  | 'output_too_large'

export class GitLabCliToolError extends Error {
  constructor(
    readonly code: GitLabCliToolErrorCode,
    message: string,
    readonly command?: string,
  ) {
    super(message)
    this.name = 'GitLabCliToolError'
  }
}

export type GitLabProjectSnapshot = {
  target: Extract<GitLabTarget, { kind: 'project' }>
  id?: number
  name?: string
  pathWithNamespace: string
  defaultBranch?: string
  webUrl?: string
  description?: string
}

export type GitLabMrSnapshot = {
  target: Extract<GitLabTarget, { kind: 'merge_request' }>
  id?: number
  title: string
  state?: string
  author?: string
  sourceBranch?: string
  targetBranch?: string
  webUrl?: string
  changedFiles?: number
  additions?: number
  deletions?: number
}

export type GitLabBoundedDiff = {
  target: Extract<GitLabTarget, { kind: 'merge_request' | 'commit' }>
  manifest: GitLabDiffManifest
  truncated: boolean
  coverage: string
}

export type RepositoryHealthContextInput = {
  target: Extract<GitLabTarget, { kind: 'project' }>
  ref?: string
  maxFiles?: number
  maxBytes?: number
  paths?: string[]
}

export type GitLabRepositoryHealthContext = {
  target: Extract<GitLabTarget, { kind: 'project' }>
  project?: GitLabProjectSnapshot
  readme?: string
  rootTree: Array<{ path: string; type: 'file' | 'tree' }>
  rootTreeTruncated: boolean
  importantFiles: Array<{
    path: string
    reason: string
    contentPreview: string
  }>
  skipped: Array<{ path: string; reason: string }>
  coverage: string
}

export type PublishReviewNoteInput = {
  target: Extract<GitLabTarget, { kind: 'merge_request' | 'commit' }>
  body: string
  dryRun?: boolean
}

export type GitLabPublishReviewNoteResult = {
  target: Extract<GitLabTarget, { kind: 'merge_request' | 'commit' }>
  dryRun: boolean
  published: boolean
  noteId?: number
  webUrl?: string
  bodyPreview: string
}

export type PublishReviewDiscussionInput = {
  target: Extract<GitLabTarget, { kind: 'merge_request' }>
  body: string
  position: GitLabInlinePosition
  dryRun?: boolean
}

export type GitLabPublishReviewDiscussionResult = {
  target: Extract<GitLabTarget, { kind: 'merge_request' }>
  dryRun: boolean
  published: boolean
  discussionId?: string
  bodyPreview: string
  position: GitLabInlinePosition
}
