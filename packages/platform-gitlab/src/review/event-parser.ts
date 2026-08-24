import {
  GITLAB_REVIEW_INVALID_CONFIGURATION,
  isGitLabReviewProjectInScope,
  type GitLabReviewSettings,
} from './settings'
import { gitLabAuthorityFromUrl, normalizeGitLabAuthority } from './host'
import type { GitLabReviewTrigger } from './types'

export type GitLabParsedEvent =
  | { ok: true; trigger: GitLabReviewTrigger }
  | { ok: false; reason: string }

export function parseGitLabWebhookEvent(payload: unknown, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.enabled) return { ok: false, reason: 'gitlab-review-disabled' }
  if (settings.configurationErrors.includes('allowed_hosts_invalid')) {
    return { ok: false, reason: GITLAB_REVIEW_INVALID_CONFIGURATION }
  }
  if (!isRecord(payload)) return { ok: false, reason: 'invalid-payload' }

  const objectKind = stringValue(payload.object_kind)
  if (objectKind === 'merge_request') return parseMergeRequestWebhook(payload, settings)
  if (objectKind === 'note') return parseNoteWebhook(payload, settings)
  return { ok: false, reason: `unsupported-event:${objectKind ?? 'unknown'}` }
}

function parseMergeRequestWebhook(payload: Record<string, unknown>, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.webhookAutoReview) return { ok: false, reason: 'webhook-auto-review-disabled' }
  const project = recordValue(payload.project)
  const attrs = recordValue(payload.object_attributes)
  const projectId = idValue(project?.id ?? attrs?.target_project_id)
  const mrIid = idValue(attrs?.iid)
  const host = gitLabAuthorityFromUrl(stringValue(project?.web_url) ?? stringValue(project?.git_http_url) ?? stringValue(project?.homepage))
  const headSha = stringValue(attrs?.last_commit && recordValue(attrs.last_commit)?.id) ?? stringValue(attrs?.last_commit_id) ?? stringValue(attrs?.sha)
  if (!projectId || !mrIid || !host || !headSha) return { ok: false, reason: 'missing-merge-request-identity' }
  if (!isGitLabReviewTargetAllowed(settings, host, projectId, stringValue(project?.path_with_namespace))) {
    return { ok: false, reason: 'project-not-allowed' }
  }

  return {
    ok: true,
    trigger: {
      host,
      projectId,
      projectPath: stringValue(project?.path_with_namespace),
      objectType: 'mr',
      objectIid: mrIid,
      headSha,
      eventName: 'merge_request',
      mode: 'webhook',
    },
  }
}

function parseNoteWebhook(payload: Record<string, unknown>, settings: GitLabReviewSettings): GitLabParsedEvent {
  if (!settings.manualMentionTrigger) return { ok: false, reason: 'manual-trigger-disabled' }
  const project = recordValue(payload.project)
  const note = recordValue(payload.object_attributes)
  const mergeRequest = recordValue(payload.merge_request)
  const commit = recordValue(payload.commit)
  if (!note) return { ok: false, reason: 'missing-note-attributes' }
  const noteText = stringValue(note?.note)
  if (isBotAuthor(noteAuthorName(payload, note), settings.botMention)) return { ok: false, reason: 'mention-from-bot' }
  const mention = noteText ? extractMentionInstruction(noteText, settings.botMention) : undefined
  if (!noteText || !mention) return { ok: false, reason: 'mention-not-found' }
  const intent = classifyMentionIntent(mention.instruction)
  if (intent.kind !== 'review') return { ok: false, reason: `mention-${intent.kind}` }

  const projectId = idValue(project?.id ?? note?.project_id)
  const host = gitLabAuthorityFromUrl(stringValue(project?.web_url) ?? stringValue(project?.git_http_url) ?? stringValue(project?.homepage))
  if (!projectId || !host) return { ok: false, reason: 'missing-project-identity' }
  if (!isGitLabReviewTargetAllowed(settings, host, projectId, stringValue(project?.path_with_namespace))) {
    return { ok: false, reason: 'project-not-allowed' }
  }

  if (mergeRequest) {
    const mrIid = idValue(mergeRequest.iid)
    const headSha = stringValue(recordValue(mergeRequest.last_commit)?.id) ?? stringValue(mergeRequest.last_commit_id) ?? stringValue(mergeRequest.sha)
    if (!mrIid || !headSha) return { ok: false, reason: 'missing-merge-request-note-identity' }
    return {
      ok: true,
      trigger: {
        host,
        projectId,
        projectPath: stringValue(project?.path_with_namespace),
        objectType: 'mr',
        objectIid: mrIid,
        headSha,
        noteId: idValue(note?.id),
        ...instructionFields(intent, note),
        eventName: 'note',
        mode: 'mention',
      },
    }
  }

  const commitSha = stringValue(commit?.id) ?? stringValue(note?.commit_id)
  if (!commitSha) return { ok: false, reason: 'missing-commit-note-identity' }
  return {
    ok: true,
    trigger: {
      host,
      projectId,
      projectPath: stringValue(project?.path_with_namespace),
      objectType: 'commit',
      commitSha,
      noteId: idValue(note?.id),
      ...instructionFields(intent, note),
      eventName: 'note',
      mode: 'mention',
    },
  }
}

