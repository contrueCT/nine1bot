import {
  asRecord,
  gitLabTemplateIdsForPage,
  normalizeGitLabPagePayload,
  parseGitLabUrl,
  type GitLabHostPolicy,
} from './shared'
import { randomBytes } from 'node:crypto'
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'
import { createGitLabCliPlatformTools, getGitLabCliStatus, gitLabCliToolIds, type GitLabCliStatus } from './cli'
import {
  GitLabApiClient,
  GitLabApiError,
  sanitizeGitLabSecrets,
  type GitLabReviewSecretRef,
} from './review'
import {
  gitLabReviewProjectIdsForHookSync,
  hasUsableGitLabReviewProjectProfile,
  normalizeGitLabReviewSettings,
} from './review/settings'
import type {
  AnyPlatformToolDefinition,
  PlatformActionResult,
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformDescriptor,
  PlatformResourceContributionInput,
  PlatformRuntimeAdapter,
  PlatformRuntimeStatus,
  PlatformSecretAccess,
  PlatformSecretRef,
  PlatformValidationResult,
} from '@nine1bot/platform-protocol'
import type { PageContextPayload, PlatformContextBlock, PlatformResourceContribution } from './types'

export type GitLabPlatformAdapter = PlatformRuntimeAdapter & {
  id: 'gitlab'
  matchPage: (page: PageContextPayload) => boolean
  normalizePage: (page: PageContextPayload) => PageContextPayload | undefined
  blocksFromPage: (page: PageContextPayload, observedAt: number) => PlatformContextBlock[] | undefined
  inferTemplateIds: (input: { entry?: { platform?: string }; page?: PageContextPayload }) => string[]
  templateContextBlocks: (input: { templateIds: string[]; page?: PageContextPayload }) => PlatformContextBlock[]
  resourceContributions: (input: PlatformResourceContributionInput) => PlatformResourceContribution | undefined
}

export const gitlabPlatformDescriptor = {
  id: 'gitlab',
  name: 'GitLab',
  packageName: '@nine1bot/platform-gitlab',
  version: '0.1.0',
  defaultEnabled: true,
  capabilities: {
    pageContext: true,
    templates: ['browser-gitlab', 'gitlab-repo', 'gitlab-file', 'gitlab-mr', 'gitlab-commit', 'gitlab-issue'],
    resources: true,
    browserExtension: true,
    auth: 'token',
    settingsPage: true,
    statusPage: true,
  },
  config: {
    sections: [
      {
        id: 'hosts',
        title: 'Access scope',
        fields: [
          {
            key: 'allowedHosts',
            type: 'string-list',
            label: 'Allowed GitLab hosts',
            description: 'GitLab hosts allowed to contribute page context and receive CLI wrapper access.',
          },
          {
            key: 'apiEnrichment',
            type: 'select',
            label: 'API enrichment',
            description: 'Optionally enrich browser page context with GitLab API data.',
            options: ['auto', 'disabled'],
          },
        ],
      },
      {
        id: 'codeReview',
        title: 'Code review',
        description: 'Optional GitLab MR and commit code review automation. Disabled until explicitly enabled.',
        fields: [
          {
            key: 'review.baseUrl',
            type: 'string',
            label: 'GitLab base URL',
            description: 'Base URL for the GitLab instance, for example https://gitlab.com.',
          },
          {
            key: 'review.enabled',
            type: 'boolean',
            label: 'Enable GitLab code review',
            description: 'Allow @Nine1bot comments or configured webhooks to start GitLab review runs.',
          },
          {
            key: 'review.botMention',
            type: 'string',
            label: 'Bot mention',
            description: 'Mention text that triggers manual review from GitLab comments.',
          },
          {
            key: 'review.webhookAutoReview',
            type: 'boolean',
            label: 'Webhook auto review',
            description: 'Automatically review configured merge request webhook events.',
          },
          {
            key: 'review.modelProviderId',
            type: 'string',
            label: 'Review model provider',
            description: 'Provider selected from the configured chat model providers for GitLab review runtime runs.',
          },
          {
            key: 'review.modelId',
            type: 'string',
            label: 'Review model',
            description: 'Model selected from the configured chat models for GitLab review runtime runs.',
          },
          {
            key: 'review.inlineComments',
            type: 'boolean',
            label: 'Inline comments',
            description: 'Attempt GitLab inline discussions for validated changed lines.',
          },
          {
            key: 'review.dryRun',
            type: 'boolean',
            label: 'Dry run',
            description: 'Build review context without writing comments back to GitLab.',
          },
          {
            key: 'review.scopeMode',
            type: 'select',
            label: 'Review scope mode',
            description: 'Use all projects received by the hook, or only selected projects.',
            options: ['all-received', 'selected-only'],
          },
          {
            key: 'review.includedProjects',
            type: 'json',
            label: 'Included projects',
            description: 'Selected GitLab projects for selected-only mode or project hook sync.',
          },
          {
            key: 'review.excludedProjects',
            type: 'json',
            label: 'Excluded projects',
            description: 'GitLab projects that should never trigger review.',
          },
          {
            key: 'review.hookGroups',
            type: 'json',
            label: 'Hook groups',
            description: 'GitLab groups whose group hooks should be managed by Nine1Bot.',
          },
          {
            key: 'review.projects',
            type: 'json',
            label: 'Project review profiles',
            description: 'Per-project review context, focus, limits, and CI evidence policy.',
          },
          {
            key: 'review.webhookSecretRef',
            type: 'password',
            label: 'Webhook secret',
            description: 'Secret embedded in the dedicated GitLab webhook URL, or used to validate X-Gitlab-Token when calling /webhooks/gitlab.',
            secret: true,
          },
          {
            key: 'review.tokenSecretRef',
            type: 'password',
            label: 'GitLab API token',
            description: 'GitLab account token used to read diffs and write review comments.',
            secret: true,
          },
        ],
      },
    ],
  },
  detailPage: {
    sections: [
      { id: 'status', type: 'status-cards', title: 'Status' },
      { id: 'settings', type: 'settings-form', title: 'Settings' },
      { id: 'actions', type: 'action-list', title: 'Actions' },
      { id: 'recent-events', type: 'event-list', title: 'Recent events' },
    ],
  },
  actions: [
    {
      id: 'connection.test',
      label: 'Test connection',
      kind: 'button',
    },
    {
      id: 'webhook.sync-current-url',
      label: 'Sync GitLab webhook URL',
      description: 'Create or update project hooks for the allowed project ids so they point at the current dedicated Nine1Bot URL.',
      kind: 'button',
    },
    {
      id: 'webhook.test',
      label: 'Test GitLab webhook',
      description: 'Ask GitLab to send a Note event test request through the configured project hooks.',
      kind: 'button',
    },
    {
      id: 'group-hooks.sync-current-url',
      label: 'Sync GitLab group hooks',
      description: 'Create or update selected group hooks so they point at the current dedicated Nine1Bot URL.',
      kind: 'button',
    },
    {
      id: 'group-hooks.test',
      label: 'Test GitLab group hooks',
      description: 'Ask GitLab to send a Note event test request through the selected group hooks.',
      kind: 'button',
    },
    {
      id: 'projects.search',
      label: 'Search GitLab projects',
      description: 'Search GitLab projects by name or namespace for review scope configuration.',
      kind: 'form',
      inputSchema: {
        sections: [
          {
            id: 'query',
            title: 'Project search',
            fields: [
              {
                key: 'query',
                type: 'string',
                label: 'Search query',
                description: 'Project name or namespace.',
              },
            ],
          },
        ],
      },
    },
    {
      id: 'groups.search',
      label: 'Search GitLab groups',
      description: 'Search GitLab groups by name or namespace for group hook management.',
      kind: 'form',
      inputSchema: {
        sections: [
          {
            id: 'query',
            title: 'Group search',
            fields: [
              {
                key: 'query',
                type: 'string',
                label: 'Search query',
                description: 'Group name or namespace.',
              },
            ],
          },
        ],
      },
    },
  ],
} satisfies PlatformDescriptor

