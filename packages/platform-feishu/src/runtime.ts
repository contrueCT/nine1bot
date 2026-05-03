import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import {
  asRecord,
  feishuTemplateIdsForPage,
  isFeishuPagePayload,
  normalizeFeishuPagePayload,
  parseFeishuUrl,
} from './shared'
import type {
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
          },
        ],
      },
    ],
  },
  detailPage: {
    sections: [
      { id: 'status', type: 'status-cards', title: 'Status' },
      { id: 'settings', type: 'settings-form', title: 'Settings' },
      { id: 'recent-events', type: 'event-list', title: 'Recent events' },
    ],
  },
} satisfies PlatformDescriptor

export const feishuPlatformContribution = {
  descriptor: feishuPlatformDescriptor,
  runtime: {
    createAdapter: createFeishuPlatformAdapter,
  },
  getStatus: getFeishuStatus,
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
      return emptyResources(['feishu-context'])
    },
  }
}

export { feishuTemplateIdsForPage, normalizeFeishuPagePayload, parseFeishuUrl }

async function getFeishuStatus(ctx: PlatformAdapterContext): Promise<PlatformRuntimeStatus> {
  const settings = asRecord(ctx.settings)
  const cliPathSetting = stringValue(settings?.cliPath)
  const cliPath = findCliPath(cliPathSetting, ctx.env)
  const checkedAt = new Date().toISOString()

  if (!cliPath) {
    return {
      status: 'missing',
      message: 'lark-cli was not found. Install the official CLI or configure its path.',
      cards: [
        { id: 'cli', label: 'CLI', value: 'missing', tone: 'danger' },
        { id: 'auth', label: 'Auth', value: 'unknown', tone: 'neutral' },
      ],
      recentEvents: [{
        id: `feishu-cli-missing-${Date.now()}`,
        at: checkedAt,
        level: 'warn',
        stage: 'status',
        message: 'lark-cli was not found',
      }],
    }
  }

  const version = await runCli(cliPath, ['version'], ctx.env, 2_000)
  const versionText = parseVersion(version.stdout) ?? 'unknown'
  const auth = await runCli(cliPath, ['auth', 'status'], ctx.env, 3_000)
  const parsedAuth = parseAuthStatus(auth.stdout || auth.stderr)
  const authState = authStateFrom(parsedAuth, auth)

  const status = authState === 'authenticated'
    ? 'available'
    : authState === 'unknown'
      ? 'degraded'
      : 'auth-required'

  return {
    status,
    message: status === 'available'
      ? 'lark-cli is available and authenticated.'
      : status === 'auth-required'
        ? 'lark-cli is available but authentication is required.'
        : 'lark-cli is available, but auth status could not be parsed.',
    cards: [
      { id: 'cli', label: 'CLI', value: `found · ${versionText}`, tone: version.exitCode === 0 ? 'success' : 'warning' },
      { id: 'auth', label: 'Auth', value: authCardValue(parsedAuth, authState), tone: authTone(authState) },
    ],
    recentEvents: [{
      id: `feishu-status-${Date.now()}`,
      at: checkedAt,
      level: status === 'available' ? 'info' : 'warn',
      stage: 'status',
      message: status === 'available' ? 'lark-cli status checked' : 'lark-cli requires authentication or status review',
      data: {
        cliPath,
        version: versionText,
        authExitCode: auth.exitCode,
      },
    }],
  }
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
        content: 'This session can use Feishu/Lark browser context. Treat the current Feishu/Lark page as active work context and use the official lark-cli when the user asks to access Feishu/Lark data.',
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
  ]
    .filter(Boolean)
    .join('\n')
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

function findCliPath(cliPathSetting: string | undefined, env: Record<string, string | undefined>): string | undefined {
  if (cliPathSetting) {
    if (hasPathSeparator(cliPathSetting) || isAbsolute(cliPathSetting)) return existsSync(cliPathSetting) ? cliPathSetting : undefined
    return cliPathSetting
  }

  const pathValue = env.PATH ?? env.Path ?? env.path ?? process.env.PATH
  if (!pathValue) return undefined
  const names = process.platform === 'win32'
    ? ['lark-cli.cmd', 'lark-cli.exe', 'lark-cli']
    : ['lark-cli']
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = join(directory, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

function runCli(command: string, args: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
}> {
  return new Promise((resolve) => {
    execFile(command, args, {
      env: {
        ...process.env,
        ...env,
      },
      timeout: timeoutMs,
      windowsHide: true,
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
    }, (error, stdout, stderr) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
      const exitCode = typeof code === 'number' ? code : error ? 1 : 0
      resolve({
        exitCode,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
      })
    })
  })
}

function parseVersion(stdout: string): string | undefined {
  const firstLine = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  if (!firstLine) return undefined
  const match = firstLine.match(/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)/)
  return match?.[1] ?? firstLine
}

function parseAuthStatus(output: string): Record<string, unknown> | undefined {
  const trimmed = output.trim()
  if (!trimmed) return undefined
  try {
    return JSON.parse(trimmed) as Record<string, unknown>
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
      } catch {}
    }
    return undefined
  }
}

function authStateFrom(parsed: Record<string, unknown> | undefined, result: { exitCode: number | null; stdout: string; stderr: string }) {
  const tokenStatus = stringValue(parsed?.tokenStatus)?.toLowerCase()
  const identity = stringValue(parsed?.identity)
  if (result.exitCode === 0 && tokenStatus === 'valid' && identity) return 'authenticated'
  if (tokenStatus === 'expired' || tokenStatus === 'invalid') return 'auth-required'
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase()
  if (output.includes('login') || output.includes('auth') || output.includes('config') || output.includes('unauthorized')) return 'auth-required'
  return 'unknown'
}

function authCardValue(parsed: Record<string, unknown> | undefined, authState: string) {
  if (authState === 'authenticated') {
    return [stringValue(parsed?.identity), stringValue(parsed?.tokenStatus)].filter(Boolean).join(' · ') || 'authenticated'
  }
  if (authState === 'auth-required') return 'required'
  return 'unknown'
}

function authTone(authState: string) {
  if (authState === 'authenticated') return 'success' as const
  if (authState === 'auth-required') return 'warning' as const
  return 'neutral' as const
}

function pageKeyFor(page: PageContextPayload) {
  return [page.platform, page.pageType || 'page', page.objectKey || page.url || page.title || 'unknown'].join(':')
}

function hasPathSeparator(input: string) {
  return input.includes('/') || input.includes('\\')
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
