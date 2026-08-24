import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  authApi,
  configApi,
  customProviderApi,
  gitLabReviewApi,
  importAuthFromOpencode,
  mcpApi,
  nine1botConfigApi,
  platformApi,
  preferencesApi,
  providerApi,
  setApiDirectory,
  skillApi,
  webhookApi,
  type CustomProvider,
} from '../src/api/client'

type FetchCall = {
  url: string
  method: string
  body?: unknown
  directory?: string
}

const originalFetch = globalThis.fetch
let calls: FetchCall[] = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  })
}

function installFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    const method = init?.method || 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const directory = new Headers(init?.headers).get('x-opencode-directory') || undefined
    calls.push({ url, method, body, directory })
    return handler(url, init)
  }) as typeof fetch
}

function callSummary() {
  return calls.map((call) => [call.method, call.url])
}

beforeEach(() => {
  calls = []
  setApiDirectory('')
})

afterEach(() => {
  globalThis.fetch = originalFetch
  setApiDirectory('')
})

describe('web config APIs', () => {
  it('passes source, limit, and offset when paging webhook runs', async () => {
    installFetchMock((url) => {
      if (url === '/webhooks/runs?sourceID=src%2Ftest&limit=11&offset=20') {
        return jsonResponse([{ id: 'run_21' }])
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(webhookApi.runs({ sourceID: 'src/test', limit: 11, offset: 20 })).resolves.toEqual([
      { id: 'run_21' },
    ])
  })

  it('sends webhook tests through the same-origin management endpoint', async () => {
    installFetchMock((url) => {
      if (url === '/webhooks/sources/src%2Ftest/test') {
        return jsonResponse({ accepted: true, runId: 'run_1' }, 202)
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(webhookApi.sendTest('src/test', { monitor: { status: 'down' } })).resolves.toEqual({
      status: 202,
      body: { accepted: true, runId: 'run_1' },
    })
    expect(callSummary()).toEqual([
      ['POST', '/webhooks/sources/src%2Ftest/test'],
    ])
    expect(calls[0].body).toEqual({ monitor: { status: 'down' } })
  })

  it('surfaces rejected webhook tests as errors', async () => {
    installFetchMock(() => jsonResponse({
      accepted: false,
      error: 'webhook_cooldown_active',
      guardReason: 'Wait before triggering this source again.',
    }, 429))

    await expect(webhookApi.sendTest('src_test', {})).rejects.toThrow('Wait before triggering this source again.')
  })

  it('loads GitLab review runs from the dedicated webhook endpoint', async () => {
    installFetchMock((url) => {
      if (url === '/webhooks/gitlab/runs?limit=25') {
        return jsonResponse({
          runs: [{
            id: 'review_1',
            platform: 'gitlab',
            status: 'succeeded',
            rootRunId: 'review_root',
            attempt: 2,
            retryOf: 'review_root',
            triggerKey: 'trigger_review_1',
            generation: 'generation_review_1',
            recoverable: false,
            rejectionKind: 'policy',
            createdAt: 1,
            updatedAt: 2,
            publishedAt: 3,
            retryCount: 1,
            lastRetryAt: 4,
          }],
        })
      }
      if (url === '/webhooks/gitlab/runs/review_1/retry') {
        return jsonResponse({ accepted: true, runId: 'review_1' }, 202)
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(gitLabReviewApi.runs({ limit: 25 })).resolves.toEqual([{
      id: 'review_1',
      platform: 'gitlab',
      status: 'succeeded',
      rootRunId: 'review_root',
      attempt: 2,
      retryOf: 'review_root',
      triggerKey: 'trigger_review_1',
      generation: 'generation_review_1',
      recoverable: false,
      rejectionKind: 'policy',
      createdAt: 1,
      updatedAt: 2,
      publishedAt: 3,
      retryCount: 1,
      lastRetryAt: 4,
    }])
    await expect(gitLabReviewApi.retry('review_1')).resolves.toEqual({ accepted: true, runId: 'review_1' })
    expect(callSummary()).toEqual([
      ['GET', '/webhooks/gitlab/runs?limit=25'],
      ['POST', '/webhooks/gitlab/runs/review_1/retry'],
    ])
  })

  it('surfaces backend rejection when a GitLab run is not retryable', async () => {
    installFetchMock((url) => {
      if (url === '/webhooks/gitlab/runs/policy-run/retry') {
        return jsonResponse({ accepted: false, error: 'review_run_not_recoverable' }, 409)
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(gitLabReviewApi.retry('policy-run')).rejects.toThrow('review_run_not_recoverable')
    expect(callSummary()).toEqual([
      ['POST', '/webhooks/gitlab/runs/policy-run/retry'],
    ])
  })

  it('keeps MCP and skill operations on resource config endpoints', async () => {
    installFetchMock((url, init) => {
      const method = init?.method || 'GET'
      if (url === '/mcp' && method === 'GET') {
        return jsonResponse({
          gitlab: {
            status: 'connected',
            tools: [{ name: 'list_merge_requests' }],
            resources: [],
          },
        })
      }
      if (url === '/mcp/gitlab/auth' && method === 'POST') {
        return jsonResponse({ authorizationUrl: 'https://auth.example/callback' })
      }
      if (url === '/mcp/gitlab/health') {
        return jsonResponse({ ok: true, checkedAt: '2026-04-25T00:00:00.000Z' })
      }
      if (url === '/skill') {
        return jsonResponse([{ name: 'code-review', source: 'builtin' }])
      }
      return jsonResponse({})
    })

    expect(await mcpApi.list()).toEqual([
      {
        name: 'gitlab',
        status: 'connected',
        error: undefined,
        tools: [{ name: 'list_merge_requests' }],
        resources: [],
        health: undefined,
      },
    ])
    await mcpApi.add('gitlab', { type: 'remote', url: 'https://gitlab.example/mcp', enabled: true })
    await mcpApi.remove('gitlab')
    await mcpApi.connect('gitlab')
    await mcpApi.disconnect('gitlab')
    expect(await mcpApi.startAuth('gitlab')).toEqual({ url: 'https://auth.example/callback' })
    await mcpApi.removeAuth('gitlab')
    expect(await mcpApi.health('gitlab')).toEqual({ ok: true, checkedAt: '2026-04-25T00:00:00.000Z' })
    expect(await skillApi.list()).toEqual([{ name: 'code-review', source: 'builtin' }])

    expect(callSummary()).toEqual([
      ['GET', '/mcp'],
      ['POST', '/mcp'],
      ['DELETE', '/mcp/gitlab'],
      ['POST', '/mcp/gitlab/connect'],
      ['POST', '/mcp/gitlab/disconnect'],
      ['POST', '/mcp/gitlab/auth'],
      ['DELETE', '/mcp/gitlab/auth'],
      ['POST', '/mcp/gitlab/health'],
      ['GET', '/skill'],
    ])
    expect(calls[1].body).toEqual({
      name: 'gitlab',
      config: { type: 'remote', url: 'https://gitlab.example/mcp', enabled: true },
    })
  })

  it('keeps provider, auth, and config operations on existing settings endpoints', async () => {
    const customProvider: CustomProvider = {
      name: 'Local',
      protocol: 'openai',
      baseURL: 'http://localhost:11434/v1',
      models: [{ id: 'local-model' }],
    }

    installFetchMock((url, init) => {
      const method = init?.method || 'GET'
      if (url === '/provider') {
        return jsonResponse({
          all: [
            {
              id: 'openai',
              name: 'OpenAI',
              models: {
                gpt: { id: 'gpt-5', name: 'GPT-5', context: 128000, maxOutput: 8192 },
              },
            },
          ],
          default: { openai: 'gpt-5' },
          connected: ['openai'],
        })
      }
      if (url === '/provider/auth') {
        return jsonResponse({
          openai: [{ type: 'apiKey', name: 'API Key' }, { type: 'oauth', name: 'OAuth' }],
        })
      }
      if (url === '/provider/openai/oauth/authorize') {
        return jsonResponse({ authorizationUrl: 'https://provider.example/oauth' })
      }
      if (url === '/config/nine1bot') {
        return jsonResponse({ model: 'openai/gpt-5', configPath: 'nine1bot.config.jsonc' })
      }
      if (url === '/config/nine1bot/custom-providers' && method === 'GET') {
        return jsonResponse({ local: customProvider })
      }
      if (url === '/config') {
        return jsonResponse({ model: 'openai/gpt-5' })
      }
      if (url === '/auth' && method === 'GET') {
        return jsonResponse(['openai'])
      }
      if (url === '/auth/import/opencode') {
        return jsonResponse({
          sourceFound: true,
          imported: ['openai'],
          skippedExisting: [],
          skippedInvalid: [],
          totalSource: 1,
        })
      }
      return jsonResponse({})
    })

    expect(await providerApi.list()).toEqual({
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          authenticated: true,
          models: [{ id: 'gpt-5', name: 'GPT-5', contextWindow: 128000, maxOutputTokens: 8192 }],
        },
      ],
      defaults: { openai: 'gpt-5' },
      connected: ['openai'],
    })
    expect(await providerApi.getAuthMethods()).toEqual({
      openai: [{ type: 'api', name: 'API Key' }, { type: 'oauth', name: 'OAuth' }],
    })
    expect(await providerApi.startOAuth('openai', 1)).toEqual({ url: 'https://provider.example/oauth' })
    await providerApi.completeOAuth('openai', 'code-123', 1)
    expect(await nine1botConfigApi.get()).toEqual({ model: 'openai/gpt-5', configPath: 'nine1bot.config.jsonc' })
    await nine1botConfigApi.update({ model: 'openai/gpt-5' })
    expect(await customProviderApi.list()).toEqual({ local: customProvider })
    await customProviderApi.upsert('local/custom', customProvider)
    await customProviderApi.remove('local/custom')
    expect(await configApi.get()).toEqual({ model: 'openai/gpt-5' })
    expect(await configApi.update({ model: 'openai/gpt-5' })).toEqual({ model: 'openai/gpt-5' })
    expect(await authApi.list()).toEqual(['openai'])
    await authApi.setApiKey('openai', 'sk-test')
    await authApi.remove('openai')
    expect(await importAuthFromOpencode()).toEqual({
      sourceFound: true,
      imported: ['openai'],
      skippedExisting: [],
      skippedInvalid: [],
      totalSource: 1,
    })

    expect(callSummary()).toEqual([
      ['GET', '/provider'],
      ['GET', '/provider/auth'],
      ['POST', '/provider/openai/oauth/authorize'],
      ['POST', '/provider/openai/oauth/callback'],
      ['GET', '/config/nine1bot'],
      ['PATCH', '/config/nine1bot'],
      ['GET', '/config/nine1bot/custom-providers'],
      ['PUT', '/config/nine1bot/custom-providers/local%2Fcustom'],
      ['DELETE', '/config/nine1bot/custom-providers/local%2Fcustom'],
      ['GET', '/config'],
      ['PATCH', '/config'],
      ['GET', '/auth'],
      ['PUT', '/auth/openai'],
      ['DELETE', '/auth/openai'],
      ['POST', '/auth/import/opencode'],
    ])
    expect(calls[3].body).toEqual({ method: 1, code: 'code-123' })
    expect(calls[5].body).toEqual({ model: 'openai/gpt-5' })
    expect(calls[7].body).toEqual(customProvider)
    expect(calls[12].body).toEqual({ type: 'api', key: 'sk-test' })
  })

  it('keeps provider and auth operations in the active project directory', async () => {
    setApiDirectory('D:/workspace/active project')
    installFetchMock((url) => {
      if (url.startsWith('/provider')) {
        return jsonResponse({ all: [], default: {}, connected: [] })
      }
      if (url.startsWith('/auth')) {
        return jsonResponse([])
      }
      return jsonResponse({})
    })

    await providerApi.list()
    await providerApi.getAuthMethods()
    await providerApi.startOAuth('local-provider')
    await providerApi.completeOAuth('local-provider', 'code')
    await authApi.list()
    await authApi.setApiKey('local-provider', 'secret')
    await authApi.remove('local-provider')
    await importAuthFromOpencode()

    expect(calls).toHaveLength(8)
    expect(calls.every((call) => call.directory === 'D:/workspace/active project')).toBe(true)
  })

  it('keeps preferences operations on preferences endpoints', async () => {
    installFetchMock((url, init) => {
      const method = init?.method || 'GET'
      if (url === '/preferences' && method === 'GET') {
        return jsonResponse({
          preferences: [{ id: 'pref_1', content: 'Use concise replies', source: 'user', createdAt: 1, scope: 'global' }],
          global: [{ id: 'pref_1', content: 'Use concise replies', source: 'user', createdAt: 1, scope: 'global' }],
          project: [],
        })
      }
      if (url === '/preferences' && method === 'POST') {
        return jsonResponse({ id: 'pref_2', content: 'Prefer tests', source: 'user', createdAt: 2, scope: 'project' })
      }
      if (url === '/preferences/pref_2' && method === 'PATCH') {
        return jsonResponse({ id: 'pref_2', content: 'Prefer focused tests', source: 'user', createdAt: 2, scope: 'project' })
      }
      if (url === '/preferences/prompt') {
        return jsonResponse({ prompt: 'User preferences prompt' })
      }
      return jsonResponse({})
    })

    expect(await preferencesApi.list()).toEqual({
      preferences: [{ id: 'pref_1', content: 'Use concise replies', source: 'user', createdAt: 1, scope: 'global' }],
      global: [{ id: 'pref_1', content: 'Use concise replies', source: 'user', createdAt: 1, scope: 'global' }],
      project: [],
    })
    expect(await preferencesApi.add('Prefer tests', 'project')).toEqual({
      id: 'pref_2',
      content: 'Prefer tests',
      source: 'user',
      createdAt: 2,
      scope: 'project',
    })
    expect(await preferencesApi.update('pref_2', 'Prefer focused tests')).toEqual({
      id: 'pref_2',
      content: 'Prefer focused tests',
      source: 'user',
      createdAt: 2,
      scope: 'project',
    })
    expect(await preferencesApi.delete('pref_2')).toBe(true)
    expect(await preferencesApi.getPrompt()).toBe('User preferences prompt')

    expect(callSummary()).toEqual([
      ['GET', '/preferences'],
      ['POST', '/preferences'],
      ['PATCH', '/preferences/pref_2'],
      ['DELETE', '/preferences/pref_2'],
      ['GET', '/preferences/prompt'],
    ])
    expect(calls[1].body).toEqual({ content: 'Prefer tests', scope: 'project', source: 'user' })
    expect(calls[2].body).toEqual({ content: 'Prefer focused tests' })
  })

  it('uses browser extension config endpoints for side panel defaults', async () => {
    installFetchMock((url, init) => {
      const method = init?.method || 'GET'
      if (url === '/config/nine1bot/browser-extension' && method === 'GET') {
        return jsonResponse({
          model: { providerID: 'openai', modelID: 'gpt-5' },
          prompt: 'Use browser context.',
          mcpServers: ['filesystem'],
          skills: ['browser-review'],
        })
      }
      if (url === '/config/nine1bot/browser-extension' && method === 'PATCH') {
        return jsonResponse({
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4.5' },
          mcpServers: ['gitlab'],
        })
      }
      return jsonResponse({})
    })

    expect(await nine1botConfigApi.getBrowserExtension()).toEqual({
      model: { providerID: 'openai', modelID: 'gpt-5' },
      prompt: 'Use browser context.',
      mcpServers: ['filesystem'],
      skills: ['browser-review'],
    })
    expect(await nine1botConfigApi.updateBrowserExtension({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4.5' },
      prompt: null,
      mcpServers: ['gitlab'],
      skills: [],
    })).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4.5' },
      mcpServers: ['gitlab'],
    })

    expect(callSummary()).toEqual([
      ['GET', '/config/nine1bot/browser-extension'],
      ['PATCH', '/config/nine1bot/browser-extension'],
    ])
    expect(calls[1].body).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4.5' },
      prompt: null,
      mcpServers: ['gitlab'],
      skills: [],
    })
  })

  it('uses platform manager endpoints for platform adapter settings', async () => {
    installFetchMock((url, init) => {
      const method = init?.method || 'GET'
      if (url === '/nine1bot/platforms' && method === 'GET') {
        return jsonResponse({
          platforms: [{
            id: 'gitlab',
            name: 'GitLab',
            packageName: '@nine1bot/platform-gitlab',
            enabled: true,
            registered: true,
            status: 'available',
            lifecycleStatus: 'healthy',
            capabilities: { pageContext: true },
          }],
        })
      }
      if (url === '/nine1bot/platforms/gitlab' && method === 'GET') {
        return jsonResponse({
          id: 'gitlab',
          name: 'GitLab',
          packageName: '@nine1bot/platform-gitlab',
          enabled: true,
          registered: true,
          status: 'available',
          lifecycleStatus: 'healthy',
          capabilities: { pageContext: true },
          descriptor: {
            id: 'gitlab',
            name: 'GitLab',
            packageName: '@nine1bot/platform-gitlab',
            version: '0.1.0',
            capabilities: { pageContext: true },
          },
          actions: [{ id: 'connection.test', label: 'Test connection', kind: 'button' }],
          features: {},
          settings: {
            token: { redacted: true, hasValue: true, provider: 'nine1bot-local' },
          },
          runtimeStatus: { status: 'available' },
        })
      }
      if (url === '/nine1bot/platforms/gitlab' && method === 'PATCH') {
        return jsonResponse({
          id: 'gitlab',
          name: 'GitLab',
          packageName: '@nine1bot/platform-gitlab',
          enabled: false,
          registered: false,
          status: 'disabled',
          lifecycleStatus: 'disabled',
          capabilities: { pageContext: true },
          descriptor: {
            id: 'gitlab',
            name: 'GitLab',
            packageName: '@nine1bot/platform-gitlab',
            version: '0.1.0',
            capabilities: { pageContext: true },
          },
          actions: [],
          features: {},
          settings: {},
          runtimeStatus: { status: 'disabled' },
        })
      }
      if (url === '/nine1bot/platforms/gitlab/health' && method === 'POST') {
        return jsonResponse({ runtimeStatus: { status: 'available' } })
      }
      if (url === '/nine1bot/platforms/gitlab/actions/connection.test' && method === 'POST') {
        return jsonResponse({ status: 'failed', message: 'Action is not implemented: connection.test' })
      }
      return jsonResponse({})
    })

    expect(await platformApi.list()).toEqual([
      expect.objectContaining({ id: 'gitlab', status: 'available' }),
    ])
    expect(await platformApi.get('gitlab')).toMatchObject({
      id: 'gitlab',
      settings: {
        token: { redacted: true, hasValue: true, provider: 'nine1bot-local' },
      },
    })
    expect(await platformApi.update('gitlab', {
      enabled: false,
      settings: {
        token: null,
      },
    })).toMatchObject({ id: 'gitlab', enabled: false })
    expect(await platformApi.health('gitlab')).toEqual({ runtimeStatus: { status: 'available' } })
    expect(await platformApi.action('gitlab', 'connection.test')).toEqual({
      status: 'failed',
      message: 'Action is not implemented: connection.test',
    })

    expect(callSummary()).toEqual([
      ['GET', '/nine1bot/platforms'],
      ['GET', '/nine1bot/platforms/gitlab'],
      ['PATCH', '/nine1bot/platforms/gitlab'],
      ['POST', '/nine1bot/platforms/gitlab/health'],
      ['POST', '/nine1bot/platforms/gitlab/actions/connection.test'],
    ])
    expect(calls[2].body).toEqual({
      enabled: false,
      settings: {
        token: null,
      },
    })
    expect(calls[4].body).toEqual({})
  })

  it('surfaces platform field errors from the platform manager api', async () => {
    installFetchMock((url, init) => {
      if (url === '/nine1bot/platforms/gitlab' && init?.method === 'PATCH') {
        return jsonResponse({
          error: 'Invalid platform config',
          fieldErrors: { apiEnrichment: 'Must be one of: auto, disabled' },
        }, 400)
      }
      return jsonResponse({})
    })

    try {
      await platformApi.update('gitlab', {
        settings: { apiEnrichment: 'bad' },
      })
      throw new Error('Expected platform update to fail')
    } catch (error: any) {
      expect(error.message).toBe('Invalid platform config')
      expect(error.fieldErrors).toEqual({ apiEnrichment: 'Must be one of: auto, disabled' })
    }
  })
})