export const gitlabPlatformContribution = {
  descriptor: gitlabPlatformDescriptor,
  runtime: {
    createAdapter: (ctx) => createGitLabPlatformAdapter(ctx.settings),
    sources: (ctx) => ({
      agents: [
        {
          id: 'gitlab-review-agents',
          directory: ctx.packageResources.resolve('agents'),
          namespace: 'platform.gitlab',
          visibility: 'recommendable',
          lifecycle: 'platform-enabled',
        },
      ],
      skills: [
        {
          id: 'gitlab-review-skills',
          directory: ctx.packageResources.resolve('skills'),
          namespace: 'platform.gitlab',
          visibility: 'declared-only',
          lifecycle: 'platform-enabled',
        },
      ],
    }),
    tools: (ctx: PlatformAdapterContext) => {
      const hostPolicy = effectiveGitLabHostPolicy(ctx.settings)
      return applyGitLabHostPolicyToCliTargetResolution(createGitLabCliPlatformTools({
        allowedHosts: [...hostPolicy.allowedHosts],
        allowedHostsInvalid: hostPolicy.allowedHostsInvalid,
      }), hostPolicy)
    },
  },
  getStatus: getGitLabPlatformStatus,
  validateConfig: validateGitLabPlatformConfig,
  handleAction: handleGitLabPlatformAction,
} satisfies PlatformAdapterContribution

export function createGitLabPlatformAdapter(settingsInput?: unknown): GitLabPlatformAdapter {
  const hostPolicy = effectiveGitLabHostPolicy(settingsInput)
  return {
    id: 'gitlab',
    matchPage: (page) => Boolean(normalizeGitLabPagePayload(page, hostPolicy)),
    normalizePage: (page) => normalizeGitLabPagePayload(page, hostPolicy),
    blocksFromPage: (page, observedAt) => buildGitLabContextBlocks(page, observedAt, hostPolicy),
    inferTemplateIds(input) {
      if (input.entry?.platform !== 'gitlab' && !input.page) return []
      if (input.page) return gitLabTemplateIdsForPage(input.page, hostPolicy)
      return ['browser-gitlab']
    },
    templateContextBlocks(input) {
      return buildGitLabTemplateContextBlocks(input.templateIds, input.page, hostPolicy)
    },
    resourceContributions(input) {
      if (!input.templateIds.some((templateId) => templateId === 'browser-gitlab' || templateId.startsWith('gitlab-'))) {
        return undefined
      }
      if (input.agentName !== 'platform.gitlab.assistant') {
        return emptyResources(['gitlab-context'])
      }
      return gitLabResourcesForTemplates(input.templateIds)
    },
    recommendedAgent(input) {
      if (input.fallback === 'platform.gitlab.pm-coordinator') return input.fallback
      return input.templateIds.some((templateId) => templateId === 'browser-gitlab' || templateId.startsWith('gitlab-'))
        ? 'platform.gitlab.assistant'
        : input.fallback
    },
  }
}

export { gitLabTemplateIdsForPage, normalizeGitLabPagePayload, parseGitLabUrl }

