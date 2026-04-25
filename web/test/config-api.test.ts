import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  authApi,
  configApi,
  customProviderApi,
  importAuthFromOpencode,
  mcpApi,
  nine1botConfigApi,
  preferencesApi,
  providerApi,
  setApiDirectory,
  skillApi,
  type CustomProvider,
} from '../src/api/client'

type FetchCall = {
  url: string
  method: string
  body?: unknown
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
    calls.push({ url, method, body })
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
})
