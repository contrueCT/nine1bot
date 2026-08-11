import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { join, normalize, win32 as win32Path } from 'node:path'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import type {
  AnyPlatformToolDefinition,
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformBackgroundService,
  PlatformRuntimeSourcesDescriptor,
  PlatformRuntimeSourcesProvider,
  PlatformRuntimeToolsProvider,
  PlatformSecretAccess,
  PlatformSecretRef,
} from '@nine1bot/platform-protocol'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'
import { RuntimeSourceRegistry } from '../../../../opencode/packages/opencode/src/runtime/source/registry'
import { RuntimeToolRegistry } from '../../../../opencode/packages/opencode/src/runtime/tool/registry'
import { PlatformAdapterManager } from './manager'
import { getBuiltinPlatformManager, registerBuiltinPlatformAdapters, resetBuiltinPlatformManagerForTesting } from './builtin'
import { registerGitLabPlatformAdapter } from './gitlab'

function resetPlatformState() {
  resetBuiltinPlatformManagerForTesting()
  RuntimePlatformAdapterRegistry.clearForTesting()
  RuntimeSourceRegistry.clearForTesting()
  RuntimeToolRegistry.clearForTesting()
}

beforeEach(resetPlatformState)
afterEach(resetPlatformState)

function contribution(id: string, options: {
  defaultEnabled?: boolean
  throws?: boolean
    templates?: string[]
    sources?: PlatformRuntimeSourcesProvider
    tools?: PlatformRuntimeToolsProvider
    createAdapter?: NonNullable<PlatformAdapterContribution['runtime']>['createAdapter']
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
      createAdapter(context) {
        if (options.throws) {
          throw new Error(`${id} failed`)
        }
        if (options.createAdapter) return options.createAdapter(context)
        return {
          id,
        }
      },
      sources: options.sources,
      tools: options.tools,
    },
  }
}