async function getGitLabPlatformStatus(ctx: PlatformAdapterContext): Promise<PlatformRuntimeStatus> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const cliStatus = await cachedGitLabCliStatus()
  const cards: PlatformRuntimeStatus['cards'] = [
    { id: 'context', label: 'Page context', value: 'enabled', tone: 'success' },
    {
      id: 'cli',
      label: 'GitLab CLI',
      value: cliStatus.available
        ? cliStatus.authenticated
          ? `authenticated${cliStatus.host ? `: ${cliStatus.host}` : ''}`
          : 'not authenticated'
        : 'missing',
      tone: cliStatus.available && cliStatus.authenticated ? 'success' : cliStatus.available ? 'warning' : 'neutral',
    },
    { id: 'review', label: 'Code review', value: settings.enabled ? 'enabled' : 'disabled', tone: settings.enabled ? 'success' : 'neutral' },
    { id: 'mode', label: 'Review publish', value: settings.dryRun ? 'dry-run' : 'publish', tone: settings.dryRun ? 'warning' : 'success' },
    { id: 'model', label: 'Review model', value: settings.modelProviderId && settings.modelId ? `${settings.modelProviderId}/${settings.modelId}` : 'default', tone: 'neutral' },
    { id: 'webhook-url', label: 'Dedicated webhook', value: await dedicatedWebhookUrlDisplay(settings, ctx), tone: 'neutral' },
    { id: 'scope', label: 'Review scope', value: scopeStatusText(settings), tone: settings.scopeMode === 'selected-only' && settings.includedProjects.length === 0 ? 'warning' : 'neutral' },
  ]

  if (!settings.enabled) {
    return {
      status: 'available',
      message: 'GitLab page context is available. Code review is disabled until enabled in settings.',
      cards,
    }
  }

  if (!settings.tokenSecretRef) {
    return {
      status: 'auth-required',
      message: 'GitLab code review is enabled but no API token is configured.',
      cards,
    }
  }

  const tokenConfigured = typeof settings.tokenSecretRef === 'string' || await ctx.secrets.has(settings.tokenSecretRef)
  if (!tokenConfigured) {
    return {
      status: 'auth-required',
      message: 'GitLab code review token is missing or unavailable.',
      cards,
    }
  }

  if (!hasUsableGitLabReviewProjectProfile(settings)) {
    return {
      status: 'degraded',
      message: 'GitLab code review is enabled but has no enabled, bound, usable project profile.',
      cards,
    }
  }

  if (settings.configurationErrors.length > 0) {
    return {
      status: 'degraded',
      message: 'GitLab code review configuration contains invalid project profile or host settings.',
      cards,
    }
  }

  return {
    status: settings.dryRun ? 'degraded' : 'available',
    message: settings.dryRun
      ? 'GitLab code review is configured in dry-run mode; no comments will be written.'
      : 'GitLab code review is configured.',
    cards,
  }
}

async function validateGitLabPlatformConfig(
  settingsInput: unknown,
  ctx?: PlatformAdapterContext,
): Promise<PlatformValidationResult> {
  const settings = normalizeGitLabReviewSettings(settingsInput)
  const fieldErrors: Record<string, string> = {}

  if (settings.configurationErrors.includes('allowed_hosts_invalid')) {
    fieldErrors.allowedHosts = 'Allowed GitLab hosts must contain only valid host or host:port values.'
  }

  if (settings.enabled && ctx?.enabled !== false) {
    if (!settings.tokenSecretRef) fieldErrors['review.tokenSecretRef'] = 'GitLab API token is required when code review is enabled.'
    if (settings.baseUrl && !isHttpUrl(settings.baseUrl)) fieldErrors['review.baseUrl'] = 'GitLab base URL must be an http(s) URL.'
    if (!settings.botMention.trim().startsWith('@')) fieldErrors['review.botMention'] = 'Bot mention must start with @.'
    if (settings.modelProviderId && !settings.modelId) fieldErrors['review.modelId'] = 'Review model is required when a review model provider is set.'
    if (!settings.modelProviderId && settings.modelId) fieldErrors['review.modelProviderId'] = 'Review model provider is required when a review model is set.'
    if (!hasUsableGitLabReviewProjectProfile(settings)) {
      fieldErrors['review.projects'] = [
        'At least one GitLab review profile must be enabled, use a valid host,',
        'and bind an existing Nine1Bot project with a unique identity.',
      ].join(' ')
    } else if (settings.configurationErrors.some((error) => (
      error.startsWith('project_profile_max_context_bytes_invalid:')
      || error.startsWith('project_profile_max_files_invalid:')
      || error.startsWith('project_profile_review_context_too_large:')
    ))) {
      const limits: string[] = []
      if (settings.configurationErrors.some((error) => error.startsWith('project_profile_max_context_bytes_invalid:'))) {
        limits.push('maxContextBytes must be a finite positive number.')
      }
      if (settings.configurationErrors.some((error) => error.startsWith('project_profile_max_files_invalid:'))) {
        limits.push('maxFiles must be a finite positive number.')
      }
      if (settings.configurationErrors.some((error) => error.startsWith('project_profile_review_context_too_large:'))) {
        limits.push('reviewContextMarkdown exceeds the stored project context limit.')
      }
      fieldErrors['review.projects'] = limits.join(' ')
    } else if (settings.configurationErrors.some((error) => error.startsWith('project_'))) {
      fieldErrors['review.projects'] = [
        'Every GitLab review profile must use a valid host, bind an existing Nine1Bot project,',
        'and have unique profile and (host, projectId) identities.',
      ].join(' ')
    }
  }

  return Object.keys(fieldErrors).length
    ? { ok: false, message: 'Invalid GitLab code review settings.', fieldErrors }
    : { ok: true }
}

async function handleGitLabPlatformAction(
  actionId: string,
  _input: unknown,
  ctx: PlatformAdapterContext,
): Promise<PlatformActionResult> {
  const status = await getGitLabPlatformStatus(ctx)
  if (actionId === 'connection.test') {
    if (status.status === 'auth-required' || status.status === 'error') {
      return { status: 'failed', message: status.message, updatedStatus: status }
    }
    return await testGitLabConnection(ctx, status)
  }
  if (actionId === 'webhook.sync-current-url') {
    return await syncGitLabProjectHooks(ctx, status)
  }
  if (actionId === 'webhook.test') {
    return await testGitLabProjectHooks(ctx, status)
  }
  if (actionId === 'projects.search') {
    return await searchGitLabProjects(_input, ctx, status)
  }
  if (actionId === 'groups.search') {
    return await searchGitLabGroups(_input, ctx, status)
  }
  if (actionId === 'group-hooks.sync-current-url') {
    return await syncGitLabGroupHooks(ctx, status)
  }
  if (actionId === 'group-hooks.test') {
    return await testGitLabGroupHooks(ctx, status)
  }
  return { status: 'failed', message: `Unsupported GitLab action: ${actionId}` }
}

