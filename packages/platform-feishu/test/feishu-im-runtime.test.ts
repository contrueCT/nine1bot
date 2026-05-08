import { afterEach, describe, expect, test } from 'bun:test'
import type {
  PlatformAdapterContext,
  PlatformBackgroundServiceHandle,
  PlatformRecentEvent,
  PlatformSecretRef,
} from '@nine1bot/platform-protocol'
import {
  clearFeishuIMReplyRuntimeSummaryForTesting,
  createFeishuIMBackgroundServices,
  recordFeishuIMCardUpdateFailure,
  recordFeishuIMReplyError,
  recordFeishuIMStreamingFallback,
} from '../src/im'
import {
  clearFeishuIMRuntimeSnapshotForTesting,
  setFeishuIMRuntimeTestHooksForTesting,
} from '../src/im/background-runtime'

const secretRef: PlatformSecretRef = {
  provider: 'nine1bot-local',
  key: 'platform:feishu:default:imDefaultAppSecret',
}

afterEach(() => {
  clearFeishuIMReplyRuntimeSummaryForTesting()
  clearFeishuIMRuntimeSnapshotForTesting()
})

describe('Feishu IM runtime supervisor', () => {
  test('retries failed gateway startup with backoff and clears restart attempts after stability window', async () => {
    const scheduler = createManualScheduler()
    const gateways = createFakeGatewayHarness()
    gateways.queueStart('default', { fail: 'boot failed' })
    gateways.queueStart('default', { autoConnect: true })

    setFeishuIMRuntimeTestHooksForTesting({
      createGateway: gateways.factory,
      scheduler: scheduler.scheduler,
      retryBackoffMs: [1, 3, 10, 30, 60],
      stabilityWindowMs: 5,
    })

    const handle = await startService({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
    })

    expect(handle.getStatus?.()).toMatchObject({
      status: 'error',
      message: expect.stringContaining('boot failed'),
    })
    expect(cardValue(handle, 'im-restart-attempts')).toBe('1')
    expect(cardIds(handle)).toEqual(['im-runtime', 'im-gateway-state', 'im-restart-attempts', 'im-accounts'])
    expect(scheduler.pendingDelays()).toEqual([1])

    await scheduler.runNext()

    expect(gateways.count('default')).toBe(2)
    expect(handle.getStatus?.()).toMatchObject({
      status: 'available',
      message: expect.stringContaining('running for 1 account'),
    })
    expect(cardValue(handle, 'im-restart-attempts')).toBe('1')
    expect(scheduler.pendingDelays()).toEqual([5])
    expect(recentEvent(handle, 'restart-scheduled')).toBeDefined()

    await scheduler.runNext()

    expect(cardValue(handle, 'im-restart-attempts')).toBe('0')
    await handle.stop()
  })

  test('reconnecting only degrades status and connection errors restart the affected account gateway', async () => {
    const scheduler = createManualScheduler()
    const gateways = createFakeGatewayHarness()

    setFeishuIMRuntimeTestHooksForTesting({
      createGateway: gateways.factory,
      scheduler: scheduler.scheduler,
      retryBackoffMs: [1, 3, 10, 30, 60],
      stabilityWindowMs: 5,
    })

    const handle = await startService({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
      imAccounts: [{
        id: 'team-a',
        appId: 'cli_team',
        appSecretRef: { provider: 'env', key: 'FEISHU_TEAM_SECRET' },
      }],
    })

    expect(handle.getStatus?.().status).toBe('available')
    expect(gateways.count('default')).toBe(1)
    expect(gateways.count('team-a')).toBe(1)
    expect(recentEvent(handle, 'connected')).toBeUndefined()
    expect(cardIds(handle)).toEqual(['im-runtime', 'im-gateway-state', 'im-restart-attempts', 'im-accounts'])

    await gateways.latest('default')!.emit('reconnecting', 'socket closed')

    expect(handle.getStatus?.()).toMatchObject({
      status: 'degraded',
      message: expect.stringContaining('running for 1 account'),
    })
    expect(scheduler.pendingCount()).toBe(0)
    expect(cardValue(handle, 'im-gateway-state')).toContain('reconnecting')

    await gateways.latest('default')!.emit('connection-error', 'fatal ws error')

    expect(handle.getStatus?.().status).toBe('degraded')
    expect(scheduler.pendingDelays()).toEqual([1])
    expect(gateways.count('default')).toBe(1)
    expect(gateways.count('team-a')).toBe(1)

    await scheduler.runNext()

    expect(gateways.count('default')).toBe(2)
    expect(gateways.count('team-a')).toBe(1)
    expect(handle.getStatus?.().status).toBe('available')
    expect(recentEvent(handle, 'connected')).toBeDefined()
    await handle.stop()
  })

  test('stop cancels pending restarts before they can recreate a gateway', async () => {
    const scheduler = createManualScheduler()
    const gateways = createFakeGatewayHarness()

    setFeishuIMRuntimeTestHooksForTesting({
      createGateway: gateways.factory,
      scheduler: scheduler.scheduler,
      retryBackoffMs: [1, 3, 10, 30, 60],
      stabilityWindowMs: 5,
    })

    const handle = await startService({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
    })

    await gateways.latest('default')!.emit('connection-error', 'fatal ws error')

    expect(scheduler.pendingDelays()).toEqual([1])
    expect(gateways.count('default')).toBe(1)

    await handle.stop()
    await scheduler.runAll()

    expect(scheduler.pendingCount()).toBe(0)
    expect(gateways.count('default')).toBe(1)
  })

  test('reply and streaming failures surface in recent events instead of runtime cards', async () => {
    const scheduler = createManualScheduler()
    const gateways = createFakeGatewayHarness()

    setFeishuIMRuntimeTestHooksForTesting({
      createGateway: gateways.factory,
      scheduler: scheduler.scheduler,
      retryBackoffMs: [1, 3, 10, 30, 60],
      stabilityWindowMs: 5,
    })

    const handle = await startService({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
    })

    recordFeishuIMCardUpdateFailure(new Error('cardkit.card.create failed'))
    recordFeishuIMStreamingFallback('cardkit create failed', 'patch')
    recordFeishuIMReplyError(new Error('reply delivery failed'))
    await flushMicrotasks()

    expect(cardIds(handle)).toEqual(['im-runtime', 'im-gateway-state', 'im-restart-attempts', 'im-accounts'])
    expect(handle.getStatus?.().cards?.map((card) => card.label)).not.toContain('Reply error')
    expect(handle.getStatus?.().cards?.map((card) => card.label)).not.toContain('Card update error')
    expect(handle.getStatus?.().cards?.map((card) => card.label)).not.toContain('Streaming fallback')

    const events = handle.getStatus?.().recentEvents ?? []
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'im-reply',
      data: expect.objectContaining({ event: 'card-update-failed' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'im-reply',
      data: expect.objectContaining({ event: 'streaming-fallback', transport: 'patch' }),
    }))
    expect(events).toContainEqual(expect.objectContaining({
      stage: 'im-reply',
      data: expect.objectContaining({ event: 'reply-error', error: 'reply delivery failed' }),
    }))
    expect(events.filter((entry) => entry.data?.event === 'reply-error' && entry.data?.error === 'cardkit.card.create failed')).toHaveLength(0)

    await handle.stop()
  })
})

