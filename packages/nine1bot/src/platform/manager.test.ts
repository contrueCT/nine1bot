import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { PlatformAdapterContext, PlatformAdapterContribution, PlatformSecretAccess } from '@nine1bot/platform-protocol'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'
import { PlatformAdapterManager } from './manager'
import { registerBuiltinPlatformAdapters, resetBuiltinPlatformManagerForTesting } from './builtin'
import { registerGitLabPlatformAdapter } from './gitlab'

function resetPlatformState() {
  resetBuiltinPlatformManagerForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
}

beforeEach(resetPlatformState)
afterEach(resetPlatformState)

function contribution(id: string, options: {
  defaultEnabled?: boolean
  throws?: boolean
  templates?: string[]
} = {}): PlatformAdapterContribution {
  return {
    descriptor: {
      id,
      name: id,
      packageName: `@nine1bot/platform-${id}`,
      version: '0.1.0',
      defaultEnabled: options.defaultEnabled,
      capabilities: {
        pageContext: true,
        templates: options.templates,
      },
    },
    runtime: {
      createAdapter() {
        if (options.throws) {
          throw new Error(`${id} failed`)
        }
        return {
          id,
        }
      },
    },
  }
}

function memorySecrets() {
  const values = new Map<string, string>()
  const access: PlatformSecretAccess = {
    async get(ref) {
      return ref.provider === 'nine1bot-local' ? values.get(ref.key) : undefined
    },
    async set(ref, value) {
      if (ref.provider === 'nine1bot-local') values.set(ref.key, value)
    },
    async delete(ref) {
      if (ref.provider === 'nine1bot-local') values.delete(ref.key)
    },
    async has(ref) {
      return ref.provider === 'nine1bot-local' && values.has(ref.key)
    },
  }
  return { access, values }
}