async function testGitLabConnection(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) {
    return { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status }
  }

  try {
    const client = new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    })
    const self = await client.getTokenSelf()
    const scopes = Array.isArray(self.scopes) ? self.scopes : []
    const active = self.active !== false && self.revoked !== true
    if (!active) {
      return { status: 'failed', message: 'GitLab API token is revoked or inactive.', updatedStatus: status }
    }
    if (!scopes.includes('api')) {
      return {
        status: 'failed',
        message: `GitLab API token is reachable but missing required api scope. Current scopes: ${scopes.join(', ') || 'unknown'}.`,
        updatedStatus: status,
      }
    }
    return {
      status: 'ok',
      message: `GitLab API token is reachable${self.name ? ` (${self.name})` : ''} and includes api scope.`,
      updatedStatus: status,
    }
  } catch (error) {
    if (error instanceof GitLabApiError) {
      return {
        status: 'failed',
        message: `GitLab API token check failed: ${error.status} ${error.statusText}.`,
        updatedStatus: status,
      }
    }
    return {
      status: 'failed',
      message: `GitLab API token check failed: ${gitLabActionErrorText(error)}.`,
      updatedStatus: status,
    }
  }
}

function gitLabActionErrorText(error: unknown) {
  if (error instanceof GitLabApiError) return error.message
  const message = error instanceof Error ? error.message : String(error)
  return sanitizeGitLabSecrets(message, {
    maxInputCodeUnits: 4_096,
    maxInputUtf8Bytes: 4_096,
    maxOutputCodeUnits: 512,
    maxOutputUtf8Bytes: 512,
  }).trim() || 'Unknown GitLab error'
}

async function searchGitLabProjects(
  input: unknown,
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const query = typeof input === 'object' && input && 'query' in input && typeof input.query === 'string'
    ? input.query
    : ''
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) return { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status }
  try {
    const client = new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    })
    const projects = await client.searchProjects(query, 20)
    return {
      status: 'ok',
      message: `Found ${projects.length} GitLab project(s).`,
      data: {
        projects: projects.map((project) => ({
          id: project.id,
          pathWithNamespace: project.path_with_namespace,
          webUrl: project.web_url,
        })),
      },
      updatedStatus: status,
    }
  } catch (error) {
    return {
      status: 'failed',
      message: `GitLab project search failed: ${gitLabActionErrorText(error)}.`,
      updatedStatus: status,
    }
  }
}

async function searchGitLabGroups(
  input: unknown,
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const query = typeof input === 'object' && input && 'query' in input && typeof input.query === 'string'
    ? input.query
    : ''
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) return { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status }
  try {
    const client = new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    })
    const groups = await client.searchGroups(query, 20)
    return {
      status: 'ok',
      message: `Found ${groups.length} GitLab group(s).`,
      data: {
        groups: groups.map((group) => ({
          id: group.id,
          fullPath: group.full_path,
          webUrl: group.web_url,
        })),
      },
      updatedStatus: status,
    }
  } catch (error) {
    return {
      status: 'failed',
      message: `GitLab group search failed: ${gitLabActionErrorText(error)}.`,
      updatedStatus: status,
    }
  }
}

async function syncGitLabProjectHooks(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const prepared = await prepareGitLabWebhookAction(ctx, status)
  if ('error' in prepared) return prepared.error

  const results = []
  for (const projectId of prepared.projectIds) {
    try {
      const hooks = await prepared.client.listProjectHooks(projectId)
      const existing = findNine1BotHook(hooks, prepared.webhookSecret)
      const hookInput = {
        projectId,
        url: prepared.webhookUrl,
        noteEvents: true,
        mergeRequestEvents: true,
        pushEvents: false,
        enableSslVerification: prepared.webhookUrl.startsWith('https://'),
      }
      const hook = existing
        ? await prepared.client.updateProjectHook({ ...hookInput, hookId: existing.id })
        : await prepared.client.createProjectHook(hookInput)
      let testStatus = 'ok'
      let testMessage = 'Note event test accepted.'
      try {
        await prepared.client.testProjectHook(projectId, hook.id, 'note_events')
      } catch (error) {
        testStatus = 'failed'
        testMessage = gitLabActionErrorText(error)
      }
      results.push({
        projectId: String(projectId),
        hookId: hook.id,
        action: existing ? (existing.url === prepared.webhookUrl ? 'refreshed' : 'updated') : 'created',
        previousUrl: existing?.url,
        url: prepared.webhookUrl,
        testStatus,
        testMessage,
      })
    } catch (error) {
      results.push({
        projectId: String(projectId),
        action: 'failed',
        url: prepared.webhookUrl,
        error: gitLabActionErrorText(error),
      })
    }
  }

  const failed = results.filter((result) => result.action === 'failed' || result.testStatus === 'failed')
  return {
    status: failed.length ? 'failed' : 'ok',
    message: failed.length
      ? `Webhook URL sync finished with ${failed.length} failed project(s).`
      : `Webhook URL synced to ${results.length} GitLab project hook(s).`,
    data: {
      webhookUrl: prepared.webhookUrl,
      results,
    },
    updatedStatus: await getGitLabPlatformStatus(ctx),
  }
}

async function syncGitLabGroupHooks(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const prepared = await prepareGitLabGroupHookAction(ctx, status)
  if ('error' in prepared) return prepared.error

  const results = []
  for (const group of prepared.groups) {
    try {
      const hooks = await prepared.client.listGroupHooks(group.id)
      const existing = findNine1BotHook(hooks, prepared.webhookSecret)
      const hookInput = {
        groupId: group.id,
        url: prepared.webhookUrl,
        noteEvents: true,
        mergeRequestEvents: true,
        pushEvents: false,
        enableSslVerification: prepared.webhookUrl.startsWith('https://'),
      }
      const hook = existing
        ? await prepared.client.updateGroupHook({ ...hookInput, hookId: existing.id })
        : await prepared.client.createGroupHook(hookInput)
      let testStatus = 'ok'
      let testMessage = 'Note event test accepted.'
      try {
        await prepared.client.testGroupHook(group.id, hook.id, 'note_events')
      } catch (error) {
        testStatus = 'failed'
        testMessage = gitLabActionErrorText(error)
      }
      results.push({
        groupId: String(group.id),
        groupPath: group.fullPath,
        hookId: hook.id,
        action: existing ? (existing.url === prepared.webhookUrl ? 'refreshed' : 'updated') : 'created',
        previousUrl: existing?.url,
        url: prepared.webhookUrl,
        testStatus,
        testMessage,
      })
    } catch (error) {
      results.push({
        groupId: String(group.id),
        groupPath: group.fullPath,
        action: 'failed',
        url: prepared.webhookUrl,
        error: gitLabActionErrorText(error),
      })
    }
  }

  const failed = results.filter((result) => result.action === 'failed' || result.testStatus === 'failed')
  return {
    status: failed.length ? 'failed' : 'ok',
    message: failed.length
      ? `Group hook URL sync finished with ${failed.length} failed group(s).`
      : `Webhook URL synced to ${results.length} GitLab group hook(s).`,
    data: {
      webhookUrl: prepared.webhookUrl,
      results,
    },
    updatedStatus: await getGitLabPlatformStatus(ctx),
  }
}