function cardValue(handle: PlatformBackgroundServiceHandle, id: string): string | undefined {
  return handle.getStatus?.().cards?.find((card) => card.id === id)?.value
}

function cardIds(handle: PlatformBackgroundServiceHandle): string[] {
  return handle.getStatus?.().cards?.map((card) => card.id) ?? []
}

function recentEvent(handle: PlatformBackgroundServiceHandle, eventName: string): PlatformRecentEvent | undefined {
  return handle.getStatus?.().recentEvents?.find((entry) => entry.data?.event === eventName)
}

async function startService(settings: Record<string, unknown>): Promise<PlatformBackgroundServiceHandle> {
  const ctx = platformContext(settings)
  const services = createFeishuIMBackgroundServices(ctx)
  expect(services).toHaveLength(1)
  return await services[0]!.start({
    ...ctx,
    localUrl: 'http://127.0.0.1:4096',
  })
}

function platformContext(settings: Record<string, unknown>): PlatformAdapterContext {
  return {
    platformId: 'feishu',
    enabled: true,
    settings,
    features: {},
    env: {},
    secrets: {
      async get() {
        return 'secret'
      },
      async set() {},
      async delete() {},
      async has() {
        return true
      },
    },
    audit: {
      write() {},
    },
  }
}

function createManualScheduler() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { id: number; at: number; callback: () => void }>()

  const scheduler = {
    setTimeout(callback: () => void, delayMs: number) {
      const timer = {
        id: nextId++,
        at: now + delayMs,
        callback,
      }
      timers.set(timer.id, timer)
      return timer.id
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number)
    },
  }

  return {
    scheduler,
    pendingCount() {
      return timers.size
    },
    pendingDelays() {
      return [...timers.values()]
        .map((timer) => timer.at - now)
        .sort((left, right) => left - right)
    },
    async runNext() {
      const next = [...timers.values()].sort((left, right) => left.at - right.at || left.id - right.id)[0]
      if (!next) return false
      timers.delete(next.id)
      now = next.at
      next.callback()
      await flushMicrotasks()
      return true
    },
    async runAll() {
      while (await this.runNext()) {
        // continue until no timers remain
      }
    },
  }
}

