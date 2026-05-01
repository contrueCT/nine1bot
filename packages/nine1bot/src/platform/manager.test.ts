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
      contributions: [contribution('demo', { defaultEnabled: true })],
      config: {
        demo: {
          enabled: false,
        },
      },
    })

    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list()).toEqual([])
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
      gitlab: {
        enabled: false,
      },
    })

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('gitlab')
  })

  it('keeps the GitLab compatibility registration entry working', () => {
    registerGitLabPlatformAdapter()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('gitlab')
  })
})