async function testGitLabGroupHooks(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const prepared = await prepareGitLabGroupHookAction(ctx, status)
  if ('error' in prepared) return prepared.error

  const results = []
  for (const group of prepared.groups) {
    try {
      const hooks = await prepared.client.listGroupHooks(group.id)
      const hook = findNine1BotHook(hooks, prepared.webhookSecret)
      if (!hook) {
        results.push({
          groupId: String(group.id),
          groupPath: group.fullPath,
          action: 'missing',
          error: 'No Nine1Bot group hook found for this group.',
        })
        continue
      }
      if (hook.url !== prepared.webhookUrl) {
        results.push({
          groupId: String(group.id),
          groupPath: group.fullPath,
          hookId: hook.id,
          action: 'url-mismatch',
          url: hook.url,
          expectedUrl: prepared.webhookUrl,
          error: 'GitLab hook URL differs from the current Nine1Bot webhook URL. Sync hooks before testing.',
        })
        continue
      }
      await prepared.client.testGroupHook(group.id, hook.id, 'note_events')
      results.push({
        groupId: String(group.id),
        groupPath: group.fullPath,
        hookId: hook.id,
        action: 'tested',
        url: hook.url,
        expectedUrl: prepared.webhookUrl,
      })
    } catch (error) {
      results.push({
        groupId: String(group.id),
        groupPath: group.fullPath,
        action: 'failed',
        error: gitLabActionErrorText(error),
      })
    }
  }

  const failed = results.filter((result) => result.action === 'failed' || result.action === 'missing')
  const mismatched = results.filter((result) => result.action === 'url-mismatch')
  return {
    status: failed.length || mismatched.length ? 'failed' : 'ok',
    message: failed.length
      ? `GitLab group hook test failed for ${failed.length} group(s).`
      : mismatched.length
        ? `${mismatched.length} GitLab group hook URL(s) are out of date. Sync hooks before testing.`
        : `GitLab group hook test succeeded for ${results.length} group hook(s).`,
    data: {
      webhookUrl: prepared.webhookUrl,
      results,
    },
    updatedStatus: await getGitLabPlatformStatus(ctx),
  }
}

async function testGitLabProjectHooks(
  ctx: PlatformAdapterContext,
  status: PlatformRuntimeStatus,
): Promise<PlatformActionResult> {
  const prepared = await prepareGitLabWebhookAction(ctx, status)
  if ('error' in prepared) return prepared.error

  const results = []
  for (const projectId of prepared.projectIds) {
    try {
      const hooks = await prepared.client.listProjectHooks(projectId)
      const hook = findNine1BotHook(hooks, prepared.webhookSecret)
      if (!hook) {
        results.push({
          projectId: String(projectId),
          action: 'missing',
          error: 'No Nine1Bot project hook found for this project.',
        })
        continue
      }
      if (hook.url !== prepared.webhookUrl) {
        results.push({
          projectId: String(projectId),
          hookId: hook.id,
          action: 'url-mismatch',
          url: hook.url,
          expectedUrl: prepared.webhookUrl,
          error: 'GitLab hook URL differs from the current Nine1Bot webhook URL. Sync hooks before testing.',
        })
        continue
      }
      await prepared.client.testProjectHook(projectId, hook.id, 'note_events')
      results.push({
        projectId: String(projectId),
        hookId: hook.id,
        action: 'tested',
        url: hook.url,
        expectedUrl: prepared.webhookUrl,
      })
    } catch (error) {
      results.push({
        projectId: String(projectId),
        action: 'failed',
        error: gitLabActionErrorText(error),
      })
    }
  }

  const failed = results.filter((result) => result.action === 'failed' || result.action === 'missing')
  const mismatched = results.filter((result) => result.action === 'url-mismatch')
  return {
    status: failed.length || mismatched.length ? 'failed' : 'ok',
    message: failed.length
      ? `GitLab webhook test failed for ${failed.length} project(s).`
      : mismatched.length
        ? `${mismatched.length} GitLab project hook URL(s) are out of date. Sync hooks before testing.`
        : `GitLab webhook test succeeded for ${results.length} project hook(s).`,
    data: {
      webhookUrl: prepared.webhookUrl,
      results,
    },
    updatedStatus: await getGitLabPlatformStatus(ctx),
  }
}

async function prepareGitLabWebhookAction(ctx: PlatformAdapterContext, status: PlatformRuntimeStatus): Promise<
  | {
      settings: ReturnType<typeof normalizeGitLabReviewSettings>
      client: GitLabApiClient
      projectIds: Array<string | number>
      webhookSecret: string
      webhookUrl: string
    }
  | { error: PlatformActionResult }
> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) {
    return { error: { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status } }
  }
  const webhookSecret = await resolveOrCreateGitLabWebhookSecret(settings.webhookSecretRef, ctx.secrets)
  if (!webhookSecret) {
    return { error: { status: 'failed', message: 'GitLab webhook secret is missing.', updatedStatus: status } }
  }
  const webhookUrl = dedicatedWebhookUrl(ctx, webhookSecret)
  if (!webhookUrl) {
    return {
      error: {
        status: 'failed',
        message: 'NINE1BOT_LOCAL_URL is not configured, so the current dedicated webhook URL cannot be generated.',
        updatedStatus: status,
      },
    }
  }
  const projectIds = gitLabReviewProjectIdsForHookSync(settings)
  if (projectIds.length === 0) {
    return {
      error: {
        status: 'failed',
        message: 'Select at least one included project before Nine1Bot can sync project hooks. Group/System hooks can still use the dedicated URL manually.',
        updatedStatus: status,
      },
    }
  }
  return {
    settings,
    client: new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    }),
    projectIds,
    webhookSecret,
    webhookUrl,
  }
}