describe('PlatformAdapterManager', () => {
  it('registers default-enabled contributions', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', { defaultEnabled: true })],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toEqual(['demo'])
    expect(manager.get('demo')).toMatchObject({
      enabled: true,
      registered: true,
      lifecycleStatus: 'healthy',
      runtimeStatus: {
        status: 'available',
      },
    })
  })

  it('skips explicitly disabled contributions', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', { defaultEnabled: true, templates: ['browser-demo'] })],
      config: {
        demo: {
          enabled: false,
        },
      },
    })

    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list()).toEqual([])
    expect(RuntimePlatformAdapterRegistry.listDisabled()).toEqual([
      expect.objectContaining({
        id: 'demo',
        reason: 'platform-disabled-by-current-config',
        templateIds: ['browser-demo'],
      }),
    ])
    expect(RuntimePlatformAdapterRegistry.activeTemplateIds(['web-chat', 'browser-demo'])).toEqual(['web-chat'])
    expect(manager.get('demo')).toMatchObject({
      enabled: false,
      registered: false,
      lifecycleStatus: 'disabled',
      runtimeStatus: {
        status: 'disabled',
      },
    })
  })

  it('keeps repeated registration idempotent', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', { defaultEnabled: true })],
    })

    manager.registerRuntimeAdapters()
    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toEqual(['demo'])
    expect(manager.get('demo')?.registered).toBe(true)
  })

  it('records adapter creation failures without blocking other contributions', () => {
    const manager = new PlatformAdapterManager({
      contributions: [
        contribution('bad', { defaultEnabled: true, throws: true }),
        contribution('good', { defaultEnabled: true }),
      ],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toEqual(['good'])
    expect(manager.get('bad')).toMatchObject({
      registered: false,
      lifecycleStatus: 'error',
      runtimeStatus: {
        status: 'error',
        message: 'bad failed',
      },
      error: 'bad failed',
    })
    expect(manager.get('good')).toMatchObject({
      registered: true,
      lifecycleStatus: 'healthy',
    })
  })

  it('passes configured settings, features, and secrets into adapter context', async () => {
    let capturedContext: PlatformAdapterContext | undefined
    const secrets: PlatformSecretAccess = {
      async get() {
        return 'secret-value'
      },
      async set() {},
      async delete() {},
      async has() {
        return true
      },
    }
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        runtime: {
          createAdapter(context) {
            capturedContext = context
            return {
              id: 'demo',
            }
          },
        },
      }],
      config: {
        demo: {
          enabled: true,
          features: {
            pageContext: false,
          },
          settings: {
            allowedHosts: ['gitlab.com'],
          },
        },
      },
      secrets,
    })

    manager.registerRuntimeAdapters()

    expect(capturedContext?.features).toEqual({
      pageContext: false,
    })
    expect(capturedContext?.settings).toEqual({
      allowedHosts: ['gitlab.com'],
    })
    expect(await capturedContext?.secrets.get({
      provider: 'nine1bot-local',
      key: 'demo',
    })).toBe('secret-value')
  })

  it('registers built-in GitLab through the manager', () => {
    registerBuiltinPlatformAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('gitlab')
  })

  it('skips built-in GitLab when config disables it', () => {
    registerBuiltinPlatformAdapters({
      config: {
        gitlab: {
          enabled: false,
        },
      },
    })

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('gitlab')
  })

  it('keeps the GitLab compatibility registration entry working', () => {
    registerGitLabPlatformAdapter()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('gitlab')
  })

  it('returns summaries and redacted details', async () => {
    const secrets = memorySecrets()
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        descriptor: {
          ...contribution('demo', { defaultEnabled: true }).descriptor,
          config: {
            sections: [{
              id: 'auth',
              title: 'Auth',
              fields: [{
                key: 'token',
                label: 'Token',
                type: 'password',
                secret: true,
              }],
            }],
          },
        },
      }],
      config: {
        demo: {
          settings: {
            token: {
              provider: 'nine1bot-local',
              key: 'platform:demo:default:token',
            },
          },
        },
      },
      secrets: secrets.access,
    })
    await secrets.access.set({
      provider: 'nine1bot-local',
      key: 'platform:demo:default:token',
    }, 'secret-value')
    manager.registerRuntimeAdapters()

    expect(manager.listSummaries()[0]).toMatchObject({
      id: 'demo',
      enabled: true,
      registered: true,
      status: 'available',
    })
    await expect(manager.getDetail('demo')).resolves.toMatchObject({
      id: 'demo',
      settings: {
        token: {
          redacted: true,
          hasValue: true,
          provider: 'nine1bot-local',
        },
      },
    })
  })

  it('updates config and re-registers runtime adapters', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', { defaultEnabled: true, templates: ['browser-demo'] })],
    })
    manager.registerRuntimeAdapters()
    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('demo')

    await manager.updateConfig('demo', { enabled: false })

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('demo')
    expect(RuntimePlatformAdapterRegistry.isDisabled('demo')).toBe(true)
    expect(manager.get('demo')).toMatchObject({
      enabled: false,
      registered: false,
      lifecycleStatus: 'disabled',
    })

    await manager.updateConfig('demo', { enabled: true })

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('demo')
    expect(RuntimePlatformAdapterRegistry.isDisabled('demo')).toBe(false)
    expect(manager.get('demo')).toMatchObject({
      enabled: true,
      registered: true,
      lifecycleStatus: 'healthy',
    })
  })

  it('rejects invalid config without changing manager config', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        validateConfig: async () => ({
          ok: false,
          message: 'bad config',
          fieldErrors: {
            token: 'invalid',
          },
        }),
      }],
      config: {
        demo: {
          enabled: true,
        },
      },
    })

    await expect(manager.updateConfig('demo', {
      settings: {
        token: 'bad',
      },
    })).rejects.toThrow('bad config')
    expect(manager.configSnapshot().demo?.settings).toEqual({})
  })

  it('stores secret config fields as secret refs and redacts detail output', async () => {
    const secrets = memorySecrets()
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        descriptor: {
          ...contribution('demo', { defaultEnabled: true }).descriptor,
          config: {
            sections: [{
              id: 'auth',
              title: 'Auth',
              fields: [{
                key: 'token',
                label: 'Token',
                type: 'password',
                secret: true,
              }],
            }],
          },
        },
      }],
      secrets: secrets.access,
    })

    await manager.updateConfig('demo', {
      settings: {
        token: 'secret-value',
      },
    })

    expect(manager.configSnapshot().demo?.settings?.token).toEqual({
      provider: 'nine1bot-local',
      key: 'platform:demo:default:token',
    })
    await expect(secrets.access.get({
      provider: 'nine1bot-local',
      key: 'platform:demo:default:token',
    })).resolves.toBe('secret-value')
    await expect(manager.getDetail('demo')).resolves.toMatchObject({
      settings: {
        token: {
          redacted: true,
          hasValue: true,
        },
      },
    })
  })

  it('treats null setting patch values as field clears', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', { defaultEnabled: true })],
      config: {
        demo: {
          enabled: true,
          settings: {
            apiEnrichment: 'auto',
            allowedHosts: ['gitlab.com'],
          },
        },
      },
    })

    await manager.updateConfig('demo', {
      settings: {
        apiEnrichment: null,
      },
    })

    expect(manager.configSnapshot().demo?.settings).toEqual({
      allowedHosts: ['gitlab.com'],
    })
  })

  it('guards platform actions by descriptor and confirmation', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        descriptor: {
          ...contribution('demo', { defaultEnabled: true }).descriptor,
          actions: [{
            id: 'danger.reset',
            label: 'Reset',
            kind: 'button',
            danger: true,
          }],
        },
        handleAction: async () => ({
          status: 'ok',
          message: 'done',
        }),
      }],
    })
    manager.registerRuntimeAdapters()

    await expect(manager.executeAction('demo', 'missing')).rejects.toThrow('Platform action not found')
    await expect(manager.executeAction('demo', 'danger.reset')).rejects.toThrow('requires confirmation')
    await expect(manager.executeAction('demo', 'danger.reset', { confirm: true })).resolves.toEqual({
      status: 'ok',
      message: 'done',
    })
  })

  it('turns handler action failures into failed results and error status', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        descriptor: {
          ...contribution('demo', { defaultEnabled: true }).descriptor,
          actions: [{
            id: 'connection.test',
            label: 'Test',
            kind: 'button',
          }],
        },
        handleAction: async () => {
          throw new Error('connection failed')
        },
      }],
    })
    manager.registerRuntimeAdapters()

    await expect(manager.executeAction('demo', 'connection.test')).resolves.toMatchObject({
      status: 'failed',
      message: 'connection failed',
    })
    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'error',
      runtimeStatus: {
        status: 'error',
        message: 'connection failed',
      },
    })
  })
})
