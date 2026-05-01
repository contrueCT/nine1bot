import {
  asRecord,
  gitLabTemplateIdsForPage,
  isGitLabPagePayload,
  normalizeGitLabPagePayload,
  parseGitLabUrl,
} from './shared'
import type { PlatformAdapterContribution, PlatformDescriptor, PlatformRuntimeAdapter } from '@nine1bot/platform-protocol'
import type { PageContextPayload, PlatformContextBlock, PlatformResourceContribution } from './types'

export type GitLabPlatformAdapter = PlatformRuntimeAdapter & {
  id: 'gitlab'
  matchPage: (page: PageContextPayload) => boolean
  normalizePage: (page: PageContextPayload) => PageContextPayload | undefined
  blocksFromPage: (page: PageContextPayload, observedAt: number) => PlatformContextBlock[] | undefined
  inferTemplateIds: (input: { entry?: { platform?: string }; page?: PageContextPayload }) => string[]
  templateContextBlocks: (input: { templateIds: string[]; page?: PageContextPayload }) => PlatformContextBlock[]
  resourceContributions: (input: { templateIds: string[] }) => PlatformResourceContribution | undefined
}

export const gitlabPlatformDescriptor = {
  id: 'gitlab',
  name: 'GitLab',
  packageName: '@nine1bot/platform-gitlab',
  version: '0.1.0',
  defaultEnabled: true,
  capabilities: {
    pageContext: true,
    templates: ['browser-gitlab', 'gitlab-repo', 'gitlab-file', 'gitlab-mr', 'gitlab-issue'],
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
            description: 'GitLab hosts that can contribute page context.',
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
  ],
} satisfies PlatformDescriptor

export const gitlabPlatformContribution = {
  descriptor: gitlabPlatformDescriptor,
  runtime: {
    createAdapter: createGitLabPlatformAdapter,
  },
} satisfies PlatformAdapterContribution

export function createGitLabPlatformAdapter(): GitLabPlatformAdapter {
  return {
    id: 'gitlab',
    matchPage: isGitLabPagePayload,
    normalizePage: normalizeGitLabPagePayload,
    blocksFromPage: buildGitLabContextBlocks,
    inferTemplateIds(input) {
      if (input.entry?.platform !== 'gitlab' && !input.page) return []
      const ids = gitLabTemplateIdsForPage(input.page)
      return ids.length > 0 || input.entry?.platform !== 'gitlab' ? ids : ['browser-gitlab']
    },
    templateContextBlocks(input) {
      return buildGitLabTemplateContextBlocks(input.templateIds, input.page)
    },
    resourceContributions(input) {
      if (!input.templateIds.some((templateId) => templateId === 'browser-gitlab' || templateId.startsWith('gitlab-'))) {
        return undefined
      }
      return emptyResources(['gitlab-context'])
    },
  }
}

export { gitLabTemplateIdsForPage, normalizeGitLabPagePayload, parseGitLabUrl }

function buildGitLabContextBlocks(page: PageContextPayload, observedAt: number): PlatformContextBlock[] | undefined {
  const adapted = normalizeGitLabPagePayload(page)
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

function buildGitLabTemplateContextBlocks(templateIds: string[], page?: PageContextPayload): PlatformContextBlock[] {
  const normalizedPage = page ? normalizeGitLabPagePayload(page) : undefined
  const blocks: PlatformContextBlock[] = []
  for (const templateId of templateIds) {
    if (templateId === 'browser-gitlab') {
      blocks.push({
        id: 'template:browser-gitlab',
        layer: 'platform',
        source: 'template.browser-gitlab',
        content: 'This session can use GitLab browser context. Treat GitLab repository, file, merge request, and issue page events as active work context.',
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
    stringValue(gitlab?.ref) ? `Ref: ${gitlab?.ref}` : undefined,
    stringValue(gitlab?.filePath) ? `File path: ${gitlab?.filePath}` : undefined,
    stringValue(gitlab?.treePath) ? `Tree path: ${gitlab?.treePath}` : undefined,
  ]
    .filter(Boolean)
    .join('\n')
}

function emptyResources(enabledGroups: string[]): PlatformResourceContribution {
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
      skills: [],
      lifecycle: 'session',
      mergeMode: 'additive-only',
    },
  }
}

function pageKeyFor(page: PageContextPayload) {
  return [page.platform, page.pageType || 'page', page.objectKey || page.url || page.title || 'unknown'].join(':')
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined
}

function textDigest(input: string) {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}