type MentionIntent =
  | {
      kind: 'review'
      instruction?: string
      focusTags: string[]
      risk: 'normal' | 'prompt-injection-suspected'
    }
  | {
      kind: 'out-of-scope'
      reason: string
    }
  | {
      kind: 'sensitive-request'
      reason: string
    }

function instructionFields(intent: Extract<MentionIntent, { kind: 'review' }>, note: Record<string, unknown>) {
  if (!intent.instruction && intent.risk === 'normal' && intent.focusTags.length === 0) return {}
  return {
    ...(intent.instruction ? { userInstruction: intent.instruction } : {}),
    instructionRisk: intent.risk,
    focusTags: intent.focusTags,
    instructionSource: {
      noteId: idValue(note.id),
      author: authorName(note),
      rawBody: stringValue(note.note),
    },
  }
}

export function extractMentionInstruction(noteText: string, botMention: string) {
  const mentionIndex = noteText.toLowerCase().indexOf(botMention.toLowerCase())
  if (mentionIndex < 0) return undefined
  const afterMention = noteText.slice(mentionIndex + botMention.length)
  const instruction = normalizeReviewInstruction(afterMention)
  return { instruction }
}

export function classifyMentionIntent(instruction: string | undefined): MentionIntent {
  if (!instruction) return { kind: 'review', focusTags: [], risk: 'normal' }
  const text = instruction.toLowerCase()
  if (isSensitiveExfiltrationRequest(text)) {
    return { kind: 'sensitive-request', reason: 'sensitive-information-requested' }
  }

  const focusTags = reviewFocusTags(text)
  const risk = hasPromptInjectionMarkers(text) ? 'prompt-injection-suspected' : 'normal'
  if (focusTags.length === 0 && !hasGeneralReviewIntent(text)) {
    return { kind: 'out-of-scope', reason: 'not-a-code-review-request' }
  }
  return {
    kind: 'review',
    instruction,
    focusTags,
    risk,
  }
}

function normalizeReviewInstruction(input: string) {
  const cleaned = input
    .replace(/^[\s,，:：;；\-—]+/, '')
    .replace(/^review\b[\s,，:：;；\-—]*/i, '')
    .replace(/^please\b[\s,，:：;；\-—]*/i, '')
    .trim()
  if (!cleaned) return undefined
  return cleaned.length > 1000 ? `${cleaned.slice(0, 1000)}...` : cleaned
}

