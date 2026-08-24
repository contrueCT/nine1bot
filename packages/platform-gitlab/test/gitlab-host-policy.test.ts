import { describe, expect, test } from 'bun:test'
import type { PlatformAdapterContext, PlatformToolCallContext } from '@nine1bot/platform-protocol'
import {
  buildGitLabPageContextPayload,
  isGitLabPagePayload,
  normalizeGitLabPagePayload,
  parseGitLabUrl,
} from '../src/shared'
import {
  createGitLabPlatformAdapter,
  gitlabPlatformContribution,
} from '../src/runtime'
import { gitLabCliToolIds } from '../src/cli'
import type { PageContextPayload } from '../src/types'

const companyMrUrl = 'https://code.company.example/group/project/-/merge_requests/42'
const evilMrUrl = 'https://evil-gitlab.example/group/project/-/merge_requests/42'

describe('GitLab effective host policy', () => {
  test('uses the supplied host policy for parsing and browser page payloads', () => {
    const policy = { allowedHosts: ['code.company.example'] }

    expect(parseGitLabUrl(companyMrUrl, policy)).toMatchObject({
      host: 'code.company.example',
      projectPath: 'group/project',
      route: 'merge_request',
      iid: '42',
    })
    expect(parseGitLabUrl(evilMrUrl, policy)).toBeUndefined()
    expect(isGitLabPagePayload({ platform: 'generic-browser', url: companyMrUrl }, policy)).toBe(true)
    expect(normalizeGitLabPagePayload(page(companyMrUrl), policy)).toMatchObject({
      platform: 'gitlab',
      objectKey: 'code.company.example:group/project:merge_request:42',
    })
    expect(buildGitLabPageContextPayload({
      url: evilMrUrl,
      title: 'Not trusted',
    }, policy)).toMatchObject({
      platform: 'generic-browser',
      url: evilMrUrl,
    })
  })

  test('derives one effective host from baseUrl before falling back to gitlab.com', () => {
    const fromBaseUrl = createGitLabPlatformAdapter({
      allowedHosts: [],
      'review.baseUrl': 'https://Code.Company.Example/gitlab',
    })
    const fallback = createGitLabPlatformAdapter({ allowedHosts: [] })

    expect(fromBaseUrl.matchPage(page(companyMrUrl))).toBe(true)
    expect(fromBaseUrl.matchPage(page('https://gitlab.com/group/project/-/merge_requests/42'))).toBe(false)
    expect(fallback.matchPage(page('https://gitlab.com/group/project/-/merge_requests/42'))).toBe(true)
    expect(fallback.matchPage(page(evilMrUrl))).toBe(false)
  })

  test('captures settings when the runtime contribution creates its adapter', () => {
    const createAdapter = gitlabPlatformContribution.runtime?.createAdapter
    if (!createAdapter) throw new Error('Expected GitLab runtime adapter factory')

    const adapter = createAdapter(platformContext(true, {
      allowedHosts: ['code.company.example'],
    }))

    expect(adapter.matchPage?.(page(companyMrUrl))).toBe(true)
    expect(adapter.matchPage?.(page(evilMrUrl))).toBe(false)
  })

  test('prefers a non-empty valid allowlist and rejects every host for an invalid allowlist', () => {
    const explicit = createGitLabPlatformAdapter({
      allowedHosts: ['code.company.example'],
      'review.baseUrl': 'https://gitlab.com',
    })
    const invalid = createGitLabPlatformAdapter({
      allowedHosts: ['bad host ???'],
      'review.baseUrl': 'https://gitlab.com',
    })

    expect(explicit.normalizePage(page(companyMrUrl))).toMatchObject({ platform: 'gitlab' })
    expect(explicit.normalizePage(page('https://gitlab.com/group/project'))).toBeUndefined()
    expect(explicit.blocksFromPage(page(evilMrUrl), 1_000)).toBeUndefined()
    expect(invalid.matchPage(page('https://gitlab.com/group/project'))).toBe(false)
    expect(invalid.normalizePage(page(companyMrUrl))).toBeUndefined()
    expect(invalid.blocksFromPage(page(companyMrUrl), 1_000)).toBeUndefined()
  })

  test('does not trust forged GitLab raw context from a disallowed page host', () => {
    const adapter = createGitLabPlatformAdapter({ allowedHosts: ['code.company.example'] })
    const forged: PageContextPayload = {
      platform: 'gitlab',
      url: evilMrUrl,
      title: 'Forged GitLab payload',
      pageType: 'gitlab-mr',
      raw: {
        gitlab: {
          host: 'code.company.example',
          projectPath: 'group/project',
          route: 'merge_request',
          iid: '42',
        },
      },
    }

    expect(adapter.matchPage(forged)).toBe(false)
    expect(adapter.normalizePage(forged)).toBeUndefined()
    expect(adapter.blocksFromPage(forged, 1_000)).toBeUndefined()
  })

  test('applies the same effective host policy to runtime CLI URL targets', async () => {
    const tools = runtimeTools({
      allowedHosts: [],
      'review.baseUrl': 'https://code.company.example/gitlab',
    })
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const allowed = await resolveTarget.execute(resolveTarget.parse({ url: companyMrUrl }), toolCallContext())
    const denied = await resolveTarget.execute(resolveTarget.parse({ url: evilMrUrl }), toolCallContext())

    expect(resultData(allowed)).toMatchObject({
      target: {
        kind: 'merge_request',
        host: 'code.company.example',
        projectPath: 'group/project',
        iid: '42',
      },
    })
    expect(denied).toMatchObject({
      status: 'failed',
      code: 'gitlab-target-not-allowed',
    })
  })

  test('resolves a configured self-managed host from page URL context without raw metadata', async () => {
    const tools = runtimeTools({ allowedHosts: ['code.company.example'] })
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const result = await resolveTarget.execute(resolveTarget.parse({
      page: page(companyMrUrl),
    }), toolCallContext())

    expect(resultData(result)).toMatchObject({
      target: {
        kind: 'merge_request',
        host: 'code.company.example',
        projectPath: 'group/project',
        iid: '42',
      },
    })
  })

  test('uses the sole effective host for a hostless CLI shorthand target', async () => {
    const tools = runtimeTools({})
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const result = await resolveTarget.execute(resolveTarget.parse({
      text: 'Please review group/project!42',
    }), toolCallContext())

    expect(resultData(result)).toMatchObject({
      target: {
        kind: 'merge_request',
        host: 'gitlab.com',
        projectPath: 'group/project',
        iid: '42',
      },
    })
  })

  test('does not let a lower-priority text URL replace a denied explicit URL', async () => {
    const tools = runtimeTools({ allowedHosts: ['code.company.example'] })
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const result = await resolveTarget.execute(resolveTarget.parse({
      url: evilMrUrl,
      text: `Fallback ${companyMrUrl}`,
    }), toolCallContext())

    expect(result).toMatchObject({
      status: 'failed',
      code: 'gitlab-target-not-allowed',
    })
  })

  test('does not let text replace a denied self-managed page URL', async () => {
    const tools = runtimeTools({ allowedHosts: ['code.company.example'] })
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const result = await resolveTarget.execute(resolveTarget.parse({
      page: page('https://code.evil.example/group/project/-/merge_requests/42'),
      text: `Fallback ${companyMrUrl}`,
    }), toolCallContext())

    expect(result).toMatchObject({
      status: 'failed',
      code: 'gitlab-target-not-allowed',
    })
  })

  test('fails closed for CLI targets when the configured allowlist is invalid', async () => {
    const tools = runtimeTools({
      allowedHosts: ['bad host ???'],
      'review.baseUrl': 'https://gitlab.com',
    })
    const resolveTarget = requiredTool(tools, gitLabCliToolIds.resolveTarget)

    const result = await resolveTarget.execute(resolveTarget.parse({
      url: 'https://gitlab.com/group/project/-/merge_requests/42',
    }), toolCallContext())

    expect(result).toMatchObject({
      status: 'failed',
      code: 'gitlab-target-not-allowed',
    })
  })

  test('allows disabling the platform while stale project profile errors remain stored', async () => {
    const settings = {
      'review.enabled': true,
      'review.tokenSecretRef': 'token-value',
      'review.projects': [{
        id: 'stale-binding',
        host: 'code.company.example',
        projectId: 3,
        enabled: true,
      }],
    }

    const active = await gitlabPlatformContribution.validateConfig?.(settings, platformContext(true, settings))
    const disabled = await gitlabPlatformContribution.validateConfig?.(settings, platformContext(false, settings))

    expect(active).toMatchObject({
      ok: false,
      fieldErrors: { 'review.projects': expect.any(String) },
    })
    expect(disabled).toEqual({ ok: true })
  })
})

