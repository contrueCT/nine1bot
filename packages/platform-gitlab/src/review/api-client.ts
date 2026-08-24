import type { GitLabRawChangesResponse } from './types'
import { encodeGitLabReviewPublicationForm } from './publication-budget'
import { sanitizeGitLabApiErrorDetail } from './sanitizer'
import { truncateUtf8 } from './utf8-budget'

const GITLAB_PAGE_SIZE = 100
const MAX_PAGINATED_PAGES = 5
const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_CI_TEXT_LENGTH = 512
const MAX_CI_URL_LENGTH = 4_096
const MAX_COMMIT_PARENTS = 64
const MAX_REPOSITORY_PATH_LENGTH = 4_096
const MAX_REPOSITORY_OBJECT_ID_LENGTH = 128
const SAFE_HTTP_STATUS_TEXT = new Map<number, string>([
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [403, 'Forbidden'],
  [404, 'Not Found'],
  [405, 'Method Not Allowed'],
  [408, 'Request Timeout'],
  [409, 'Conflict'],
  [413, 'Payload Too Large'],
  [422, 'Unprocessable Content'],
  [429, 'Too Many Requests'],
  [500, 'Internal Server Error'],
  [501, 'Not Implemented'],
  [502, 'Bad Gateway'],
  [503, 'Service Unavailable'],
  [504, 'Gateway Timeout'],
])

export type GitLabRequestOptions = {
  signal?: AbortSignal
  maxItems?: number
  requestGuard?: () => void
  beforeRequest?: () => void
}

export type GitLabApiRedirectErrorCode =
  | 'gitlab_redirect_invalid'
  | 'gitlab_redirect_cross_authority'
  | 'gitlab_redirect_limit_exceeded'
  | 'gitlab_redirect_write_rejected'

export type GitLabApiClientOptions = {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  requestTimeoutMs?: number
  maxJsonResponseBytes?: number
  maxErrorResponseBytes?: number
}

export type GitLabCreateNoteInput = {
  projectId: string | number
  resource: 'merge_requests' | 'repository/commits'
  resourceId: string | number
  body: string
}

export type GitLabCreateDiscussionInput = GitLabCreateNoteInput & {
  position?: Record<string, unknown>
}

export type GitLabPublishedComment = {
  id: string | number
  body: string
}

export type GitLabListNotesInput = {
  projectId: string | number
  resource: 'merge_requests' | 'repository/commits'
  resourceId: string | number
}

export type GitLabListDiscussionsInput = {
  projectId: string | number
  resourceId: string | number
}

export type GitLabTokenSelf = {
  id?: number
  name?: string
  user_id?: number
  scopes?: string[]
  active?: boolean
  revoked?: boolean
  expires_at?: string | null
}

export type GitLabProjectHook = {
  id: number
  url: string
  project_id?: number
  push_events?: boolean
  merge_requests_events?: boolean
  note_events?: boolean
  enable_ssl_verification?: boolean
}

export type GitLabPipelineSummary = {
  id: number
  iid?: number
  project_id?: number
  sha?: string
  status?: string
  source?: string
  ref?: string
  web_url?: string
  created_at?: string
  updated_at?: string
}

export type GitLabMergeRequestMetadata = {
  id?: number
  iid?: number
  project_id?: number
  diff_refs?: {
    base_sha?: string
    start_sha?: string
    head_sha?: string
  }
  head_pipeline?: GitLabPipelineSummary
}

export type GitLabCommitMetadata = {
  id: string
  short_id?: string
  parent_ids: string[]
}

export type GitLabPipelineJob = {
  id: number
  name?: string
  stage?: string
  status?: string
  allow_failure?: boolean
  web_url?: string
  started_at?: string | null
  finished_at?: string | null
  duration?: number | null
}

export type GitLabRepositoryFileRaw = {
  content: Uint8Array
  truncated: boolean
}

export type GitLabRepositoryTreeEntry = {
  id: string
  name: string
  type: 'blob' | 'tree'
  path: string
  mode?: string
}

export type GitLabRepositoryTreeOptions = GitLabRequestOptions & {
  path?: string
  recursive?: boolean
}

export type GitLabProjectSummary = {
  id: number
  path_with_namespace?: string
  web_url?: string
  name?: string
  namespace?: {
    full_path?: string
  }
}