function createFakeGatewayHarness() {
  const plans = new Map<string, Array<{ fail?: string; autoConnect?: boolean }>>()
  const instances: Array<{
    accountId: string
    started: boolean
    startCalls: number
    stopCalls: number
    emit: (state: 'connected' | 'reconnecting' | 'connection-error' | 'stopped', message?: string) => Promise<void>
  }> = []

  return {
    factory(options: {
      account: { id: string }
      onConnectionStateChange?: (event: {
        accountId: string
        state: 'connected' | 'reconnecting' | 'connection-error' | 'stopped'
        at: string
        message?: string
      }) => void | Promise<void>
    }) {
      const instance = {
        accountId: options.account.id,
        started: false,
        startCalls: 0,
        stopCalls: 0,
        emit: async (
          state: 'connected' | 'reconnecting' | 'connection-error' | 'stopped',
          message?: string,
        ) => {
          await options.onConnectionStateChange?.({
            accountId: options.account.id,
            state,
            at: new Date().toISOString(),
            message,
          })
        },
      }
      instances.push(instance)

      return {
        async start() {
          instance.startCalls += 1
          const plan = plans.get(options.account.id)?.shift()
          if (plan?.fail) {
            throw new Error(plan.fail)
          }
          instance.started = true
          if (plan?.autoConnect !== false) {
            await instance.emit('connected')
          }
        },
        async stop() {
          if (!instance.started) return
          instance.started = false
          instance.stopCalls += 1
          await instance.emit('stopped')
        },
        async injectMessage() {},
        async injectCardAction() {
          return undefined
        },
        isStarted() {
          return instance.started
        },
      }
    },
    queueStart(accountId: string, plan: { fail?: string; autoConnect?: boolean }) {
      const queue = plans.get(accountId) ?? []
      queue.push(plan)
      plans.set(accountId, queue)
    },
    latest(accountId: string) {
      return [...instances].reverse().find((instance) => instance.accountId === accountId)
    },
    count(accountId: string) {
      return instances.filter((instance) => instance.accountId === accountId).length
    },
  }
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve()
  }
}