function page(url: string): PageContextPayload {
  return {
    platform: 'generic-browser',
    url,
    title: 'GitLab page',
  }
}

function runtimeTools(settings: Record<string, unknown>) {
  const provider = gitlabPlatformContribution.runtime?.tools
  if (typeof provider !== 'function') throw new Error('Expected GitLab runtime tool provider')
  return provider(platformContext(true, settings))
}

function requiredTool(tools: ReturnType<typeof runtimeTools>, id: string) {
  const tool = tools.find((candidate) => candidate.id === id)
  if (!tool) throw new Error(`Missing tool: ${id}`)
  return tool
}

function resultData(result: Awaited<ReturnType<ReturnType<typeof runtimeTools>[number]['execute']>>) {
  if (result.status !== 'ok') throw new Error(`Expected ok result, got ${result.status}: ${result.message}`)
  return (JSON.parse(result.output) as { data: unknown }).data
}

function platformContext(enabled: boolean, settings: Record<string, unknown>): PlatformAdapterContext {
  return {
    platformId: 'gitlab',
    enabled,
    settings,
    features: {},
    env: {},
    packageResources: {
      root: 'C:/workspace/platform-gitlab',
      resolve: (...segments: string[]) => ['C:/workspace/platform-gitlab', ...segments].join('/'),
    },
    secrets: {
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
    },
    audit: { write() {} },
  }
}

function toolCallContext(): PlatformToolCallContext {
  return {
    sessionId: 'session-host-policy-test',
    projectId: 'project-host-policy-test',
    directory: 'C:/workspace/project',
    agent: 'build',
    templateIds: ['browser-gitlab', 'gitlab-mr'],
    messageId: 'message-host-policy-test',
    callId: 'call-host-policy-test',
    signal: new AbortController().signal,
    async reportProgress() {},
  }
}