function isSensitiveExfiltrationRequest(text: string) {
  const sensitiveTerms = [
    'token',
    'secret',
    'api key',
    'apikey',
    'password',
    'passwd',
    'env',
    'environment variable',
    'system prompt',
    'developer message',
    'nine1bot_platform_secrets_path',
    'gitlab_token',
    '密钥',
    '令牌',
    '密码',
    '环境变量',
    '系统提示词',
    '开发者消息',
  ]
  const exfiltrationTerms = [
    'show',
    'print',
    'display',
    'reveal',
    'leak',
    'send',
    'give me',
    'dump',
    '输出',
    '打印',
    '显示',
    '发给我',
    '给我',
    '泄露',
    '暴露',
    '展示',
  ]
  return sensitiveTerms.some((term) => text.includes(term)) &&
    exfiltrationTerms.some((term) => text.includes(term))
}

function reviewFocusTags(text: string) {
  const tagTerms: Array<[string, string[]]> = [
    ['security', ['security', 'vulnerability', '漏洞', '安全', 'xss', 'csrf', 'ssrf']],
    ['auth', ['auth', 'authentication', 'authorization', 'permission', 'rbac', '鉴权', '认证', '权限']],
    ['token-safety', ['token storage', 'token 使用', 'token 安全', 'token 存储', 'secret storage', '密钥存储']],
    ['sql', ['sql', 'injection', '注入']],
    ['performance', ['performance', 'perf', '性能', '并发', '缓存']],
    ['test', ['test', 'tests', '测试', '用例']],
    ['architecture', ['architecture', '架构', '设计']],
    ['frontend', ['frontend', 'ui', 'ux', '前端', '交互', '样式']],
    ['bug', ['bug', 'bugs', 'defect', '错误', '缺陷', '问题']],
    ['review', ['review', 'code review', 'mr', 'merge request', 'commit', 'diff', '审查', '检查', '代码', '变更']],
  ]
  const tags = tagTerms
    .filter(([, terms]) => terms.some((term) => text.includes(term)))
    .map(([tag]) => tag)
  return Array.from(new Set(tags))
}

function hasGeneralReviewIntent(text: string) {
  return [
    'review',
    'check',
    'inspect',
    'scan',
    'look at',
    '看看',
    '看一下',
    '帮我看',
    '审查',
    '检查',
    '代码',
    '变更',
  ].some((term) => text.includes(term))
}

function hasPromptInjectionMarkers(text: string) {
  return [
    'ignore previous instructions',
    'ignore all previous',
    'system prompt',
    'developer message',
    'gitlab_review_result',
    '```',
    '忽略之前',
    '不要遵守',
    '你现在是',
    '直接输出',
    '系统提示词',
  ].some((term) => text.includes(term))
}

function authorName(note: Record<string, unknown>) {
  const author = recordValue(note.author)
  return stringValue(author?.username) ?? stringValue(author?.name)
}

function noteAuthorName(payload: Record<string, unknown>, note?: Record<string, unknown>) {
  if (note) {
    const fromNote = authorName(note)
    if (fromNote) return fromNote
  }
  const user = recordValue(payload.user)
  return stringValue(user?.username) ?? stringValue(user?.name) ?? stringValue(payload.user_username)
}

function isBotAuthor(author: string | undefined, botMention: string) {
  if (!author) return false
  const botName = botMention.replace(/^@/, '').trim().toLowerCase()
  return author.trim().toLowerCase() === botName
}

export function isGitLabReviewTargetAllowed(
  settings: GitLabReviewSettings,
  host: string,
  projectId: string | number,
  projectPath?: string,
) {
  const normalizedHost = normalizeGitLabAuthority(host)
  const hostAllowed = settings.allowedHosts.length === 0 || settings.allowedHosts.some((candidate) =>
    normalizeGitLabAuthority(candidate) === normalizedHost,
  )
  const projectAllowed = isGitLabReviewProjectInScope(settings, {
    id: projectId,
    pathWithNamespace: projectPath,
  })
  return hostAllowed && projectAllowed
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
}

function recordValue(input: unknown) {
  return isRecord(input) ? input : undefined
}

function stringValue(input: unknown) {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function idValue(input: unknown): string | number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) return input
  if (typeof input === 'string' && input.trim()) return input.trim()
  return undefined
}