async function prepareGitLabGroupHookAction(ctx: PlatformAdapterContext, status: PlatformRuntimeStatus): Promise<
  | {
      settings: ReturnType<typeof normalizeGitLabReviewSettings>
      client: GitLabApiClient
      groups: Array<{ id: string | number; fullPath?: string }>
      webhookSecret: string
      webhookUrl: string
    }
  | { error: PlatformActionResult }
> {
  const settings = normalizeGitLabReviewSettings(ctx.settings)
  const token = await resolveGitLabReviewSecret(settings.tokenSecretRef, ctx.secrets)
  if (!token) {
    return { error: { status: 'failed', message: 'GitLab API token is missing.', updatedStatus: status } }
  }
  const webhookSecret = await resolveOrCreateGitLabWebhookSecret(settings.webhookSecretRef, ctx.secrets)
  if (!webhookSecret) {
    return { error: { status: 'failed', message: 'GitLab webhook secret is missing.', updatedStatus: status } }
  }
  const webhookUrl = dedicatedWebhookUrl(ctx, webhookSecret)
  if (!webhookUrl) {
    return {
      error: {
        status: 'failed',
        message: 'NINE1BOT_LOCAL_URL is not configured, so the current dedicated webhook URL cannot be generated.',
        updatedStatus: status,
      },
    }
  }
  if (settings.hookGroups.length === 0) {
    return {
      error: {
        status: 'failed',
        message: 'Select at least one hook group before Nine1Bot can sync group hooks.',
        updatedStatus: status,
      },
    }
  }
  return {
    settings,
    client: new GitLabApiClient({
      baseUrl: settings.baseUrl || 'https://gitlab.com',
      token,
    }),
    groups: settings.hookGroups,
    webhookSecret,
    webhookUrl,
  }
}

function scopeStatusText(settings: ReturnType<typeof normalizeGitLabReviewSettings>) {
  const excluded = settings.excludedProjects.length
  if (settings.scopeMode === 'selected-only') {
    return `${settings.includedProjects.length} selected${excluded ? `, ${excluded} excluded` : ''}`
  }
  return excluded ? `all received except ${excluded}` : 'all received'
}

async function dedicatedWebhookUrlDisplay(
  settings: ReturnType<typeof normalizeGitLabReviewSettings>,
  ctx: PlatformAdapterContext,
) {
  let secret: string | undefined
  try {
    secret = await resolveGitLabReviewSecret(settings.webhookSecretRef, ctx.secrets)
  } catch {
    secret = undefined
  }
  const url = dedicatedWebhookUrl(ctx, secret || '{webhookSecret}')
  return url || 'NINE1BOT_LOCAL_URL not configured'
}

function dedicatedWebhookUrl(ctx: PlatformAdapterContext, webhookSecret: string) {
  const base = resolveDedicatedWebhookBaseUrl(ctx)
  if (!base) return undefined
  return `${base.replace(/\/+$/, '')}/webhooks/gitlab/${encodeURIComponent(webhookSecret)}`
}

function resolveDedicatedWebhookBaseUrl(ctx: PlatformAdapterContext) {
  const base = (ctx.env.NINE1BOT_LOCAL_URL || ctx.env.NINE1BOT_PUBLIC_URL || '').trim()
  if (!base) return ''
  if (ctx.env.NINE1BOT_REFRESH_LOCAL_URL === '0' || ctx.env.NINE1BOT_REFRESH_LOCAL_URL === 'false') {
    return base.replace(/\/+$/, '')
  }
  return refreshLocalWebhookBaseUrl(base, networkInterfaces())
}

export function refreshLocalWebhookBaseUrl(
  base: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
) {
  let url: URL
  try {
    url = new URL(base)
  } catch {
    return base
  }

  const host = url.hostname
  const localAddresses = reachableIPv4Addresses(interfaces)
  if (!localAddresses.length) return base.replace(/\/+$/, '')
  if (localAddresses.includes(host)) return base.replace(/\/+$/, '')
  if (!shouldRefreshWebhookHost(host)) return base.replace(/\/+$/, '')

  const replacement = sameSubnetAddress(host, localAddresses) ?? preferredWebhookAddress(localAddresses)
  if (!replacement) return base.replace(/\/+$/, '')
  url.hostname = replacement
  return url.toString().replace(/\/+$/, '')
}

function reachableIPv4Addresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>) {
  const addresses: string[] = []
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal && info.address) addresses.push(info.address)
    }
  }
  return addresses
}

function shouldRefreshWebhookHost(host: string) {
  const normalized = host.toLowerCase()
  return normalized === 'localhost'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
    || isPrivateIPv4(normalized)
}

function sameSubnetAddress(host: string, addresses: string[]) {
  const prefix = firstThreeOctets(host)
  if (!prefix) return undefined
  return addresses.find((address) => firstThreeOctets(address) === prefix)
}

function preferredWebhookAddress(addresses: string[]) {
  return addresses.find((address) => address.startsWith('192.168.'))
    ?? addresses.find((address) => address.startsWith('10.'))
    ?? addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address))
    ?? addresses[0]
}

function isPrivateIPv4(host: string) {
  return host.startsWith('10.')
    || host.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
}

function firstThreeOctets(host: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host)
  return match ? `${match[1]}.${match[2]}.${match[3]}` : undefined
}

function findNine1BotHook(hooks: Array<{ id: number; url: string }>, webhookSecret: string) {
  const secretPath = `/webhooks/gitlab/${encodeURIComponent(webhookSecret)}`
  return hooks.find((hook) => {
    try {
      const url = new URL(hook.url)
      return url.pathname === secretPath
    } catch {
      return hook.url.includes(secretPath)
    }
  }) ?? hooks.find((hook) => hook.url.includes('/webhooks/gitlab/'))
}

