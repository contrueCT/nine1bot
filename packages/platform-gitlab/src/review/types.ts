export type GitLabReviewObjectType = 'mr' | 'commit'

export type GitLabReviewTriggerMode = 'mention' | 'webhook'

export type GitLabReviewTrigger = {
  host: string
  projectId: string | number
  projectPath?: string
  objectType: GitLabReviewObjectType
  objectIid?: string | number
  commitSha?: string
  headSha?: string
  noteId?: string | number
  eventName?: string
  mode: GitLabReviewTriggerMode
  userInstruction?: string
  instructionRisk?: 'normal' | 'prompt-injection-suspected'
  focusTags?: string[]
  instructionSource?: {
    noteId?: string | number
    author?: string
    rawBody?: string
  }
}

export type GitLabDiffRefs = {
  baseSha?: string
  startSha?: string
  headSha?: string
}

export type GitLabRawChange = {
  old_path: string
  new_path: string
  diff?: string
  new_file?: boolean
  renamed_file?: boolean
  deleted_file?: boolean
  generated_file?: boolean
  collapsed?: boolean
  too_large?: boolean
  overflow?: boolean
}

export type GitLabRawChangesResponse = {
  changes?: GitLabRawChange[]
  overflow?: boolean
  diff_refs?: {
    base_sha?: string
    start_sha?: string
    head_sha?: string
  }
}

export type GitLabChangedFile = {
  oldPath: string
  newPath: string
  diff: string
  added: boolean
  renamed: boolean
  deleted: boolean
  generated: boolean
}

export type GitLabDiffManifest = {
  files: GitLabChangedFile[]
  skipped: GitLabSkippedFile[]
  blocked: boolean
  blockReason?: string
  diffRefs?: GitLabDiffRefs
  stats: {
    fileCount: number
    includedFileCount: number
    skippedFileCount: number
    includedBytes: number
    truncated: boolean
  }
}

export type GitLabSkippedFile = {
  path: string
  reason: 'blacklisted' | 'empty-diff' | 'too-large' | 'generated' | 'budget-exceeded' | 'profile-excluded'
}

export type ReviewSeverity = 'info' | 'minor' | 'major' | 'critical' | 'blocker'

export type ReviewFinding = {
  id?: string
  title: string
  body: string
  severity: ReviewSeverity
  category?: string
  file?: string
  oldLine?: number
  newLine?: number
  suggestion?: ReviewSuggestion
  source?: string
}

export type ReviewSuggestion = {
  replacement: string
  confidence?: 'low' | 'medium' | 'high'
}

export type AggregatedReviewFinding = ReviewFinding & {
  sources: string[]
  duplicates: ReviewFinding[]
}

export type GitLabInlinePosition = {
  position_type: 'text'
  base_sha?: string
  start_sha?: string
  head_sha?: string
  old_path: string
  new_path: string
  old_line?: number
  new_line?: number
}

export type GitLabInlineValidation =
  | {
      ok: true
      position: GitLabInlinePosition
    }
  | {
      ok: false
      reason: string
      fallbackMarkdown: string
    }

export type SubagentFailureMode = 'abort-run' | 'ignore' | 'fallback'

export type SubagentTaskSpec = {
  id: string
  kind: 'custom-subagent'
  role: string
  prompt?: string
  promptRef?: string
  skills?: string[]
  contextRefs?: string[]
  allowedTools?: string[]
  timeoutMs: number
  failureMode: SubagentFailureMode
  outputSchema?: Record<string, unknown>
}
