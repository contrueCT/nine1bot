import {
  asRecord,
  feishuTemplateIdsForPage,
  isFeishuPagePayload,
  normalizeFeishuPagePayload,
  parseFeishuUrl,
} from './shared'
import {
  getFeishuAuthStatus,
  getFeishuCliVersion,
  resolveFeishuCliPath,
} from './cli'
import {
  FEISHU_DEFAULT_METADATA_TIMEOUT_MS,
  readFeishuContextEnrichmentSettings,
} from './enrichment'
import {
  FEISHU_CURRENT_PAGE_SKILL,
  directoryFromActionInput,
  feishuRuntimeSources,
  inspectFeishuSkillSources,
  inspectSkillDirectory,
  resolveOfficialSkillsDirectory,
} from './skills'
import {
  FEISHU_IM_DEFAULT_BUFFER_MS,
  FEISHU_IM_DEFAULT_BUSY_TEXT,
  FEISHU_IM_DEFAULT_MAX_BUFFER_MS,
  FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS,
  FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS,
  FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS,
  validateFeishuIMConfig,
} from './im/config'
import {
  createFeishuIMBackgroundServices,
  getFeishuIMRuntimeStatus,
} from './im/background-runtime'
import type {
  PlatformActionResult,
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformDescriptor,
  PlatformRuntimeAdapter,
  PlatformRuntimeStatus,
} from '@nine1bot/platform-protocol'
import type { PageContextPayload, PlatformContextBlock, PlatformResourceContribution } from './types'

export type FeishuPlatformAdapter = PlatformRuntimeAdapter & {
  id: 'feishu'
  matchPage: (page: PageContextPayload) => boolean
  normalizePage: (page: PageContextPayload) => PageContextPayload | undefined
  blocksFromPage: (page: PageContextPayload, observedAt: number) => PlatformContextBlock[] | undefined
  inferTemplateIds: (input: { entry?: { platform?: string }; page?: PageContextPayload }) => string[]
  templateContextBlocks: (input: { templateIds: string[]; page?: PageContextPayload }) => PlatformContextBlock[]
  resourceContributions: (input: { templateIds: string[] }) => PlatformResourceContribution | undefined
}