async function resolveGitLabReviewSecret(
  ref: GitLabReviewSecretRef | undefined,
  secrets: PlatformSecretAccess,
): Promise<string | undefined> {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  return await secrets.get(ref satisfies PlatformSecretRef)
}

async function resolveOrCreateGitLabWebhookSecret(
  ref: GitLabReviewSecretRef | undefined,
  secrets: PlatformSecretAccess,
): Promise<string | undefined> {
  if (!ref) return undefined
  if (typeof ref === 'string') return ref
  const existing = await secrets.get(ref satisfies PlatformSecretRef)
  if (existing) return existing
  if (ref.provider !== 'nine1bot-local') return undefined
  const generated = `sec_${randomBytes(16).toString('hex')}`
  await secrets.set(ref, generated)
  return generated
}

function buildGitLabContextBlocks(
  page: PageContextPayload,
  observedAt: number,
  hostPolicy?: GitLabHostPolicy,
): PlatformContextBlock[] | undefined {
  const adapted = normalizeGitLabPagePayload(page, hostPolicy)
  if (!adapted) return undefined
  const gitlab = asRecord(adapted.raw?.gitlab)
  const pageType = adapted.pageType ?? 'gitlab-repo'
  const mergeKey = pageKeyFor(adapted)
  const blocks: PlatformContextBlock[] = [
    {
      id: 'platform:gitlab',
      layer: 'platform',
      source: 'page-context.gitlab',
      content: renderPlatform(adapted, gitlab),
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 65,
      mergeKey,
      observedAt,
    },
    {
      id: `page:${pageType}`,
      layer: 'page',
      source: 'page-context.gitlab',
      content: renderPage(adapted, gitlab),
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 62,
      mergeKey,
      observedAt,
    },
  ]

  if (adapted.selection?.trim()) {
    blocks.push({
      id: `page:browser-selection:${textDigest(adapted.selection).slice(0, 12)}`,
      layer: 'page',
      source: 'page-context.gitlab.selection',
      content: `Current page selection:\n${adapted.selection.trim()}`,
      lifecycle: 'turn',
      visibility: 'developer-toggle',
      enabled: true,
      priority: 55,
      mergeKey: `${mergeKey}:selection`,
      observedAt,
    })
  }

  return blocks
}

function buildGitLabTemplateContextBlocks(
  templateIds: string[],
  page?: PageContextPayload,
  hostPolicy?: GitLabHostPolicy,
): PlatformContextBlock[] {
  const normalizedPage = page ? normalizeGitLabPagePayload(page, hostPolicy) : undefined
  const blocks: PlatformContextBlock[] = []
  for (const templateId of templateIds) {
    if (templateId === 'browser-gitlab') {
      blocks.push({
        id: 'template:browser-gitlab',
        layer: 'platform',
        source: 'template.browser-gitlab',
        content: 'This session can use GitLab browser context. Treat GitLab repository, file, merge request, commit, and issue page events as active work context.',
        lifecycle: 'session',
        visibility: 'developer-toggle',
        enabled: true,
        priority: 45,
      })
    }
    if (templateId.startsWith('gitlab-')) {
      blocks.push({
        id: `template:${templateId}`,
        layer: 'platform',
        source: `template.${templateId}`,
        content: renderGitLabTemplateContext(templateId, normalizedPage),
        lifecycle: 'session',
        visibility: 'developer-toggle',
        enabled: true,
        priority: 42,
        mergeKey: normalizedPage?.objectKey,
      })
    }
  }
  return blocks
}