function toolDefinition(
  id = 'demo_lookup',
  options: Partial<AnyPlatformToolDefinition> = {},
): AnyPlatformToolDefinition {
  return {
    id,
    description: `Use ${id}`,
    catalogVisibility: 'user-selectable',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
    },
    parse(input) {
      return input
    },
    async execute() {
      return {
        status: 'ok',
        title: id,
        output: id,
      }
    },
    ...options,
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

function runtimeSources(root?: string): PlatformRuntimeSourcesDescriptor {
  return {
    agents: [{
      id: 'demo-agents',
      directory: root ? join(root, 'agents') : '/tmp/demo/agents',
      namespace: 'demo.agent',
      visibility: 'recommendable',
      lifecycle: 'platform-enabled',
    }],
    skills: [{
      id: 'demo-skills',
      directory: root ? join(root, 'skills') : '/tmp/demo/skills',
      namespace: 'demo.skill',
      visibility: 'declared-only',
      lifecycle: 'platform-enabled',
    }],
  }
}

async function withRuntimeSourceDirectories<T>(
  run: (paths: { root: string; agents: string; skills: string }) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'nine1bot-runtime-sources-'))
  const agents = join(root, 'agents')
  const skills = join(root, 'skills')
  await mkdir(agents)
  await mkdir(skills)
  try {
    return await run({ root, agents, skills })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function backgroundContribution(
  id: string,
  options: {
    defaultEnabled?: boolean
    getStatus?: (startNumber: number) => { status: 'available' | 'degraded' | 'error' | 'disabled'; message?: string }
    handleAction?: PlatformAdapterContribution['handleAction']
    config?: PlatformAdapterContribution['descriptor']['config']
    actions?: PlatformAdapterContribution['descriptor']['actions']
  } = {},
) {
  let starts = 0
  let stops = 0
  const service: PlatformBackgroundService = {
    id: `${id}-background`,
    async start() {
      starts += 1
      const startNumber = starts
      return {
        async stop() {
          stops += 1
        },
        getStatus() {
          return options.getStatus?.(startNumber) ?? {
            status: 'available',
            message: `background run ${startNumber}`,
          }
        },
      }
    },
  }

  return {
    contribution: {
      ...contribution(id, { defaultEnabled: options.defaultEnabled }),
      descriptor: {
        ...contribution(id, { defaultEnabled: options.defaultEnabled }).descriptor,
        config: options.config,
        actions: options.actions,
      },
      backgroundServices: () => [service],
      handleAction: options.handleAction,
    } satisfies PlatformAdapterContribution,
    counts: {
      get starts() {
        return starts
      },
      get stops() {
        return stops
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

  it('registers adapter, sources, and tools in one successful snapshot', async () => {
    await withRuntimeSourceDirectories(async ({ root }) => {
      let providerCalls = 0
      let availabilityChecks = 0
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: runtimeSources(root),
          tools: () => {
            providerCalls += 1
            return [toolDefinition('demo_lookup', {
              availability() {
                availabilityChecks += 1
                return { status: 'available' }
              },
            })]
          },
        })],
      })

      manager.registerRuntimeAdapters()

      expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('demo')
      expect(RuntimeSourceRegistry.listOwner('demo').owner?.enabled).toBe(true)
      expect(RuntimeToolRegistry.get('demo_lookup')).toMatchObject({
        ownerID: 'demo',
        generation: 1,
      })
      expect(await manager.getDetail('demo')).toMatchObject({
        desiredConfigRevision: 1,
        appliedConfigRevision: 1,
        runtimeTools: [{
          id: 'demo_lookup',
          ownerId: 'demo',
          status: 'registered',
          generation: 1,
        }],
      })
      expect(providerCalls).toBe(1)
      expect(availabilityChecks).toBe(0)
    })
  })

  it('publishes nothing when first tool preparation fails', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
        tools: () => [toolDefinition('wrong_lookup')],
      })],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('demo')
    expect(RuntimeSourceRegistry.listOwner('demo').owner).toBeUndefined()
    expect(RuntimeToolRegistry.listOwner('demo').tools).toEqual([])
    expect(manager.get('demo')).toMatchObject({
      registered: false,
      lifecycleStatus: 'error',
      desiredConfigRevision: 1,
      appliedConfigRevision: undefined,
    })
  })

  it('reloads a changed config once and keeps byte-equivalent configure calls idempotent', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        tools: (context) => [toolDefinition('demo_lookup', {
          description: `lookup ${String((context.settings as Record<string, unknown>).version ?? 'one')}`,
        })],
      })],
      config: {
        demo: {
          enabled: true,
          settings: { version: 'one' },
        },
      },
    })
    manager.registerRuntimeAdapters()
    const first = RuntimeToolRegistry.get('demo_lookup')

    const updated = await manager.updateConfig('demo', {
      settings: { version: 'two' },
    })
    const second = RuntimeToolRegistry.get('demo_lookup')

    expect(first?.generation).toBe(1)
    expect(second?.generation).toBe(2)
    expect(second?.definition).not.toBe(first?.definition)
    expect(updated).toMatchObject({
      desiredConfigRevision: 2,
      appliedConfigRevision: 2,
    })

    const snapshot = manager.configSnapshot()
    expect(manager.configure(snapshot)).toBe(false)
    manager.registerRuntimeAdapters()
    expect(RuntimeToolRegistry.get('demo_lookup')?.generation).toBe(2)
  })

  it('keeps the applied adapter, sources, and tool when a reload cannot be prepared', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        createAdapter(context) {
          const version = String((context.settings as Record<string, unknown>).version ?? 'one')
          return {
            id: 'demo',
            recommendedAgent: () => version,
          }
        },
        sources: (context) => ({
          skills: [{
            id: 'demo-skills',
            directory: `/tmp/${String((context.settings as Record<string, unknown>).version ?? 'one')}`,
            visibility: 'declared-only',
            lifecycle: 'platform-enabled',
          }],
        }),
        tools: (context) => {
          const settings = context.settings as Record<string, unknown>
          return [toolDefinition(settings.fail ? 'wrong_lookup' : 'demo_lookup')]
        },
      })],
      config: {
        demo: {
          settings: { version: 'one' },
        },
      },
    })
    manager.registerRuntimeAdapters()
    const adapter = RuntimePlatformAdapterRegistry.list().find((item) => item.id === 'demo')
    const source = RuntimeSourceRegistry.listOwner('demo').skills[0]
    const tool = RuntimeToolRegistry.get('demo_lookup')

    const updated = await manager.updateConfig('demo', {
      settings: { version: 'two', fail: true },
    })

    expect(RuntimePlatformAdapterRegistry.list().find((item) => item.id === 'demo')).toBe(adapter)
    expect(RuntimeSourceRegistry.listOwner('demo').skills[0]).toEqual(source)
    expect(RuntimeToolRegistry.get('demo_lookup')?.definition).toBe(tool?.definition)
    expect(RuntimeToolRegistry.get('demo_lookup')?.generation).toBe(1)
    expect(updated).toMatchObject({
      registered: true,
      lifecycleStatus: 'degraded',
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })
    expect(manager.configSnapshot().demo?.settings).toMatchObject({ version: 'two', fail: true })
  })

  it('keeps a retained runtime degraded when status refresh follows a failed reload', async () => {
    const statusSettings: string[] = []
    const base = contribution('demo', {
      defaultEnabled: true,
      tools(context) {
        const settings = context.settings as Record<string, unknown>
        if (settings.fail === true) throw new Error('fixture reload failed')
        return [toolDefinition()]
      },
    })
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...base,
        async getStatus(context) {
          statusSettings.push(String((context.settings as Record<string, unknown>).version))
          return { status: 'available' }
        },
      }],
      config: {
        demo: {
          settings: { version: 'one' },
        },
      },
    })
    manager.registerRuntimeAdapters()

    await manager.updateConfig('demo', {
      settings: { version: 'two', fail: true },
    })
    const refreshed = await manager.refreshStatus('demo')

    expect(refreshed.status).toBe('degraded')
    expect(statusSettings).toEqual([])
    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'degraded',
      runtimeStatus: { status: 'degraded' },
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })
  })

  it('does not let an in-flight old status refresh overwrite a failed reload', async () => {
    let releaseStatus: (() => void) | undefined
    let statusStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      statusStarted = resolve
    })
    const base = contribution('demo', {
      defaultEnabled: true,
      tools(context) {
        const settings = context.settings as Record<string, unknown>
        if (settings.fail === true) throw new Error('fixture reload failed')
        return [toolDefinition()]
      },
    })
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...base,
        async getStatus() {
          statusStarted?.()
          await new Promise<void>((resolve) => {
            releaseStatus = resolve
          })
          return { status: 'available' }
        },
      }],
      config: {
        demo: {
          settings: { version: 'one' },
        },
      },
    })
    manager.registerRuntimeAdapters()

    const refreshing = manager.refreshStatus('demo')
    await started
    await manager.updateConfig('demo', {
      settings: { version: 'two', fail: true },
    })
    expect(manager.get('demo')?.runtimeStatus.status).toBe('degraded')

    releaseStatus?.()
    const refreshed = await refreshing

    expect(refreshed.status).toBe('degraded')
    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'degraded',
      runtimeStatus: { status: 'degraded' },
      settings: { version: 'two', fail: true },
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })
    expect(manager.configSnapshot().demo?.settings).toMatchObject({ version: 'two', fail: true })
  })

  it('does not let an action status mask a failed runtime settings reload', async () => {
    const base = contribution('demo', {
      defaultEnabled: true,
      tools: (context) => [
        toolDefinition((context.settings as Record<string, unknown>).fail ? 'wrong_lookup' : 'demo_lookup'),
      ],
    })
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...base,
        descriptor: {
          ...base.descriptor,
          actions: [{ id: 'settings.apply', label: 'Apply', kind: 'button' }],
        },
        async handleAction() {
          return {
            status: 'ok',
            updatedSettings: { fail: true },
            updatedStatus: { status: 'available', message: 'stale action status' },
          }
        },
      }],
    })
    manager.registerRuntimeAdapters()

    await manager.executeAction('demo', 'settings.apply')

    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'degraded',
      runtimeStatus: { status: 'degraded' },
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })
    expect(RuntimeToolRegistry.get('demo_lookup')?.generation).toBe(1)
  })

  it('rejects asynchronous tool providers before publishing any runtime state', () => {
    const tools = (() => Promise.resolve([toolDefinition()])) as unknown as PlatformRuntimeToolsProvider
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
        tools,
      })],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimeToolRegistry.get('demo_lookup')).toBeUndefined()
    expect(RuntimePlatformAdapterRegistry.list().some((item) => item.id === 'demo')).toBe(false)
    expect(RuntimeSourceRegistry.listOwner('demo').owner).toBeUndefined()
    expect(manager.get('demo')).toMatchObject({ lifecycleStatus: 'error', registered: false })
  })

  it('retains a running background service when reload preparation fails', async () => {
    const background = backgroundContribution('demo', { defaultEnabled: true })
    const dynamic = {
      ...background.contribution,
      runtime: {
        ...background.contribution.runtime!,
        tools: (context: PlatformAdapterContext) => [
          toolDefinition((context.settings as Record<string, unknown>).fail ? 'wrong_lookup' : 'demo_lookup'),
        ],
      },
    } satisfies PlatformAdapterContribution
    const manager = new PlatformAdapterManager({
      contributions: [dynamic],
    })
    manager.registerRuntimeAdapters()
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:3000' })

    const updated = await manager.updateConfig('demo', {
      settings: { fail: true },
    })

    expect(updated.lifecycleStatus).toBe('degraded')
    expect(background.counts.starts).toBe(1)
    expect(background.counts.stops).toBe(0)
  })

  it('stops a disabled owner even when another owner has a degraded runtime snapshot', async () => {
    const alpha = backgroundContribution('alpha', { defaultEnabled: true })
    const beta = backgroundContribution('beta', { defaultEnabled: true })
    const manager = new PlatformAdapterManager({
      contributions: [
        {
          ...alpha.contribution,
          runtime: {
            ...alpha.contribution.runtime!,
            tools: (context: PlatformAdapterContext) => [
              toolDefinition(
                (context.settings as Record<string, unknown>).fail
                  ? 'wrong_lookup'
                  : 'alpha_lookup',
              ),
            ],
          },
        },
        beta.contribution,
      ],
    })
    manager.registerRuntimeAdapters()
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:3000' })

    await manager.updateConfig('alpha', { settings: { fail: true } })
    expect(manager.get('alpha')).toMatchObject({ lifecycleStatus: 'degraded' })

    await manager.updateConfig('beta', { enabled: false })

    expect(alpha.counts.starts).toBe(1)
    expect(alpha.counts.stops).toBe(0)
    expect(beta.counts.starts).toBe(1)
    expect(beta.counts.stops).toBe(1)
    expect(manager.get('beta')).toMatchObject({
      enabled: false,
      lifecycleStatus: 'disabled',
    })
  })

  it('invalidates tools before awaiting background shutdown on explicit disable', async () => {
    let releaseStop: (() => void) | undefined
    let stopStarted: (() => void) | undefined
    const stopping = new Promise<void>((resolve) => {
      stopStarted = resolve
    })
    const contributionWithBlockingStop = {
      ...contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
        tools: [toolDefinition()],
      }),
      backgroundServices: () => [{
        id: 'blocking',
        async start() {
          return {
            async stop() {
              stopStarted?.()
              await new Promise<void>((resolve) => {
                releaseStop = resolve
              })
            },
          }
        },
      }],
    } satisfies PlatformAdapterContribution
    const manager = new PlatformAdapterManager({ contributions: [contributionWithBlockingStop] })
    manager.registerRuntimeAdapters()
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:3000' })

    const update = manager.updateConfig('demo', { enabled: false })
    await stopping

    const invalidatedBeforeStop = {
      tool: RuntimeToolRegistry.get('demo_lookup') === undefined,
      adapter: !RuntimePlatformAdapterRegistry.list().some((item) => item.id === 'demo'),
      sources: RuntimeSourceRegistry.listOwner('demo').owner === undefined,
    }

    releaseStop?.()
    await update
    expect(invalidatedBeforeStop).toEqual({
      tool: true,
      adapter: true,
      sources: true,
    })
    expect(await manager.getDetail('demo')).toMatchObject({
      runtimeTools: [{ id: 'demo_lookup', status: 'disabled' }],
    })
  })

  it('invalidates every runtime registry before shutdown callbacks begin', async () => {
    let stateAtStop: { tool: boolean; adapter: boolean; sources: boolean } | undefined
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', {
          defaultEnabled: true,
          sources: runtimeSources(),
          tools: [toolDefinition()],
        }),
        backgroundServices: () => [{
          id: 'observer',
          async start() {
            return {
              async stop() {
                stateAtStop = {
                  tool: RuntimeToolRegistry.get('demo_lookup') === undefined,
                  adapter: !RuntimePlatformAdapterRegistry.list().some((item) => item.id === 'demo'),
                  sources: RuntimeSourceRegistry.listOwner('demo').owner === undefined,
                }
              },
            }
          },
        }],
      }],
    })
    manager.registerRuntimeAdapters()
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:3000' })

    manager.unregisterRuntimeAdapters()
    await manager.stopBackgroundServices()

    expect(stateAtStop).toEqual({ tool: true, adapter: true, sources: true })
  })

  it('lets an already-started tool promise finish after owner reload', async () => {
    let releaseOld: (() => void) | undefined
    let oldStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve
    })
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        tools: (context) => {
          const version = String((context.settings as Record<string, unknown>).version ?? 'one')
          return [toolDefinition('demo_lookup', {
            async execute() {
              if (version === 'one') {
                oldStarted?.()
                await new Promise<void>((resolve) => {
                  releaseOld = resolve
                })
              }
              return { status: 'ok', title: version, output: version }
            },
          })]
        },
      })],
      config: {
        demo: { settings: { version: 'one' } },
      },
    })
    manager.registerRuntimeAdapters()
    const old = RuntimeToolRegistry.get('demo_lookup')
    const oldCall = old?.definition.execute({}, {
      sessionId: 'session_test',
      directory: process.cwd(),
      agent: 'build',
      templateIds: [],
      messageId: 'message_test',
      signal: new AbortController().signal,
      async reportProgress() {},
    })
    await started

    await manager.updateConfig('demo', { settings: { version: 'two' } })
    releaseOld?.()

    await expect(oldCall).resolves.toMatchObject({ status: 'ok', output: 'one' })
    expect(RuntimeToolRegistry.get('demo_lookup')?.generation).toBe(2)
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

  it('redacts tool provider failures before exposing manager diagnostics', async () => {
    const secret = 'manager-provider-secret'
    const audit: unknown[] = []
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        tools: () => {
          throw new Error(`Authorization: Bearer ${secret}`)
        },
      })],
      audit: {
        write(entry) {
          audit.push(entry)
        },
      },
    })

    manager.registerRuntimeAdapters()

    const serialized = JSON.stringify({
      record: manager.get('demo'),
      detail: await manager.getDetail('demo'),
      audit,
    })
    expect(serialized).not.toContain(secret)
    expect(serialized).toContain('[REDACTED]')
  })

  it('passes configured settings, features, and secrets into adapter context', async () => {
    let capturedContext: PlatformAdapterContext | undefined
    const packageResourcesRoot = join(process.cwd(), 'release', 'platform-resources')
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
      packageResourcesRoot,
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
    expect(capturedContext?.packageResources.root).toBe(
      normalize(join(packageResourcesRoot, 'platform-demo')),
    )
    expect(capturedContext?.packageResources.resolve('skills')).toBe(
      normalize(join(packageResourcesRoot, 'platform-demo', 'skills')),
    )
  })

  it('registers runtime sources for enabled platforms', async () => {
    await withRuntimeSourceDirectories(async ({ root, agents, skills }) => {
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: runtimeSources(root),
        })],
      })

      manager.registerRuntimeAdapters()

      expect(RuntimeSourceRegistry.listOwner('demo')).toMatchObject({
        owner: {
          id: 'demo',
          kind: 'platform',
          enabled: true,
        },
        agents: [{
          id: 'demo-agents',
          directory: agents,
          visibility: 'recommendable',
        }],
        skills: [{
          id: 'demo-skills',
          directory: skills,
          visibility: 'declared-only',
        }],
      })
      const detail = await manager.getDetail('demo')
      expect(detail?.runtimeSources).toMatchObject({
        agents: [{
          id: 'demo-agents',
          status: 'registered',
        }],
        skills: [{
          id: 'demo-skills',
          status: 'registered',
        }],
      })
      expect(detail?.runtimeSources?.agents[0]?.error).toBeUndefined()
      expect(detail?.runtimeSources?.skills[0]?.error).toBeUndefined()
    })
  })

  it('registers runtime sources generated from current platform settings', async () => {
    await withRuntimeSourceDirectories(async ({ skills }) => {
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: (ctx) => ({
            skills: [{
              id: 'demo-skills',
              directory: String((ctx.settings as Record<string, unknown>).directory ?? skills),
              visibility: 'default',
              lifecycle: 'platform-enabled',
            }],
          }),
        })],
        config: {
          demo: {
            settings: {
              directory: skills,
            },
          },
        },
      })

      manager.registerRuntimeAdapters()

      expect(RuntimeSourceRegistry.listOwner('demo').skills).toContainEqual(expect.objectContaining({
        id: 'demo-skills',
        directory: skills,
      }))
      await expect(manager.getDetail('demo')).resolves.toMatchObject({
        runtimeSources: {
          skills: [{
            id: 'demo-skills',
            directory: skills,
            status: 'registered',
          }],
        },
      })
    })
  })

  it('normalizes runtime source URLs into native paths before registering and reporting details', async () => {
    await withRuntimeSourceDirectories(async ({ agents, skills }) => {
      const agentURLPath = `/${agents.replaceAll('\\', '/')}`
      const manager = new PlatformAdapterManager({
        contributions: [contribution('feishu', {
          defaultEnabled: true,
          sources: {
            agents: [{
              id: 'feishu-agents',
              directory: agentURLPath,
              namespace: 'feishu.agent',
              visibility: 'recommendable',
              lifecycle: 'platform-enabled',
            }],
            skills: [{
              id: 'feishu-skills',
              directory: pathToFileURL(skills).href,
              namespace: 'feishu.skill',
              visibility: 'declared-only',
              lifecycle: 'platform-enabled',
            }],
          },
        })],
      })

      manager.registerRuntimeAdapters()

      const expectedAgentDirectory = normalize(agents)
      const expectedSkillDirectory = normalize(skills)

      expect(RuntimeSourceRegistry.listOwner('feishu')).toMatchObject({
        agents: [{
          id: 'feishu-agents',
          directory: expectedAgentDirectory,
        }],
        skills: [{
          id: 'feishu-skills',
          directory: expectedSkillDirectory,
        }],
      })
      await expect(manager.getDetail('feishu')).resolves.toMatchObject({
        runtimeSources: {
          agents: [{
            id: 'feishu-agents',
            directory: expectedAgentDirectory,
            status: 'registered',
          }],
          skills: [{
            id: 'feishu-skills',
            directory: expectedSkillDirectory,
            status: 'registered',
          }],
        },
      })
    })
  })

  it('normalizes Windows drive URL paths independently of the host platform', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('feishu', {
        defaultEnabled: true,
        sources: {
          agents: [{
            id: 'feishu-agents',
            directory: '/C:/nine1bot/platform-resources/platform-feishu/agents',
            namespace: 'feishu.agent',
            visibility: 'recommendable',
            lifecycle: 'platform-enabled',
          }],
          skills: [{
            id: 'feishu-skills',
            directory: 'file:///C:/nine1bot/platform-resources/platform-feishu/skills',
            namespace: 'feishu.skill',
            visibility: 'declared-only',
            lifecycle: 'platform-enabled',
          }],
        },
      })],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimeSourceRegistry.listOwner('feishu')).toMatchObject({
      agents: [{
        id: 'feishu-agents',
        directory: win32Path.normalize('C:\\nine1bot\\platform-resources\\platform-feishu\\agents'),
      }],
      skills: [{
        id: 'feishu-skills',
        directory: win32Path.normalize('C:\\nine1bot\\platform-resources\\platform-feishu\\skills'),
      }],
    })
  })

  it('reports enabled registered source drift as error instead of disabled', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
      })],
    })

    manager.registerRuntimeAdapters()
    RuntimeSourceRegistry.unregisterOwner('demo')

    await expect(manager.getDetail('demo')).resolves.toMatchObject({
      runtimeSources: {
        agents: [{
          id: 'demo-agents',
          status: 'error',
          error: 'Runtime source "demo-agents" was declared but not registered.',
        }],
        skills: [{
          id: 'demo-skills',
          status: 'error',
          error: 'Runtime source "demo-skills" was declared but not registered.',
        }],
      },
    })
  })

  it('reports a registered source whose directory is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-source-status-'))
    const missing = join(root, 'missing-skills')
    try {
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: {
            skills: [{
              id: 'demo-skills',
              directory: missing,
              visibility: 'declared-only',
              lifecycle: 'platform-enabled',
            }],
          },
        })],
      })
      manager.registerRuntimeAdapters()

      expect((await manager.getDetail('demo'))?.runtimeSources?.skills[0]).toMatchObject({
        status: 'error',
        error: `Runtime source directory does not exist: ${missing}`,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a registered source whose path is not a directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-source-status-'))
    const file = join(root, 'skills.txt')
    try {
      await writeFile(file, 'not a directory', 'utf8')
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: {
            skills: [{
              id: 'demo-skills',
              directory: file,
              visibility: 'declared-only',
              lifecycle: 'platform-enabled',
            }],
          },
        })],
      })
      manager.registerRuntimeAdapters()

      expect((await manager.getDetail('demo'))?.runtimeSources?.skills[0]).toMatchObject({
        status: 'error',
        error: `Runtime source path is not a directory: ${file}`,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports a registered source with a real readable directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nine1bot-source-status-'))
    const skills = join(root, 'skills')
    try {
      await mkdir(skills)
      const manager = new PlatformAdapterManager({
        contributions: [contribution('demo', {
          defaultEnabled: true,
          sources: {
            skills: [{
              id: 'demo-skills',
              directory: skills,
              visibility: 'declared-only',
              lifecycle: 'platform-enabled',
            }],
          },
        })],
      })
      manager.registerRuntimeAdapters()

      expect((await manager.getDetail('demo'))?.runtimeSources?.skills[0]).toMatchObject({
        status: 'registered',
        error: undefined,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not register runtime sources for disabled platforms', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
      })],
      config: {
        demo: {
          enabled: false,
        },
      },
    })

    manager.registerRuntimeAdapters()

    expect(RuntimeSourceRegistry.listOwner('demo')).toEqual({
      owner: undefined,
      agents: [],
      skills: [],
    })
    await expect(manager.getDetail('demo')).resolves.toMatchObject({
      runtimeSources: {
        agents: [{
          id: 'demo-agents',
          status: 'disabled',
        }],
        skills: [{
          id: 'demo-skills',
          status: 'disabled',
        }],
      },
    })
  })

  it('clears runtime sources when unregistering or reconfiguring platforms', () => {
    const manager = new PlatformAdapterManager({
      contributions: [contribution('demo', {
        defaultEnabled: true,
        sources: runtimeSources(),
      })],
    })

    manager.registerRuntimeAdapters()
    expect(RuntimeSourceRegistry.listOwner('demo').agents.map((source) => source.id)).toEqual(['demo-agents'])

    manager.unregisterRuntimeAdapters()
    expect(RuntimeSourceRegistry.listOwner('demo').agents).toEqual([])

    manager.configure({
      demo: {
        enabled: true,
      },
    })
    expect(RuntimeSourceRegistry.listOwner('demo').agents).toEqual([])
  })

  it('starts and stops background services for enabled platforms', async () => {
    let starts = 0
    let stops = 0
    const service: PlatformBackgroundService = {
      id: 'demo-background',
      async start(ctx) {
        starts++
        expect(ctx.localUrl).toBe('http://127.0.0.1:4096')
        expect(ctx.authHeader).toBe('Basic test')
        return {
          async stop() {
            stops++
          },
          getStatus() {
            return {
              status: 'degraded',
              message: 'background staged',
            }
          },
        }
      },
    }
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        backgroundServices: () => [service],
      }],
    })

    await manager.startBackgroundServices({
      localUrl: 'http://127.0.0.1:4096',
      authHeader: 'Basic test',
    })

    expect(starts).toBe(1)
    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'degraded',
      runtimeStatus: {
        status: 'degraded',
        message: 'background staged',
      },
    })

    await manager.stopBackgroundServices()
    expect(stops).toBe(1)
  })

  it('does not start background services for disabled platforms', async () => {
    let starts = 0
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        backgroundServices: () => [{
          id: 'demo-background',
          async start() {
            starts++
            return { async stop() {} }
          },
        }],
      }],
      config: {
        demo: {
          enabled: false,
        },
      },
    })

    await manager.startBackgroundServices({
      localUrl: 'http://127.0.0.1:4096',
    })

    expect(starts).toBe(0)
  })

  it('stops previous background services before restart or successful config update', async () => {
    let starts = 0
    let stops = 0
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        backgroundServices: () => [{
          id: 'demo-background',
          async start() {
            starts++
            return {
              async stop() {
                stops++
              },
            }
          },
        }],
      }],
    })

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })

    expect(starts).toBe(2)
    expect(stops).toBe(1)

    await manager.updateConfig('demo', { enabled: false })

    expect(stops).toBe(2)
    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    expect(starts).toBe(2)
  })

  it('waits for the previous background service stop before starting a replacement', async () => {
    const events: string[] = []
    let releaseStop: (() => void) | undefined
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...contribution('demo', { defaultEnabled: true }),
        backgroundServices: () => [{
          id: 'demo-background',
          async start() {
            events.push('start')
            return {
              async stop() {
                events.push('stop-begin')
                await new Promise<void>((resolve) => {
                  releaseStop = resolve
                })
                events.push('stop-end')
              },
            }
          },
        }],
      }],
    })

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    const restart = manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    await Promise.resolve()

    expect(events).toEqual(['start', 'stop-begin'])
    releaseStop?.()
    await restart
    expect(events).toEqual(['start', 'stop-begin', 'stop-end', 'start'])
  })

  it('does not leave runtime sources behind when adapter creation fails', async () => {
    const manager = new PlatformAdapterManager({
      contributions: [
        contribution('bad', {
          defaultEnabled: true,
          throws: true,
          sources: {
            agents: [{
              id: 'bad-agents',
              directory: '/tmp/bad/agents',
              visibility: 'recommendable',
              lifecycle: 'platform-enabled',
            }],
          },
        }),
        contribution('good', {
          defaultEnabled: true,
          sources: {
            skills: [{
              id: 'good-skills',
              directory: '/tmp/good/skills',
              visibility: 'declared-only',
              lifecycle: 'platform-enabled',
            }],
          },
        }),
      ],
    })

    manager.registerRuntimeAdapters()

    expect(RuntimeSourceRegistry.listOwner('bad').agents).toEqual([])
    expect(RuntimeSourceRegistry.listOwner('good').skills.map((source) => source.id)).toEqual(['good-skills'])
    await expect(manager.getDetail('bad')).resolves.toMatchObject({
      runtimeSources: {
        agents: [{
          id: 'bad-agents',
          status: 'error',
          error: 'bad failed',
        }],
      },
    })
  })

  it('registers built-in GitLab through the manager', () => {
    registerBuiltinPlatformAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('gitlab')
  })

  it('registers built-in Feishu through the manager', () => {
    registerBuiltinPlatformAdapters()

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).toContain('feishu')
    expect(RuntimeSourceRegistry.listOwner('feishu').skills.map((source) => source.id)).toEqual([
      'feishu-companion-skills',
      'feishu-official-skills',
    ])
    expect(RuntimeSourceRegistry.listOwner('feishu').skills).toContainEqual(expect.objectContaining({
      id: 'feishu-official-skills',
      includeNamePrefix: 'lark-',
    }))
  })

  it('keeps repeated built-in registration with equivalent config revision-stable', () => {
    const config = {
      gitlab: { enabled: true },
      feishu: { enabled: false },
    }
    registerBuiltinPlatformAdapters({ config })
    const adapterRevision = RuntimePlatformAdapterRegistry.version()
    const sourceRevision = RuntimeSourceRegistry.version()
    const toolRevision = RuntimeToolRegistry.version()

    registerBuiltinPlatformAdapters({ config: structuredClone(config) })

    expect(RuntimePlatformAdapterRegistry.version()).toBe(adapterRevision)
    expect(RuntimeSourceRegistry.version()).toBe(sourceRevision)
    expect(RuntimeToolRegistry.version()).toBe(toolRevision)
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

  it('skips built-in Feishu templates when config disables it', () => {
    registerBuiltinPlatformAdapters({
      config: {
        feishu: {
          enabled: false,
        },
      },
    })

    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('feishu')
    expect(RuntimePlatformAdapterRegistry.activeTemplateIds(['web-chat', 'browser-feishu', 'feishu-docx'])).toEqual(['web-chat'])
    expect(RuntimeSourceRegistry.listOwner('feishu').skills).toEqual([])
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

  it('restarts previously started background services after re-enabling a platform', async () => {
    const background = backgroundContribution('demo', { defaultEnabled: true })
    const manager = new PlatformAdapterManager({
      contributions: [background.contribution],
    })
    manager.registerRuntimeAdapters()

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    await manager.updateConfig('demo', { enabled: false })

    expect(background.counts.starts).toBe(1)
    expect(background.counts.stops).toBe(1)
    expect(manager.get('demo')).toMatchObject({
      enabled: false,
      runtimeStatus: {
        status: 'disabled',
      },
    })

    await manager.updateConfig('demo', { enabled: true })

    expect(background.counts.starts).toBe(2)
    expect(background.counts.stops).toBe(1)
    expect(manager.get('demo')).toMatchObject({
      enabled: true,
      runtimeStatus: {
        status: 'available',
        message: 'background run 2',
      },
    })
  })

  it('restarts started background services after settings-only updates', async () => {
    const background = backgroundContribution('demo', {
      defaultEnabled: true,
      config: {
        sections: [{
          id: 'settings',
          title: 'Settings',
          fields: [{
            key: 'mode',
            label: 'Mode',
            type: 'string',
          }],
        }],
      },
    })
    const manager = new PlatformAdapterManager({
      contributions: [background.contribution],
    })
    manager.registerRuntimeAdapters()

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    await manager.updateConfig('demo', {
      settings: {
        mode: 'next',
      },
    })

    expect(background.counts.starts).toBe(2)
    expect(background.counts.stops).toBe(1)
    expect(manager.configSnapshot().demo?.settings).toEqual({
      mode: 'next',
    })
    expect(manager.get('demo')).toMatchObject({
      runtimeStatus: {
        status: 'available',
        message: 'background run 2',
      },
    })
  })

  it('does not auto-start background services on config updates before the first launch', async () => {
    const background = backgroundContribution('demo', {
      defaultEnabled: true,
      config: {
        sections: [{
          id: 'settings',
          title: 'Settings',
          fields: [{
            key: 'mode',
            label: 'Mode',
            type: 'string',
          }],
        }],
      },
    })
    const manager = new PlatformAdapterManager({
      contributions: [background.contribution],
    })
    manager.registerRuntimeAdapters()

    await manager.updateConfig('demo', {
      settings: {
        mode: 'draft',
      },
    })

    expect(background.counts.starts).toBe(0)
    expect(background.counts.stops).toBe(0)
    expect(manager.get('demo')).toMatchObject({
      runtimeStatus: {
        status: 'available',
      },
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

  it('keeps the applied runtime on its previous secret when a reload degrades', async () => {
    const secrets = memorySecrets()
    const previousRef = {
      provider: 'nine1bot-local',
      key: 'platform:demo:default:token',
    } satisfies PlatformSecretRef
    const base = contribution('demo', { defaultEnabled: true })
    const manager = new PlatformAdapterManager({
      contributions: [{
        ...base,
        descriptor: {
          ...base.descriptor,
          config: {
            sections: [{
              id: 'auth',
              title: 'Auth',
              fields: [
                { key: 'token', label: 'Token', type: 'password', secret: true },
                { key: 'fail', label: 'Fail', type: 'boolean' },
              ],
            }],
          },
        },
        runtime: {
          ...base.runtime!,
          tools(context) {
            const settings = context.settings as Record<string, unknown>
            if (settings.fail === true) throw new Error('fixture reload failed')
            const tokenRef = settings.token as PlatformSecretRef
            return [toolDefinition('demo_lookup', {
              async execute() {
                return {
                  status: 'ok',
                  title: 'Token snapshot',
                  output: await context.secrets.get(tokenRef) ?? 'missing',
                }
              },
            })]
          },
        },
      }],
      config: {
        demo: {
          settings: { token: previousRef },
        },
      },
      secrets: secrets.access,
    })
    await secrets.access.set(previousRef, 'old-secret')
    manager.registerRuntimeAdapters()

    await manager.updateConfig('demo', {
      settings: {
        token: 'new-secret',
        fail: true,
      },
    })

    const desiredRef = manager.configSnapshot().demo?.settings?.token as PlatformSecretRef
    expect(desiredRef).not.toEqual(previousRef)
    await expect(secrets.access.get(previousRef)).resolves.toBe('old-secret')
    await expect(secrets.access.get(desiredRef)).resolves.toBe('new-secret')
    expect(manager.get('demo')).toMatchObject({
      lifecycleStatus: 'degraded',
      desiredConfigRevision: 2,
      appliedConfigRevision: 1,
    })

    const retained = RuntimeToolRegistry.get('demo_lookup')
    expect(retained).toBeDefined()
    await expect(retained!.definition.execute({}, {
      sessionId: 'session_test',
      directory: process.cwd(),
      agent: 'build',
      templateIds: [],
      messageId: 'message_test',
      callId: 'call_test',
      signal: new AbortController().signal,
      async reportProgress() {},
    })).resolves.toMatchObject({ output: 'old-secret' })
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

  it('applies action updatedSettings and re-registers runtime sources', async () => {
    await withRuntimeSourceDirectories(async ({ skills }) => {
      const baseContribution = contribution('demo', {
        defaultEnabled: true,
        sources: (ctx) => ({
          skills: [{
            id: 'demo-skills',
            directory: String((ctx.settings as Record<string, unknown>).directory ?? skills),
            visibility: 'default',
            lifecycle: 'platform-enabled',
          }],
        }),
      })
      const manager = new PlatformAdapterManager({
        contributions: [{
          ...baseContribution,
          descriptor: {
            ...baseContribution.descriptor,
            config: {
              sections: [{
                id: 'settings',
                title: 'Settings',
                fields: [{
                  key: 'directory',
                  label: 'Directory',
                  type: 'string',
                }],
              }],
            },
            actions: [{
              id: 'directory.configure',
              label: 'Configure directory',
              kind: 'button',
            }],
          },
          handleAction: async () => ({
            status: 'ok',
            updatedSettings: {
              directory: skills,
            },
            updatedStatus: {
              status: 'available',
              message: 'directory configured',
            },
          }),
        }],
      })
      manager.registerRuntimeAdapters()

      await expect(manager.executeAction('demo', 'directory.configure')).resolves.toMatchObject({
        status: 'ok',
        updatedSettings: {
          directory: skills,
        },
      })

      expect(manager.configSnapshot().demo?.settings).toEqual({
        directory: skills,
      })
      expect(RuntimeSourceRegistry.listOwner('demo').skills).toContainEqual(expect.objectContaining({
        id: 'demo-skills',
        directory: skills,
      }))
      await expect(manager.getDetail('demo')).resolves.toMatchObject({
        runtimeSources: {
          skills: [{
            id: 'demo-skills',
            directory: skills,
            status: 'registered',
          }],
        },
      })
    })
  })

  it('restarts started background services when actions update settings', async () => {
    const background = backgroundContribution('demo', {
      defaultEnabled: true,
      config: {
        sections: [{
          id: 'settings',
          title: 'Settings',
          fields: [{
            key: 'mode',
            label: 'Mode',
            type: 'string',
          }],
        }],
      },
      actions: [{
        id: 'settings.apply',
        label: 'Apply settings',
        kind: 'button',
      }],
      handleAction: async () => ({
        status: 'ok',
        updatedSettings: {
          mode: 'action',
        },
      }),
    })
    const manager = new PlatformAdapterManager({
      contributions: [background.contribution],
    })
    manager.registerRuntimeAdapters()

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    await manager.executeAction('demo', 'settings.apply')

    expect(background.counts.starts).toBe(2)
    expect(background.counts.stops).toBe(1)
    expect(manager.configSnapshot().demo?.settings).toEqual({
      mode: 'action',
    })
    expect(manager.get('demo')).toMatchObject({
      runtimeStatus: {
        status: 'available',
        message: 'background run 2',
      },
    })
  })

  it('keeps restarted background-service status instead of stale action updatedStatus', async () => {
    const background = backgroundContribution('demo', {
      defaultEnabled: true,
      config: {
        sections: [{
          id: 'settings',
          title: 'Settings',
          fields: [{
            key: 'mode',
            label: 'Mode',
            type: 'string',
          }],
        }],
      },
      actions: [{
        id: 'settings.refresh',
        label: 'Refresh settings',
        kind: 'button',
      }],
      handleAction: async () => ({
        status: 'ok',
        updatedSettings: {
          mode: 'fresh',
        },
        updatedStatus: {
          status: 'disabled',
          message: 'stale status',
        },
      }),
    })
    const manager = new PlatformAdapterManager({
      contributions: [background.contribution],
    })
    manager.registerRuntimeAdapters()

    await manager.startBackgroundServices({ localUrl: 'http://127.0.0.1:4096' })
    const result = await manager.executeAction('demo', 'settings.refresh')

    expect(result).toMatchObject({
      status: 'ok',
      updatedStatus: {
        status: 'disabled',
        message: 'stale status',
      },
    })
    expect(background.counts.starts).toBe(2)
    expect(background.counts.stops).toBe(1)
    expect(manager.get('demo')).toMatchObject({
      runtimeStatus: {
        status: 'available',
        message: 'background run 2',
      },
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

  it('reuses the built-in manager instance across config syncs with secrets', () => {
    const firstSecrets = memorySecrets().access
    const secondSecrets = memorySecrets().access

    registerBuiltinPlatformAdapters({
      config: {
        feishu: {
          enabled: true,
        },
      },
      secrets: firstSecrets,
    })
    const firstManager = getBuiltinPlatformManager()

    registerBuiltinPlatformAdapters({
      config: {
        feishu: {
          enabled: false,
        },
      },
      secrets: secondSecrets,
    })
    const secondManager = getBuiltinPlatformManager()

    expect(secondManager).toBe(firstManager)
    expect(RuntimePlatformAdapterRegistry.list().map((adapter) => adapter.id)).not.toContain('feishu')
  })
})