export type GitLabGroupSummary = {
  id: number
  full_path?: string
  web_url?: string
  name?: string
  path?: string
}

export type GitLabProjectHookInput = {
  projectId: string | number
  url: string
  hookId?: string | number
  noteEvents?: boolean
  mergeRequestEvents?: boolean
  pushEvents?: boolean
  enableSslVerification?: boolean
}

export type GitLabGroupHookInput = {
  groupId: string | number
  url: string
  hookId?: string | number
  noteEvents?: boolean
  mergeRequestEvents?: boolean
  pushEvents?: boolean
  enableSslVerification?: boolean
}

export type GitLabHookTestTrigger = 'push_events' | 'merge_requests_events' | 'note_events'

export class GitLabApiError extends Error {
  readonly statusText: string
  readonly sanitizedDetail?: string

  constructor(
    readonly status: number,
    _statusText: string,
    responseBody?: string,
  ) {
    const statusText = SAFE_HTTP_STATUS_TEXT.get(status) ?? 'Unknown Status'
    super(`GitLab API request failed: ${status} ${statusText}`)
    this.name = 'GitLabApiError'
    this.statusText = statusText
    this.sanitizedDetail = sanitizeGitLabApiErrorDetail(responseBody)
  }
}

export class GitLabApiResponseError extends Error {
  constructor() {
    super('gitlab_api_response_invalid_json')
    this.name = 'GitLabApiResponseError'
  }
}

export class GitLabApiTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`GitLab API request timed out after ${timeoutMs}ms`)
    this.name = 'GitLabApiTimeoutError'
  }
}

export class GitLabApiRedirectError extends Error {
  constructor(readonly code: GitLabApiRedirectErrorCode) {
    super(code)
    this.name = 'GitLabApiRedirectError'
  }
}