export const feishuPlatformDescriptor = {
  id: 'feishu',
  name: 'Feishu/Lark',
  packageName: '@nine1bot/platform-feishu',
  version: '0.1.0',
  defaultEnabled: true,
  capabilities: {
    pageContext: true,
    templates: [
      'browser-feishu',
      'feishu-docx',
      'feishu-wiki',
      'feishu-sheet',
      'feishu-bitable',
      'feishu-folder',
      'feishu-slides',
      'feishu-unknown',
    ],
    resources: true,
    browserExtension: true,
    auth: 'external',
    settingsPage: true,
    statusPage: true,
  },
  config: {
    sections: [
      {
        id: 'cli',
        title: 'CLI',
        description: 'Use the external official lark-cli for Feishu/Lark access.',
        fields: [
          {
            key: 'cliPath',
            type: 'string',
            label: 'lark-cli path',
            description: 'Optional explicit path to lark-cli. Leave empty to search PATH.',
            placeholder: 'Leave empty to search PATH',
          },
          {
            key: 'contextEnrichment',
            type: 'select',
            label: 'Context enrichment',
            description: 'Controls read-only Feishu metadata enrichment for browser side panel messages.',
            options: ['auto', 'visible-only', 'disabled'],
            defaultValue: 'auto',
          },
          {
            key: 'metadataTimeoutMs',
            type: 'number',
            label: 'Metadata timeout',
            description: 'Timeout in milliseconds for read-only metadata lookups. Default: 2000.',
            defaultValue: FEISHU_DEFAULT_METADATA_TIMEOUT_MS,
          },
          {
            key: 'officialSkillsDirectory',
            type: 'string',
            label: 'Official skills directory',
            description: 'External directory containing official lark-* skills. Defaults to ~/.agents/skills. Switching directories takes effect on the next resolve; file changes inside the same directory may take up to 30 seconds to rescan.',
            placeholder: 'Leave empty to use ~/.agents/skills',
          },
        ],
      },
      {
        id: 'im',
        title: 'IM',
        description: 'Feishu/Lark IM settings. The new platform-feishu IM layer stays staged until the legacy websocket path is migrated.',
        fields: [
          {
            key: 'imEnabled',
            type: 'boolean',
            label: 'Enable IM skeleton',
            description: 'Stages the new platform-feishu IM layer. It does not open a production websocket in Phase 1.',
            defaultValue: false,
          },
          {
            key: 'imDefaultAppId',
            type: 'string',
            label: 'Default app ID',
            description: 'Feishu/Lark app_id for the default IM account.',
            placeholder: 'Fill in after enabling IM',
          },
          {
            key: 'imDefaultAppSecret',
            type: 'password',
            label: 'Default app secret',
            description: 'Stored as a Nine1Bot platform secret reference.',
            placeholder: 'Fill in after enabling IM',
            secret: true,
          },
          {
            key: 'imDefaultDirectory',
            type: 'string',
            label: 'Default directory',
            description: 'Fallback workspace directory for new IM conversations.',
            placeholder: 'Leave empty to use the current project directory',
          },
          {
            key: 'imConnectionMode',
            type: 'select',
            label: 'Connection mode',
            description: 'Only websocket is supported for the first IM implementation.',
            options: ['websocket'],
            defaultValue: 'websocket',
          },
          {
            key: 'imDmPolicy',
            type: 'select',
            label: 'Private chat policy',
            options: ['allow', 'deny'],
            defaultValue: 'allow',
          },
          {
            key: 'imGroupPolicy',
            type: 'select',
            label: 'Group chat policy',
            options: ['mention-only', 'allow', 'deny'],
            defaultValue: 'mention-only',
          },
          {
            key: 'imAllowFrom',
            type: 'string-list',
            label: 'Allow from',
            description: 'Optional allowlist of chat IDs or sender IDs.',
            defaultValue: [],
          },
          {
            key: 'imReplyMode',
            type: 'select',
            label: 'Reply target',
            description: 'Where IM replies are posted. Message replies to the incoming message; thread replies in Feishu thread context when available.',
            options: ['message', 'thread'],
            defaultValue: 'message',
          },
          {
            key: 'imReplyPresentation',
            type: 'select',
            label: 'Reply presentation',
            description: 'How agent output is rendered in Feishu. Auto uses text for DM and streaming cards for groups or threads.',
            options: ['auto', 'text', 'card', 'streaming-card'],
            defaultValue: 'auto',
          },
          {
            key: 'imReplyTimeoutMs',
            type: 'number',
            label: 'Reply timeout',
            description: 'Milliseconds before an active IM reply is marked timed out. Default: 600000.',
            defaultValue: FEISHU_IM_DEFAULT_REPLY_TIMEOUT_MS,
          },
          {
            key: 'imStreamingCardUpdateMs',
            type: 'number',
            label: 'Streaming card update',
            description: 'Minimum milliseconds between running streaming-card updates. Default: 1000.',
            defaultValue: FEISHU_IM_DEFAULT_STREAMING_CARD_UPDATE_MS,
          },
          {
            key: 'imStreamingCardMaxChars',
            type: 'number',
            label: 'Streaming card max chars',
            description: 'Maximum characters shown in a streaming card before truncating with a Web continuation hint. Default: 6000.',
            defaultValue: FEISHU_IM_DEFAULT_STREAMING_CARD_MAX_CHARS,
          },
          {
            key: 'imMessageBufferMs',
            type: 'number',
            label: 'Message buffer',
            description: 'Milliseconds to buffer adjacent IM messages before sending them into a Nine1Bot turn.',
            defaultValue: FEISHU_IM_DEFAULT_BUFFER_MS,
          },
          {
            key: 'imMaxBufferMs',
            type: 'number',
            label: 'Max buffer',
            description: 'Hard upper bound for IM message buffering.',
            defaultValue: FEISHU_IM_DEFAULT_MAX_BUFFER_MS,
          },
          {
            key: 'imBusyRejectText',
            type: 'string',
            label: 'Busy reject text',
            defaultValue: FEISHU_IM_DEFAULT_BUSY_TEXT,
          },
          {
            key: 'imAccounts',
            type: 'json',
            label: 'Accounts',
            description: 'Array of account objects. Use appSecretRef; plaintext appSecret is rejected.',
            defaultValue: [],
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
      id: 'skills.refreshOfficialDirectory',
      label: 'Refresh official skills directory',
      description: 'Checks the configured lark-* skills directory. Newly added or removed files inside the same directory may take up to 30 seconds to appear in agent skill resolution.',
      kind: 'button',
    },
    {
      id: 'skills.configureDirectory',
      label: 'Configure official skills directory',
      description: 'Changes the external lark-* skills directory and re-registers platform runtime sources immediately.',
      kind: 'form',
      inputSchema: {
        sections: [{
          id: 'directory',
          title: 'Directory',
          fields: [{
            key: 'directory',
            type: 'string',
            label: 'Official skills directory',
            description: 'Directory containing official lark-* skills. Empty value clears the override. Directory changes apply immediately; same-directory file changes may take up to 30 seconds to rescan.',
            placeholder: 'Leave empty to clear the override',
          }],
        }],
      },
    },
    {
      id: 'im.inspect',
      label: 'Inspect IM skeleton',
      description: 'Shows the normalized Feishu IM skeleton status without opening a websocket.',
      kind: 'button',
    },
  ],
} satisfies PlatformDescriptor

export const feishuPlatformContribution = {
  descriptor: feishuPlatformDescriptor,
  runtime: {
    createAdapter: createFeishuPlatformAdapter,
    sources: feishuRuntimeSources,
  },
  backgroundServices: createFeishuIMBackgroundServices,
  getStatus: getFeishuStatus,
  validateConfig: async (settings) => validateFeishuIMConfig(settings),
  handleAction: handleFeishuAction,
} satisfies PlatformAdapterContribution

export function createFeishuPlatformAdapter(): FeishuPlatformAdapter {
  return {
    id: 'feishu',
    matchPage: isFeishuPagePayload,
    normalizePage: normalizeFeishuPagePayload,
    blocksFromPage: buildFeishuContextBlocks,
    inferTemplateIds(input) {
      if (input.entry?.platform !== 'feishu' && !input.page) return []
      const ids = feishuTemplateIdsForPage(input.page)
      return ids.length > 0 || input.entry?.platform !== 'feishu' ? ids : ['browser-feishu', 'feishu-unknown']
    },
    templateContextBlocks(input) {
      return buildFeishuTemplateContextBlocks(input.templateIds, input.page)
    },
    resourceContributions(input) {
      if (!input.templateIds.some((templateId) => templateId === 'browser-feishu' || templateId.startsWith('feishu-'))) {
        return undefined
      }
      return emptyResources(['feishu-context'], [FEISHU_CURRENT_PAGE_SKILL])
    },
  }
}

export { feishuTemplateIdsForPage, normalizeFeishuPagePayload, parseFeishuUrl }

async function getFeishuStatus(ctx: PlatformAdapterContext): Promise<PlatformRuntimeStatus> {
  const settings = asRecord(ctx.settings)
  const cliPathSetting = stringValue(settings?.cliPath)
  const cliPath = resolveFeishuCliPath(cliPathSetting, ctx.env)
  const enrichmentSettings = readFeishuContextEnrichmentSettings(ctx.settings)
  const skillStatus = inspectFeishuSkillSources(ctx.settings)
  const checkedAt = new Date().toISOString()

  if (!cliPath) {
    return withFeishuIMStatus({
      status: 'missing',
      message: 'lark-cli was not found. Install the official CLI or configure its path.',
      cards: [
        { id: 'cli', label: 'CLI', value: 'missing', tone: 'danger' },
        { id: 'auth', label: 'Auth', value: 'unknown', tone: 'neutral' },
        { id: 'context', label: 'Context', value: enrichmentSettings.contextEnrichment, tone: 'neutral' },
        companionSkillCard(skillStatus.companion),
        officialSkillsCard(skillStatus.official),
        skillCacheCard(),
      ],
      recentEvents: [{
        id: `feishu-cli-missing-${Date.now()}`,
        at: checkedAt,
        level: 'warn',
        stage: 'status',
        message: 'lark-cli was not found',
      }],
    }, ctx)
  }

  const version = await getFeishuCliVersion({
    cliPath,
    env: ctx.env,
    timeoutMs: 2_000,
  })
  const versionText = version.version ?? 'unknown'
  const auth = await getFeishuAuthStatus({
    cliPath,
    env: ctx.env,
    timeoutMs: 3_000,
  })
  const authState = auth.state

  const status = authState === 'authenticated'
    ? 'available'
    : authState === 'unknown'
      ? 'degraded'
      : 'auth-required'
  const skillsReady = skillStatus.companion.skillCount > 0 && skillStatus.official.skillCount > 0
  const finalStatus = status === 'available' && !skillsReady ? 'degraded' : status

  return withFeishuIMStatus({
    status: finalStatus,
    message: finalStatus === 'available'
      ? 'lark-cli is available, authenticated, and Feishu skills are detected.'
      : finalStatus === 'auth-required'
        ? 'lark-cli is available but authentication is required.'
        : status === 'available'
          ? 'lark-cli is available, but Feishu skills need attention.'
          : 'lark-cli is available, but auth status could not be parsed.',
    cards: [
      { id: 'cli', label: 'CLI', value: `found · ${versionText}`, tone: version.exitCode === 0 ? 'success' : 'warning' },
      { id: 'auth', label: 'Auth', value: authCardValue(auth, authState), tone: authTone(authState) },
      { id: 'context', label: 'Context', value: enrichmentSettings.contextEnrichment, tone: contextTone(enrichmentSettings.contextEnrichment) },
      companionSkillCard(skillStatus.companion),
      officialSkillsCard(skillStatus.official),
      skillCacheCard(),
    ],
    recentEvents: [{
      id: `feishu-status-${Date.now()}`,
      at: checkedAt,
      level: finalStatus === 'available' ? 'info' : 'warn',
      stage: 'status',
      message: finalStatus === 'available' ? 'lark-cli and Feishu skills status checked' : 'lark-cli or Feishu skills require status review',
      data: {
        cliPath,
        version: versionText,
        authExitCode: auth.result.exitCode,
        companionSkillsDirectory: skillStatus.companion.directory,
        officialSkillsDirectory: skillStatus.official.directory,
        officialSkillCount: skillStatus.official.skillCount,
      },
    }],
  }, ctx)
}

async function handleFeishuAction(
  actionId: string,
  input: unknown,
  ctx: PlatformAdapterContext,
): Promise<PlatformActionResult> {
  if (actionId === 'skills.refreshOfficialDirectory') {
    const status = await getFeishuStatus(ctx)
    const skills = inspectFeishuSkillSources(ctx.settings)
    return {
      status: 'ok',
      message: skills.official.skillCount > 0
        ? `Found ${skills.official.skillCount} official lark-* skills. Directory changes apply immediately; same-directory file changes may take up to 30 seconds to appear in agent skill resolution.`
        : 'Official lark-* skills were not found in the configured directory. If files were just added to the same directory, they may take up to 30 seconds to appear in agent skill resolution.',
      data: {
        companion: skills.companion,
        official: skills.official,
      },
      updatedStatus: status,
    }
  }

  if (actionId === 'skills.configureDirectory') {
    const directory = directoryFromActionInput(input)
    if (directory === undefined) {
      return {
        status: 'failed',
        message: 'Directory must be a string, null, or empty value.',
      }
    }
    if (directory) {
      const inspection = inspectSkillDirectory(directory, { prefix: 'lark-' })
      if (!inspection.exists || !inspection.readable) {
        return {
          status: 'failed',
          message: inspection.error ?? 'Official skills directory is not readable.',
          data: {
            official: inspection,
          },
        }
      }
    }

    const currentSettings = asRecord(ctx.settings) ?? {}
    const nextSettings = {
      ...currentSettings,
      officialSkillsDirectory: directory ?? undefined,
    }
    const updatedStatus = await getFeishuStatus({
      ...ctx,
      settings: nextSettings,
    })
    const official = inspectSkillDirectory(resolveOfficialSkillsDirectory(nextSettings), { prefix: 'lark-' })
    return {
      status: 'ok',
      message: directory
        ? `Configured official skills directory: ${directory}`
        : 'Cleared official skills directory override.',
      data: {
        official,
      },
      updatedSettings: {
        officialSkillsDirectory: directory ?? null,
      },
      updatedStatus,
    }
  }

  if (actionId === 'im.inspect') {
    const updatedStatus = await getFeishuStatus(ctx)
    return {
      status: 'ok',
      message: 'Feishu IM skeleton status inspected.',
      updatedStatus,
    }
  }

  return {
    status: 'failed',
    message: `Action is not implemented: ${actionId}`,
  }
}

function withFeishuIMStatus(status: PlatformRuntimeStatus, ctx: PlatformAdapterContext): PlatformRuntimeStatus {
  const imStatus = getFeishuIMRuntimeStatus(ctx)
  const mergedStatus = imStatus.status === 'disabled'
    ? status.status
    : higherSeverity(status.status, imStatus.status)
  return {
    status: mergedStatus,
    message: mergedStatus === imStatus.status
      ? imStatus.message
      : status.message,
    cards: [
      ...(status.cards ?? []),
      ...(imStatus.cards ?? []),
    ],
    recentEvents: [
      ...(status.recentEvents ?? []),
      ...(imStatus.recentEvents ?? []),
    ],
  }
}

function higherSeverity(
  left: PlatformRuntimeStatus['status'],
  right: PlatformRuntimeStatus['status'],
): PlatformRuntimeStatus['status'] {
  return severity(right) > severity(left) ? right : left
}

function severity(status: PlatformRuntimeStatus['status']): number {
  if (status === 'error') return 60
  if (status === 'missing') return 50
  if (status === 'auth-required') return 40
  if (status === 'degraded') return 30
  if (status === 'disabled') return 10
  return 0
}

function buildFeishuContextBlocks(page: PageContextPayload, observedAt: number): PlatformContextBlock[] | undefined {
  const adapted = normalizeFeishuPagePayload(page)
  if (!adapted) return undefined
  const feishu = asRecord(adapted.raw?.feishu)
  const pageType = adapted.pageType ?? 'feishu-unknown'
  const mergeKey = pageKeyFor(adapted)
  const blocks: PlatformContextBlock[] = [
    {
      id: 'platform:feishu',
      layer: 'platform',
      source: 'page-context.feishu',
      content: renderPlatform(adapted, feishu),
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
      source: 'page-context.feishu',
      content: renderPage(adapted, feishu),
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
      source: 'page-context.feishu.selection',
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

function buildFeishuTemplateContextBlocks(templateIds: string[], page?: PageContextPayload): PlatformContextBlock[] {
  const normalizedPage = page ? normalizeFeishuPagePayload(page) : undefined
  const blocks: PlatformContextBlock[] = []
  for (const templateId of templateIds) {
    if (templateId === 'browser-feishu') {
      blocks.push({
        id: 'template:browser-feishu',
        layer: 'platform',
        source: 'template.browser-feishu',
        content: [
          'This session can use Feishu/Lark browser context. Treat the current Feishu/Lark page as active work context and use the official lark-cli when the user asks to access Feishu/Lark data.',
          feishuWriteSafetyContext(),
        ].join('\n'),
        lifecycle: 'session',
        visibility: 'developer-toggle',
        enabled: true,
        priority: 45,
      })
    }
    if (templateId.startsWith('feishu-')) {
      blocks.push({
        id: `template:${templateId}`,
        layer: 'platform',
        source: `template.${templateId}`,
        content: renderFeishuTemplateContext(templateId, normalizedPage),
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

function renderFeishuTemplateContext(templateId: string, page?: PageContextPayload) {
  return [
    `Feishu/Lark template: ${templateId}`,
    page?.title ? `Initial page title: ${page.title}` : undefined,
    page?.url ? `Initial page URL: ${page.url}` : undefined,
    page?.objectKey ? `Initial object key: ${page.objectKey}` : undefined,
    feishuWriteSafetyContext(),
  ]
    .filter(Boolean)
    .join('\n')
}

function feishuWriteSafetyContext() {
  return 'Feishu/Lark write operations should prefer the official lark-cli, respect CLI-native prompts and existing Nine1Bot permissions, and use dry-run first when the chosen command supports it. Nine1Bot does not wrap or intercept arbitrary lark-cli write commands.'
}

function renderPlatform(page: PageContextPayload, feishu?: Record<string, unknown>) {
  return [
    'Platform: Feishu/Lark',
    page.title ? `Title: ${page.title}` : undefined,
    page.url ? `URL: ${page.url}` : undefined,
    stringValue(feishu?.host) ? `Host: ${feishu?.host}` : undefined,
    stringValue(feishu?.tenant) ? `Tenant: ${feishu?.tenant}` : undefined,
    page.visibleSummary ? `Visible summary:\n${page.visibleSummary}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function renderPage(page: PageContextPayload, feishu?: Record<string, unknown>) {
  return [
    `Page type: ${page.pageType ?? 'feishu-unknown'}`,
    page.objectKey ? `Object key: ${page.objectKey}` : undefined,
    stringValue(feishu?.route) ? `Feishu route: ${feishu?.route}` : undefined,
    stringValue(feishu?.objType) ? `Object type: ${feishu?.objType}` : undefined,
    stringValue(feishu?.token) ? `Token: ${feishu?.token}` : undefined,
    stringValue(feishu?.tableId) ? `Base table: ${feishu?.tableId}` : undefined,
    stringValue(feishu?.viewId) ? `Base view: ${feishu?.viewId}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function emptyResources(enabledGroups: string[], skills: string[] = []): PlatformResourceContribution {
  return {
    builtinTools: {
      enabledGroups,
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

function authCardValue(auth: { identity?: string; tokenStatus?: string }, authState: string) {
  if (authState === 'authenticated') {
    return [auth.identity, auth.tokenStatus].filter(Boolean).join(' · ') || 'authenticated'
  }
  if (authState === 'need_config') return 'configuration required'
  if (authState === 'need_login') return 'login required'
  return 'unknown'
}

function authTone(authState: string) {
  if (authState === 'authenticated') return 'success' as const
  if (authState === 'need_config' || authState === 'need_login') return 'warning' as const
  return 'neutral' as const
}

function contextTone(mode: string) {
  if (mode === 'auto') return 'success' as const
  if (mode === 'visible-only') return 'warning' as const
  return 'neutral' as const
}

function companionSkillCard(status: { skillCount: number; directory: string; readable: boolean; error?: string }) {
  return {
    id: 'companion',
    label: 'Companion',
    value: status.skillCount > 0 ? FEISHU_CURRENT_PAGE_SKILL : 'missing',
    tone: status.skillCount > 0 ? 'success' as const : status.readable ? 'warning' as const : 'danger' as const,
  }
}

function officialSkillsCard(status: { skillCount: number; directory: string; readable: boolean; error?: string }) {
  return {
    id: 'skills',
    label: 'Skills',
    value: status.skillCount > 0 ? `${status.skillCount} lark-* skills` : 'missing',
    tone: status.skillCount > 0 ? 'success' as const : status.readable ? 'warning' as const : 'danger' as const,
  }
}

function skillCacheCard() {
  return {
    id: 'skills-cache',
    label: 'Skill cache',
    value: 'rescan <= 30s',
    tone: 'neutral' as const,
  }
}

function pageKeyFor(page: PageContextPayload) {
  return [page.platform, page.pageType || 'page', page.objectKey || page.url || page.title || 'unknown'].join(':')
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input.trim() : undefined
}

function textDigest(input: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