function renderGitLabTemplateContext(templateId: string, page?: PageContextPayload) {
  return [
    `GitLab template: ${templateId}`,
    page?.title ? `Initial page title: ${page.title}` : undefined,
    page?.url ? `Initial page URL: ${page.url}` : undefined,
    page?.objectKey ? `Initial object key: ${page.objectKey}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderPlatform(page: PageContextPayload, gitlab?: Record<string, unknown>) {
  return [
    'Platform: GitLab',
    page.title ? `Title: ${page.title}` : undefined,
    page.url ? `URL: ${page.url}` : undefined,
    stringValue(gitlab?.host) ? `Host: ${gitlab?.host}` : undefined,
    stringValue(gitlab?.projectPath) ? `Project path: ${gitlab?.projectPath}` : undefined,
    page.visibleSummary ? `Visible summary:\n${page.visibleSummary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderPage(page: PageContextPayload, gitlab?: Record<string, unknown>) {
  return [
    `Page type: ${page.pageType ?? 'gitlab-repo'}`,
    page.objectKey ? `Object key: ${page.objectKey}` : undefined,
    stringValue(gitlab?.route) ? `GitLab route: ${gitlab?.route}` : undefined,
    stringValue(gitlab?.iid) ? `IID: ${gitlab?.iid}` : undefined,
    stringValue(gitlab?.sha) ? `Commit SHA: ${gitlab?.sha}` : undefined,
    stringValue(gitlab?.ref) ? `Ref: ${gitlab?.ref}` : undefined,
    stringValue(gitlab?.filePath) ? `File path: ${gitlab?.filePath}` : undefined,
    stringValue(gitlab?.treePath) ? `Tree path: ${gitlab?.treePath}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function gitLabResourcesForTemplates(templateIds: string[]): PlatformResourceContribution {
  const skills = new Set<string>()
  const tools = new Set<string>()
  const isGitLabTemplate = templateIds.some((templateId) => (
    templateId === 'browser-gitlab' || templateId.startsWith('gitlab-')
  ))

  if (isGitLabTemplate) {
    skills.add('platform.gitlab.gitlab-assisted-workflow')
    skills.add('platform.gitlab.gitlab-cli-command-policy')
    tools.add(gitLabCliToolIds.status)
    tools.add(gitLabCliToolIds.resolveTarget)
  }
  if (templateIds.includes('gitlab-repo') || templateIds.includes('gitlab-file')) {
    skills.add('platform.gitlab.gitlab-repository-health-workflow')
    tools.add(gitLabCliToolIds.projectSnapshot)
    tools.add(gitLabCliToolIds.repositoryHealthContext)
  }
  if (templateIds.includes('gitlab-mr')) {
    skills.add('platform.gitlab.gitlab-cli-mr-review-workflow')
    tools.add(gitLabCliToolIds.mrSnapshot)
    tools.add(gitLabCliToolIds.mrDiff)
    tools.add(gitLabCliToolIds.publishReviewNote)
    tools.add(gitLabCliToolIds.publishReviewDiscussion)
  }
  if (templateIds.includes('gitlab-commit')) {
    skills.add('platform.gitlab.gitlab-cli-commit-review-workflow')
    tools.add(gitLabCliToolIds.commitDiff)
    tools.add(gitLabCliToolIds.publishReviewNote)
  }

  return emptyResources(['gitlab-context'], [...skills], [...tools])
}

function emptyResources(
  enabledGroups: string[],
  skills: string[] = [],
  registeredTools: string[] = [],
): PlatformResourceContribution {
  return {
    builtinTools: {
      enabledGroups,
    },
    registeredTools: {
      tools: registeredTools,
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
    mcp: {
      servers: [],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
    skills: {
      skills,
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
  }
}

function effectiveGitLabHostPolicy(settingsInput: unknown): GitLabHostPolicy {
  const settings = normalizeGitLabReviewSettings(settingsInput)
  if (settings.configurationErrors.includes('allowed_hosts_invalid')) {
    return { allowedHosts: [], allowedHostsInvalid: true }
  }
  if (settings.allowedHosts.length > 0) {
    return { allowedHosts: settings.allowedHosts }
  }

  const baseUrl = settings.baseUrl
  if (baseUrl) {
    try {
      const url = new URL(baseUrl)
      if (
        (url.protocol === 'http:' || url.protocol === 'https:')
        && !url.username
        && !url.password
        && url.hostname
      ) {
        return { allowedHosts: [url.host.toLowerCase()] }
      }
    } catch {
      // Invalid base URLs use the public GitLab default until review validation reports the field error.
    }
  }
  return { allowedHosts: ['gitlab.com'] }
}

function applyGitLabHostPolicyToCliTargetResolution(
  tools: AnyPlatformToolDefinition[],
  hostPolicy: GitLabHostPolicy,
) {
  return tools.map((tool) => {
    if (tool.id !== gitLabCliToolIds.resolveTarget) return tool
    return {
      ...tool,
      parse(input: unknown) {
        return withGitLabCliResolutionPage(tool.parse(input), hostPolicy)
      },
    }
  })
}

function withGitLabCliResolutionPage(input: unknown, hostPolicy: GitLabHostPolicy) {
  const record = asRecord(input)
  if (!record) return input

  const explicitUrl = stringValue(record.url)
  if (explicitUrl) {
    const parsed = parseGitLabCliTargetUrl(explicitUrl)
    return parsed ? gitLabCliResolutionInputWithPage(record, explicitUrl, parsed) : input
  }

  const page = asRecord(record.page)
  const pageUrl = stringValue(page?.url)
  if (pageUrl) {
    const parsed = parseGitLabCliTargetUrl(pageUrl)
    if (parsed) return gitLabCliResolutionInputWithPage(record, pageUrl, parsed)
  }
  const rawGitLab = asRecord(asRecord(page?.raw)?.gitlab)
  if (stringValue(rawGitLab?.projectPath)) return input

  const text = stringValue(record.text)
  for (const url of gitLabUrlsFromText(text)) {
    const parsed = parseGitLabUrl(url, hostPolicy)
    if (parsed) return gitLabCliResolutionInputWithPage(record, url, parsed)
    if (parseGitLabUrl(url)) return input
  }

  if (hostPolicy.allowedHostsInvalid || hostPolicy.allowedHosts.length !== 1 || !text) return input
  const shorthand = text.match(/(?<![\w.-])((?:[\w.-]+\/)+[\w.-]+)!(\d+)\b/)
  const projectPath = shorthand?.[1]
  const iid = shorthand?.[2]
  if (!projectPath || !iid) return input
  const url = `https://${hostPolicy.allowedHosts[0]}/${projectPath}/-/merge_requests/${iid}`
  const parsed = parseGitLabUrl(url, hostPolicy)
  return parsed ? gitLabCliResolutionInputWithPage(record, url, parsed) : input
}

function parseGitLabCliTargetUrl(input: string) {
  try {
    const url = new URL(input)
    return parseGitLabUrl(input, { allowedHosts: [url.host] })
  } catch {
    return undefined
  }
}

function gitLabCliResolutionInputWithPage(
  record: Record<string, unknown>,
  url: string,
  parsed: NonNullable<ReturnType<typeof parseGitLabUrl>>,
) {
  return {
    ...record,
    url: undefined,
    page: {
      platform: 'gitlab',
      url,
      title: 'GitLab target',
      pageType: parsed.pageType,
      objectKey: parsed.objectKey,
      raw: {
        gitlab: {
          host: parsed.host,
          projectPath: parsed.projectPath,
          route: parsed.route,
          iid: parsed.iid,
          sha: parsed.sha,
        },
      },
    },
  }
}

function gitLabUrlsFromText(input?: string) {
  if (!input) return []
  const matches = input.match(/https?:\/\/[^\s<>"'`，。；、]+/g) ?? []
  return matches.map((url) => url.replace(/[),.;]+$/, ''))
}

let cliStatusCache: { status: GitLabCliStatus; expiresAt: number } | undefined
let cliStatusPending: Promise<GitLabCliStatus> | undefined

async function cachedGitLabCliStatus() {
  const now = Date.now()
  if (cliStatusCache && cliStatusCache.expiresAt > now) return cliStatusCache.status
  if (cliStatusPending) return await cliStatusPending

  cliStatusPending = getGitLabCliStatus({ timeoutMs: 3_000 })
    .then((status) => {
      cliStatusCache = { status, expiresAt: Date.now() + 10_000 }
      return status
    })
    .finally(() => {
      cliStatusPending = undefined
    })
  return await cliStatusPending
}

function pageKeyFor(page: PageContextPayload) {
  return [page.platform, page.pageType || 'page', page.objectKey || page.url || page.title || 'unknown'].join(':')
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function isHttpUrl(input: string) {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function textDigest(input: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