export class GitLabApiClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly requestTimeoutMs: number
  private readonly maxJsonResponseBytes: number
  private readonly maxErrorResponseBytes: number

  constructor(options: GitLabApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.token = options.token
    this.fetchImpl = options.fetch ?? fetch
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000
    this.maxJsonResponseBytes = options.maxJsonResponseBytes ?? 16_000_000
    this.maxErrorResponseBytes = options.maxErrorResponseBytes ?? 16_000
  }

  async getMergeRequestChanges(projectId: string | number, mrIid: string | number): Promise<GitLabRawChangesResponse> {
    return await this.request<GitLabRawChangesResponse>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/changes`,
    )
  }

  async getCommitDiff(projectId: string | number, commitSha: string | number): Promise<GitLabRawChangesResponse> {
    const changes = await this.request<GitLabRawChangesResponse['changes']>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/commits/${encodeURIComponent(String(commitSha))}/diff`,
    )
    return { changes: changes ?? [] }
  }

  async getMergeRequestPipelines(
    projectId: string | number,
    mrIid: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabPipelineSummary[]> {
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}/pipelines`,
      options,
    )
    return values.flatMap((value) => {
      const projected = projectPipelineSummary(value)
      return projected ? [projected] : []
    })
  }

  async getMergeRequest(
    projectId: string | number,
    mrIid: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabMergeRequestMetadata> {
    const value = await this.request<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/merge_requests/${encodeURIComponent(String(mrIid))}`,
      { signal: options.signal },
    )
    const projected = projectMergeRequestMetadata(value)
    if (!projected) throw new Error('GitLab merge request metadata response is invalid')
    return projected
  }

  async getPipeline(
    projectId: string | number,
    pipelineId: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabPipelineSummary> {
    const value = await this.request<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/pipelines/${encodeURIComponent(String(pipelineId))}`,
      { signal: options.signal },
    )
    const projected = projectPipelineSummary(value)
    if (!projected) throw new Error('GitLab pipeline metadata response is invalid')
    return projected
  }

  async getCommit(
    projectId: string | number,
    sha: string,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabCommitMetadata> {
    const value = await this.request<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/commits/${encodeURIComponent(sha)}`,
      { signal: options.signal },
    )
    const projected = projectCommitMetadata(value)
    if (!projected) throw new Error('GitLab commit metadata response is invalid')
    return projected
  }

  async getPipelineJobs(
    projectId: string | number,
    pipelineId: string | number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabPipelineJob[]> {
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/pipelines/${encodeURIComponent(String(pipelineId))}/jobs`,
      options,
    )
    return values.flatMap((value) => {
      const projected = projectPipelineJob(value)
      return projected ? [projected] : []
    })
  }

  async getJobTrace(
    projectId: string | number,
    jobId: string | number,
    maxBytes?: number,
    options: GitLabRequestOptions = {},
  ): Promise<string> {
    return await this.requestText(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/jobs/${encodeURIComponent(String(jobId))}/trace`,
      { signal: options.signal },
      maxBytes,
    )
  }

  async getRepositoryFileRaw(
    projectId: string | number,
    filePath: string,
    ref: string,
    maxBytes: number,
    options: GitLabRequestOptions = {},
  ): Promise<GitLabRepositoryFileRaw> {
    const params = new URLSearchParams({ ref })
    return await this.requestBytes(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/files/${encodeURIComponent(filePath)}/raw?${params}`,
      { signal: options.signal },
      maxBytes,
      options.requestGuard,
      options.beforeRequest,
    )
  }

  async getRepositoryTree(
    projectId: string | number,
    ref: string,
    options: GitLabRepositoryTreeOptions = {},
  ): Promise<GitLabRepositoryTreeEntry[]> {
    const params = new URLSearchParams({ ref })
    if (options.path) params.set('path', options.path)
    if (options.recursive) params.set('recursive', 'true')
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/repository/tree?${params}`,
      options,
    )
    return values.flatMap((value) => {
      const projected = projectRepositoryTreeEntry(value)
      return projected ? [projected] : []
    })
  }

  async getTokenSelf(): Promise<GitLabTokenSelf> {
    return await this.request<GitLabTokenSelf>('/api/v4/personal_access_tokens/self')
  }

  async searchProjects(query: string, limit = 20): Promise<GitLabProjectSummary[]> {
    const params = new URLSearchParams({
      simple: 'true',
      per_page: String(limit),
    })
    if (query.trim()) params.set('search', query.trim())
    return await this.request<GitLabProjectSummary[]>(`/api/v4/projects?${params}`)
  }

  async searchGroups(query: string, limit = 20): Promise<GitLabGroupSummary[]> {
    const params = new URLSearchParams({
      per_page: String(limit),
    })
    if (query.trim()) params.set('search', query.trim())
    return await this.request<GitLabGroupSummary[]>(`/api/v4/groups?${params}`)
  }

  async listProjectHooks(projectId: string | number): Promise<GitLabProjectHook[]> {
    return await this.request<GitLabProjectHook[]>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/hooks`,
    )
  }

  async createProjectHook(input: GitLabProjectHookInput): Promise<GitLabProjectHook> {
    const body = projectHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/hooks`,
      {
        method: 'POST',
        body,
      },
    )
  }

  async updateProjectHook(input: GitLabProjectHookInput & { hookId: string | number }): Promise<GitLabProjectHook> {
    const body = projectHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/hooks/${encodeURIComponent(String(input.hookId))}`,
      {
        method: 'PUT',
        body,
      },
    )
  }

  async testProjectHook(
    projectId: string | number,
    hookId: string | number,
    trigger: GitLabHookTestTrigger,
  ): Promise<unknown> {
    return await this.request<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(projectId))}/hooks/${encodeURIComponent(String(hookId))}/test/${trigger}`,
      {
        method: 'POST',
      },
    )
  }

  async listGroupHooks(groupId: string | number): Promise<GitLabProjectHook[]> {
    return await this.request<GitLabProjectHook[]>(
      `/api/v4/groups/${encodeURIComponent(String(groupId))}/hooks`,
    )
  }

  async createGroupHook(input: GitLabGroupHookInput): Promise<GitLabProjectHook> {
    const body = groupHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/groups/${encodeURIComponent(String(input.groupId))}/hooks`,
      {
        method: 'POST',
        body,
      },
    )
  }

  async updateGroupHook(input: GitLabGroupHookInput & { hookId: string | number }): Promise<GitLabProjectHook> {
    const body = groupHookBody(input)
    return await this.request<GitLabProjectHook>(
      `/api/v4/groups/${encodeURIComponent(String(input.groupId))}/hooks/${encodeURIComponent(String(input.hookId))}`,
      {
        method: 'PUT',
        body,
      },
    )
  }

  async testGroupHook(
    groupId: string | number,
    hookId: string | number,
    trigger: GitLabHookTestTrigger,
  ): Promise<unknown> {
    return await this.request<unknown>(
      `/api/v4/groups/${encodeURIComponent(String(groupId))}/hooks/${encodeURIComponent(String(hookId))}/test/${trigger}`,
      {
        method: 'POST',
      },
    )
  }

  async createNote(input: GitLabCreateNoteInput): Promise<unknown> {
    const notePath = input.resource === 'repository/commits'
      ? `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/repository/commits/${encodeURIComponent(String(input.resourceId))}/comments`
      : `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${encodeURIComponent(String(input.resourceId))}/notes`
    const body = encodeGitLabReviewPublicationForm({
      type: 'note',
      resource: input.resource,
      body: input.body,
    }).form
    return await this.request(notePath, {
      method: 'POST',
      body,
    })
  }

  async createDiscussion(input: GitLabCreateDiscussionInput): Promise<unknown> {
    const body = encodeGitLabReviewPublicationForm({
      type: 'discussion',
      body: input.body,
      position: input.position,
    }).form
    return await this.request(`/api/v4/projects/${encodeURIComponent(String(input.projectId))}/${input.resource}/${encodeURIComponent(String(input.resourceId))}/discussions`, {
      method: 'POST',
      body,
    })
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.requestPage<T>(path, init)).data
  }

  private async requestPaginated<T>(path: string, options: GitLabRequestOptions = {}): Promise<T[]> {
    const values: T[] = []
    const visitedPages = new Set<string>()
    const itemLimit = options.maxItems === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.maxItems)
        ? Math.max(0, Math.floor(options.maxItems))
        : 0
    if (itemLimit === 0) return values
    const perPage = Number.isFinite(itemLimit) ? Math.min(GITLAB_PAGE_SIZE, itemLimit) : GITLAB_PAGE_SIZE
    const pageLimit = Number.isFinite(itemLimit)
      ? Math.min(MAX_PAGINATED_PAGES, Math.ceil(itemLimit / perPage))
      : MAX_PAGINATED_PAGES
    let page = '1'
    for (let index = 0; index < pageLimit && !visitedPages.has(page); index += 1) {
      visitedPages.add(page)
      const separator = path.includes('?') ? '&' : '?'
      const result = await this.requestPage<T[]>(
        `${path}${separator}per_page=${perPage}&page=${encodeURIComponent(page)}`,
        { signal: options.signal },
        options.requestGuard,
        options.beforeRequest,
      )
      if (!Array.isArray(result.data)) throw new Error('GitLab API paginated response must be an array')
      values.push(...result.data.slice(0, itemLimit - values.length))
      if (values.length >= itemLimit) break
      const nextPage = result.nextPage
      if (!nextPage || !/^\d+$/.test(nextPage)) break
      page = nextPage
    }
    return values
  }

  private async requestPage<T>(
    path: string,
    init: RequestInit = {},
    requestGuard?: () => void,
    beforeRequest?: () => void,
  ): Promise<{ data: T; nextPage?: string }> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      const body = await readBoundedText(response, this.maxJsonResponseBytes)
      if (body.truncated) throw new Error(`GitLab API response exceeded ${this.maxJsonResponseBytes} bytes`)
      const text = body.text
      const data = text.trim() ? parseGitLabJson<T>(text) : undefined as T
      const nextPage = response.headers.get('x-next-page')?.trim() || undefined
      return { data, nextPage }
    }, requestGuard, beforeRequest)
  }

  async listNotes(input: GitLabListNotesInput, options: GitLabRequestOptions = {}): Promise<GitLabPublishedComment[]> {
    const notesPath = input.resource === 'repository/commits'
      ? `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/repository/commits/${encodeURIComponent(String(input.resourceId))}/comments`
      : `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${encodeURIComponent(String(input.resourceId))}/notes`
    const values = await this.requestPaginated<unknown>(notesPath, { ...options, maxItems: 500 })
    return values.flatMap((value) => {
      const projected = projectPublishedComment(value)
      return projected ? [projected] : []
    })
  }

  async listDiscussions(input: GitLabListDiscussionsInput, options: GitLabRequestOptions = {}): Promise<GitLabPublishedComment[]> {
    const values = await this.requestPaginated<unknown>(
      `/api/v4/projects/${encodeURIComponent(String(input.projectId))}/merge_requests/${encodeURIComponent(String(input.resourceId))}/discussions`,
      { ...options, maxItems: 500 },
    )
    return values.flatMap((value) => {
      const discussion = objectRecord(value)
      const notes = Array.isArray(discussion?.notes) ? discussion.notes : []
      return notes.flatMap((note) => {
        const projected = projectPublishedComment(note)
        return projected ? [projected] : []
      })
    }).slice(0, 500)
  }

  private async requestText(path: string, init: RequestInit = {}, maxBytes?: number): Promise<string> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      return (await readBoundedText(response, maxBytes ?? this.maxJsonResponseBytes)).text
    })
  }

  private async withRequest<T>(
    path: string,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    requestGuard?: () => void,
    beforeRequest?: () => void,
  ): Promise<T> {
    const controller = new AbortController()
    const upstreamSignal = init.signal
    const onUpstreamAbort = () => controller.abort(upstreamSignal?.reason)
    if (upstreamSignal?.aborted) onUpstreamAbort()
    else upstreamSignal?.addEventListener('abort', onUpstreamAbort, { once: true })
    const timeoutError = new GitLabApiTimeoutError(this.requestTimeoutMs)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(timeoutError)
        reject(timeoutError)
      }, this.requestTimeoutMs)
    })
    try {
      const operation = (async () => {
        const response = await this.fetchWithSafeRedirects(
          `${this.baseUrl}${path}`,
          init,
          controller.signal,
          requestGuard,
          beforeRequest,
        )
        if (!requestGuard) return await consume(response)
        assertRequestGuard(requestGuard, response)
        try {
          return await consume(response)
        } finally {
          assertRequestGuard(requestGuard, response)
        }
      })()
      return await Promise.race([operation, deadline])
    } finally {
      if (timeout) clearTimeout(timeout)
      upstreamSignal?.removeEventListener('abort', onUpstreamAbort)
    }
  }

  private async requestBytes(
    path: string,
    init: RequestInit,
    maxBytes: number,
    requestGuard?: () => void,
    beforeRequest?: () => void,
  ): Promise<GitLabRepositoryFileRaw> {
    return await this.withRequest(path, init, async (response) => {
      if (!response.ok) {
        const errorBody = await readBoundedText(response, this.maxErrorResponseBytes).catch(() => undefined)
        throw new GitLabApiError(response.status, response.statusText, errorBody?.text)
      }
      return await readBoundedBytes(response, maxBytes)
    }, requestGuard, beforeRequest)
  }

  private async fetchWithSafeRedirects(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    requestGuard?: () => void,
    beforeRequest?: () => void,
  ): Promise<Response> {
    const initialUrl = parseHttpUrl(url)
    if (!initialUrl) throw new GitLabApiRedirectError('gitlab_redirect_invalid')
    const authority = initialUrl.host.toLowerCase()
    let currentUrl = initialUrl
    let currentInit = init
    let redirects = 0

    while (true) {
      const headers = new Headers(currentInit.headers)
      headers.set('PRIVATE-TOKEN', this.token)
      requestGuard?.()
      beforeRequest?.()
      let response: Response | undefined
      try {
        response = await this.fetchImpl(currentUrl, {
          ...currentInit,
          redirect: 'manual',
          signal,
          headers,
        })
      } finally {
        try {
          requestGuard?.()
        } catch (error) {
          response?.body?.cancel().catch(() => undefined)
          throw error
        }
      }
      if (!REDIRECT_STATUSES.has(response.status)) return response

      const method = (currentInit.method ?? 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        await disposeResponse(response, requestGuard)
        throw new GitLabApiRedirectError('gitlab_redirect_write_rejected')
      }

      if (redirects >= MAX_REDIRECTS) {
        await disposeResponse(response, requestGuard)
        throw new GitLabApiRedirectError('gitlab_redirect_limit_exceeded')
      }
      const location = response.headers.get('location')
      const target = location ? parseHttpUrl(location, currentUrl) : undefined
      if (!target || (currentUrl.protocol === 'https:' && target.protocol !== 'https:')) {
        await disposeResponse(response, requestGuard)
        throw new GitLabApiRedirectError('gitlab_redirect_invalid')
      }
      if (target.host.toLowerCase() !== authority) {
        await disposeResponse(response, requestGuard)
        throw new GitLabApiRedirectError('gitlab_redirect_cross_authority')
      }

      await disposeResponse(response, requestGuard)
      redirects += 1
      currentInit = redirectedRequestInit(currentInit, response.status)
      currentUrl = target
    }
  }
}

function parseGitLabJson<T>(text: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new GitLabApiResponseError()
  }
}

async function disposeResponse(response: Response, requestGuard?: () => void) {
  if (!requestGuard) {
    await cancelResponseBody(response)
    return
  }

  let preGuardError: unknown
  let preGuardFailed = false
  try {
    requestGuard()
  } catch (error) {
    preGuardFailed = true
    preGuardError = error
  }
  try {
    await cancelResponseBody(response)
  } finally {
    requestGuard()
  }
  if (preGuardFailed) throw preGuardError
}

async function cancelResponseBody(response: Response) {
  try {
    await response.body?.cancel()
  } catch {
    // Response disposal is best-effort; ownership and redirect errors carry the request outcome.
  }
}

function assertRequestGuard(requestGuard: () => void, response: Response) {
  try {
    requestGuard()
  } catch (error) {
    response.body?.cancel().catch(() => undefined)
    throw error
  }
}

function parseHttpUrl(input: string, base?: URL) {
  try {
    const url = new URL(input, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

function projectPipelineSummary(input: unknown): GitLabPipelineSummary | undefined {
  const record = objectRecord(input)
  const id = finiteNumber(record?.id)
  if (id === undefined) return undefined
  return compactObject({
    id,
    iid: finiteNumber(record?.iid),
    project_id: finiteNumber(record?.project_id),
    sha: boundedString(record?.sha, MAX_CI_TEXT_LENGTH),
    status: boundedString(record?.status, MAX_CI_TEXT_LENGTH),
    source: boundedString(record?.source, MAX_CI_TEXT_LENGTH),
    ref: boundedString(record?.ref, MAX_CI_TEXT_LENGTH),
    web_url: boundedString(record?.web_url, MAX_CI_URL_LENGTH),
    created_at: boundedString(record?.created_at, MAX_CI_TEXT_LENGTH),
    updated_at: boundedString(record?.updated_at, MAX_CI_TEXT_LENGTH),
  }) as GitLabPipelineSummary
}

function projectMergeRequestMetadata(input: unknown): GitLabMergeRequestMetadata | undefined {
  const record = objectRecord(input)
  if (!record) return undefined
  const diffRefs = objectRecord(record.diff_refs)
  const headPipeline = projectPipelineSummary(record.head_pipeline)
  return compactObject({
    id: finiteNumber(record.id),
    iid: finiteNumber(record.iid),
    project_id: finiteNumber(record.project_id),
    diff_refs: diffRefs
      ? compactObject({
          base_sha: boundedString(diffRefs.base_sha, MAX_CI_TEXT_LENGTH),
          start_sha: boundedString(diffRefs.start_sha, MAX_CI_TEXT_LENGTH),
          head_sha: boundedString(diffRefs.head_sha, MAX_CI_TEXT_LENGTH),
        })
      : undefined,
    head_pipeline: headPipeline,
  }) as GitLabMergeRequestMetadata
}

function projectCommitMetadata(input: unknown): GitLabCommitMetadata | undefined {
  const record = objectRecord(input)
  const id = boundedString(record?.id, MAX_CI_TEXT_LENGTH)
  if (!id) return undefined
  const parentIds = Array.isArray(record?.parent_ids)
    ? record.parent_ids
      .slice(0, MAX_COMMIT_PARENTS)
      .flatMap((value) => {
        const parent = boundedString(value, MAX_CI_TEXT_LENGTH)
        return parent ? [parent] : []
      })
    : []
  return compactObject({
    id,
    short_id: boundedString(record?.short_id, MAX_CI_TEXT_LENGTH),
    parent_ids: parentIds,
  }) as GitLabCommitMetadata
}

function projectRepositoryTreeEntry(input: unknown): GitLabRepositoryTreeEntry | undefined {
  const record = objectRecord(input)
  const id = boundedString(record?.id, MAX_REPOSITORY_OBJECT_ID_LENGTH)
  const name = boundedString(record?.name, MAX_REPOSITORY_PATH_LENGTH)
  const path = boundedString(record?.path, MAX_REPOSITORY_PATH_LENGTH)
  const type = record?.type === 'blob' || record?.type === 'tree' ? record.type : undefined
  if (!id || !name || !path || !type) return undefined
  return compactObject({
    id,
    name,
    type,
    path,
    mode: boundedString(record?.mode, 16),
  }) as GitLabRepositoryTreeEntry
}

function projectPipelineJob(input: unknown): GitLabPipelineJob | undefined {
  const record = objectRecord(input)
  const id = finiteNumber(record?.id)
  if (id === undefined) return undefined
  return compactObject({
    id,
    name: boundedString(record?.name, MAX_CI_TEXT_LENGTH),
    stage: boundedString(record?.stage, MAX_CI_TEXT_LENGTH),
    status: boundedString(record?.status, MAX_CI_TEXT_LENGTH),
    allow_failure: typeof record?.allow_failure === 'boolean' ? record.allow_failure : undefined,
    web_url: boundedString(record?.web_url, MAX_CI_URL_LENGTH),
    started_at: nullableBoundedString(record?.started_at, MAX_CI_TEXT_LENGTH),
    finished_at: nullableBoundedString(record?.finished_at, MAX_CI_TEXT_LENGTH),
    duration: nullableFiniteNumber(record?.duration),
  }) as GitLabPipelineJob
}

function projectPublishedComment(input: unknown): GitLabPublishedComment | undefined {
  const record = objectRecord(input)
  const rawId = record?.id
  const id = typeof rawId === 'string' ? rawId : finiteNumber(rawId)
  const body = typeof record?.body === 'string'
    ? record.body
    : typeof record?.note === 'string'
      ? record.note
      : undefined
  return id !== undefined && body !== undefined ? { id, body } : undefined
}

function objectRecord(input: unknown): Record<string, unknown> | undefined {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function finiteNumber(input: unknown) {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined
}

function nullableFiniteNumber(input: unknown) {
  return input === null ? null : finiteNumber(input)
}

function boundedString(input: unknown, maxLength: number) {
  return typeof input === 'string' ? input.slice(0, maxLength) : undefined
}

function nullableBoundedString(input: unknown, maxLength: number) {
  return input === null ? null : boundedString(input, maxLength)
}

function compactObject(input: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function redirectedRequestInit(init: RequestInit, status: number): RequestInit {
  const method = (init.method ?? 'GET').toUpperCase()
  const switchToGet = (status === 303 && method !== 'GET' && method !== 'HEAD')
    || ((status === 301 || status === 302) && method === 'POST')
  if (!switchToGet) return init
  const headers = new Headers(init.headers)
  headers.delete('content-length')
  headers.delete('content-type')
  return {
    ...init,
    method: 'GET',
    body: undefined,
    headers,
  }
}

async function readBoundedText(response: Response, maxBytes?: number) {
  const result = await readBoundedBytes(response, maxBytes)
  return {
    text: truncateUtf8(new TextDecoder().decode(result.content), maxBytes ?? 0),
    truncated: result.truncated,
  }
}

async function readBoundedBytes(response: Response, maxBytes?: number): Promise<GitLabRepositoryFileRaw> {
  if (!maxBytes || maxBytes <= 0) {
    await response.body?.cancel().catch(() => undefined)
    return { content: new Uint8Array(), truncated: Boolean(response.body) }
  }
  if (!response.body) return { content: new Uint8Array(), truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let used = 0
  let completed = false
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        completed = true
        break
      }
      const remaining = maxBytes - used
      if (remaining <= 0) {
        truncated = true
        break
      }
      const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value
      chunks.push(chunk)
      used += chunk.byteLength
      if (value.byteLength > remaining) {
        truncated = true
        break
      }
    }
  } finally {
    if (!completed) {
      truncated = true
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  const bytes = new Uint8Array(used)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { content: bytes, truncated }
}

function projectHookBody(input: GitLabProjectHookInput) {
  const body = new URLSearchParams({
    url: input.url,
    note_events: String(input.noteEvents ?? true),
    merge_requests_events: String(input.mergeRequestEvents ?? true),
    push_events: String(input.pushEvents ?? false),
    enable_ssl_verification: String(input.enableSslVerification ?? true),
  })
  return body
}

function groupHookBody(input: GitLabGroupHookInput) {
  const body = new URLSearchParams({
    url: input.url,
    note_events: String(input.noteEvents ?? true),
    merge_requests_events: String(input.mergeRequestEvents ?? true),
    push_events: String(input.pushEvents ?? false),
    enable_ssl_verification: String(input.enableSslVerification ?? true),
  })
  return body
}
