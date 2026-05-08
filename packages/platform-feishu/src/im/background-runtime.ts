import type {
  PlatformAdapterContext,
  PlatformBackgroundService,
  PlatformBackgroundServiceContext,
  PlatformBackgroundServiceHandle,
  PlatformRecentEvent,
  PlatformRuntimeStatus,
  PlatformStatusCard,
} from '@nine1bot/platform-protocol'
import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type {
  FeishuIMGatewayConnectionStateEvent,
  FeishuIMGatewayHandle,
} from './gateway-interface'
import { normalizeFeishuIMConfig } from './config'
import {
  getFeishuIMReplyRuntimeRecentEvents,
  getFeishuIMReplyRuntimeSummary,
  resetFeishuIMReplyRuntimeSummary,
  subscribeFeishuIMReplyRuntimeSummary,
} from './reply-telemetry'
import type { FeishuNodeIMGatewayOptions } from './node/ws-gateway'
import type {
  FeishuIMAccount,
  FeishuIMNormalizedConfig,
  FeishuIMRuntimeSnapshot,
} from './types'

const FEISHU_IM_SERVICE_ID = 'feishu-im'
const FEISHU_IM_RESTART_BACKOFF_MS = [1_000, 3_000, 10_000, 30_000, 60_000]
const FEISHU_IM_STABILITY_WINDOW_MS = 60_000
const FEISHU_IM_RECENT_EVENT_LIMIT = 20

type FeishuIMRuntimeManagerHandle = {
  stop(): void
}

type FeishuIMAccountRuntimeState =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'restarting'
  | 'error'
  | 'stopped'

type FeishuIMGatewayFactory = (
  options: FeishuNodeIMGatewayOptions,
) => FeishuIMGatewayHandle

type FeishuIMRuntimeScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

type FeishuIMRuntimeTestHooks = {
  createGateway?: FeishuIMGatewayFactory
  scheduler?: FeishuIMRuntimeScheduler
  retryBackoffMs?: number[]
  stabilityWindowMs?: number
}

type FeishuIMAccountRuntime = {
  account: FeishuIMAccount
  manager?: FeishuIMRuntimeManagerHandle
  createGateway?: (
    callbacks: Pick<FeishuNodeIMGatewayOptions, 'onConnectionStateChange' | 'onOperationalError'>,
  ) => FeishuIMGatewayHandle
  gateway?: FeishuIMGatewayHandle
  restartTimer?: unknown
  stabilityTimer?: unknown
  restartAttempt: number
  generation: number
  connectionState: FeishuIMAccountRuntimeState
  lastConnectionError?: string
  stopping: boolean
  restartable: boolean
}

const defaultRuntimeScheduler: FeishuIMRuntimeScheduler = {
  setTimeout(callback, delayMs) {
    return setTimeout(callback, delayMs)
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

let latestSnapshot: FeishuIMRuntimeSnapshot | undefined
let runtimeTestHooks: FeishuIMRuntimeTestHooks | undefined
let recentEventCounter = 0

export function createFeishuIMBackgroundServices(ctx: PlatformAdapterContext): PlatformBackgroundService[] {
  const config = normalizeFeishuIMConfig(ctx.settings)
  if (!config.enabled) return []
  return [createFeishuIMBackgroundService()]
}

export function getFeishuIMRuntimeStatus(
  ctx: PlatformAdapterContext,
  options: {
    legacyConfig?: unknown
  } = {},
): PlatformRuntimeStatus {
  const config = normalizeFeishuIMConfig(ctx.settings, options)
  const snapshot = latestSnapshot
  if (snapshot && snapshot.updatedAt) {
    return snapshot.status
  }
  return statusFromConfig(config)
}

export function clearFeishuIMRuntimeSnapshotForTesting() {
  latestSnapshot = undefined
  runtimeTestHooks = undefined
  recentEventCounter = 0
}

export function setFeishuIMRuntimeTestHooksForTesting(hooks?: FeishuIMRuntimeTestHooks) {
  runtimeTestHooks = hooks
}

function createFeishuIMBackgroundService(): PlatformBackgroundService {
  return {
    id: FEISHU_IM_SERVICE_ID,
    async start(ctx) {
      const handle = new FeishuIMBackgroundHandle(ctx)
      await handle.start()
      return handle
    },
  }
}

class FeishuIMBackgroundHandle implements PlatformBackgroundServiceHandle {
  private status: PlatformRuntimeStatus
  private readonly runtimes = new Map<string, FeishuIMAccountRuntime>()
  private recentEvents: PlatformRecentEvent[] = []
  private readonly scheduler: FeishuIMRuntimeScheduler
  private readonly retryBackoffMs: number[]
  private readonly stabilityWindowMs: number
  private readonly gatewayFactoryOverride?: FeishuIMGatewayFactory
  private unsubscribeReplyTelemetry?: () => void

  constructor(private readonly ctx: PlatformBackgroundServiceContext) {
    const hooks = runtimeTestHooks
    this.scheduler = hooks?.scheduler ?? defaultRuntimeScheduler
    this.retryBackoffMs = hooks?.retryBackoffMs?.length
      ? hooks.retryBackoffMs
      : FEISHU_IM_RESTART_BACKOFF_MS
    this.stabilityWindowMs = hooks?.stabilityWindowMs ?? FEISHU_IM_STABILITY_WINDOW_MS
    this.gatewayFactoryOverride = hooks?.createGateway
    this.status = statusFromConfig(this.config())
  }

  async start(): Promise<void> {
    const config = this.config()
    this.runtimes.clear()
    this.recentEvents = []
    this.unsubscribeReplyTelemetry?.()
    this.unsubscribeReplyTelemetry = undefined
    resetFeishuIMReplyRuntimeSummary()

    if (!config.enabled || config.accounts.length === 0) {
      this.status = statusFromConfig(config)
      latestSnapshot = snapshotFrom(config, this.status)
      return
    }

    if (process.platform === 'win32' && config.legacy.enabled) {
      this.status = {
        status: 'degraded',
        message: 'Feishu IM is staged because both legacy feishu.enabled and platform IM are enabled on Windows.',
        cards: cardsFromConfig(config, 'staged'),
        recentEvents: [
          event(
            'warn',
            'runtime',
            'Platform Feishu IM websocket was not started while legacy Feishu config is still enabled on Windows.',
            { event: 'staged-on-windows' },
          ),
        ],
      }
      latestSnapshot = snapshotFrom(config, this.status, 'staged')
      return
    }

    this.unsubscribeReplyTelemetry = subscribeFeishuIMReplyRuntimeSummary(() => {
      this.refreshStatus()
    })

    const [
      sdk,
      { FeishuIMSessionManager },
      {
        createFeishuIMCardActionHandler,
        createFeishuIMImmediateReplyHandler,
        createFeishuIMReplySinkFactory,
      },
      { FeishuFileIMBindingStore },
      { createHttpFeishuControllerBridge },
      { createFeishuNodeReplyClient },
      { createFeishuNodeIMGateway },
    ] = await Promise.all([
      import('@larksuiteoapi/node-sdk'),
      import('./session-manager'),
      import('./reply-coordinator'),
      import('./node/binding-store'),
      import('./node/http-controller-bridge'),
      import('./node/reply-client'),
      import('./node/ws-gateway'),
    ])

    const gatewayFactory = this.gatewayFactoryOverride ?? createFeishuNodeIMGateway
    const controller = createHttpFeishuControllerBridge({
      localUrl: this.ctx.localUrl,
      authHeader: this.ctx.authHeader,
      platformController: this.ctx.controller,
    })
    const store = new FeishuFileIMBindingStore({ env: this.ctx.env })

    for (const account of config.accounts) {
      const runtime: FeishuIMAccountRuntime = {
        account,
        restartAttempt: 0,
        generation: 0,
        connectionState: 'starting',
        stopping: false,
        restartable: false,
      }
      this.runtimes.set(account.id, runtime)
      try {
        const appSecret = await this.ctx.secrets.get(account.appSecretRef)
        if (!appSecret) {
          throw new Error(`Secret ref is missing for account "${account.id}"`)
        }
        const client = createClient(sdk, account, appSecret)
        const replyClient = createFeishuNodeReplyClient({ client: client as any })
        const manager = new FeishuIMSessionManager({
          account,
          config,
          controller,
          store,
          defaultDirectory: defaultDirectoryFor(this.ctx, account),
          resolveDirectory,
          replySinkFactory: createFeishuIMReplySinkFactory({
            account,
            config,
            controller,
            client: replyClient,
            continueUrlForSession: (sessionId) => continueUrl(this.ctx.localUrl, sessionId),
          }),
          onImmediateReply: createFeishuIMImmediateReplyHandler({
            account,
            config,
            client: replyClient,
            continueUrlForSession: (sessionId) => continueUrl(this.ctx.localUrl, sessionId),
          }),
        })
        runtime.manager = manager
        runtime.restartable = true
        runtime.createGateway = ({ onConnectionStateChange, onOperationalError }) => createGatewayForAccount({
          gatewayFactory,
          account,
          appSecret,
          manager,
          controller,
          onConnectionStateChange,
          onOperationalError,
          continueUrlForSession: (sessionId) => continueUrl(this.ctx.localUrl, sessionId),
          createCardActionHandler: createFeishuIMCardActionHandler,
        })
        await this.startGateway(runtime, 'initial-start')
      } catch (error) {
        runtime.connectionState = 'error'
        runtime.lastConnectionError = errorMessage(error)
        runtime.restartable = false
        this.recordRecentEvent(
          'error',
          'runtime',
          `Feishu IM account "${account.id}" failed to initialize: ${runtime.lastConnectionError}`,
          {
            accountId: account.id,
            event: 'account-init-failed',
          },
        )
      }
    }

    this.refreshStatus()
  }

  async stop(): Promise<void> {
    const config = this.config()
    const runtimes = [...this.runtimes.values()]
    for (const runtime of runtimes) {
      runtime.stopping = true
      runtime.generation += 1
      this.clearRestartTimer(runtime)
      this.clearStabilityTimer(runtime)
    }
    for (const runtime of runtimes) {
      const gateway = runtime.gateway
      runtime.gateway = undefined
      await gateway?.stop().catch(() => undefined)
    }
    for (const runtime of runtimes) {
      runtime.manager?.stop()
      runtime.manager = undefined
      runtime.connectionState = 'stopped'
    }
    this.unsubscribeReplyTelemetry?.()
    this.unsubscribeReplyTelemetry = undefined
    resetFeishuIMReplyRuntimeSummary()
    this.runtimes.clear()
    this.recentEvents = []
    this.status = {
      status: 'disabled',
      message: 'Feishu IM background service is stopped.',
      cards: cardsFromConfig(config, 'stopped'),
    }
    latestSnapshot = snapshotFrom(config, this.status, 'stopped')
  }

  getStatus(): PlatformRuntimeStatus {
    return this.status
  }

  private config(): FeishuIMNormalizedConfig {
    return normalizeFeishuIMConfig(this.ctx.settings, {
      legacyConfig: this.ctx.legacySettings?.feishu,
    })
  }

  private async startGateway(runtime: FeishuIMAccountRuntime, reason: 'initial-start' | 'restart') {
    if (!runtime.createGateway || runtime.stopping) return

    const generation = runtime.generation + 1
    runtime.generation = generation
    runtime.connectionState = runtime.restartAttempt > 0 || reason === 'restart' ? 'restarting' : 'starting'
    this.refreshStatus()

    const gateway = runtime.createGateway({
      onConnectionStateChange: async (event) => {
        await this.handleConnectionStateChange(runtime.account.id, generation, event)
      },
      onOperationalError: async (error) => {
        await this.handleOperationalError(runtime.account.id, error)
      },
    })
    runtime.gateway = gateway

    try {
      await gateway.start()
    } catch (error) {
      if (runtime.stopping || runtime.generation !== generation) return
      runtime.gateway = undefined
      await gateway.stop().catch(() => undefined)
      this.handleGatewayStartFailure(runtime, error, reason)
    }
  }

  private handleGatewayStartFailure(
    runtime: FeishuIMAccountRuntime,
    error: unknown,
    reason: 'initial-start' | 'restart',
  ) {
    runtime.connectionState = 'error'
    runtime.lastConnectionError = errorMessage(error)
    this.recordRecentEvent(
      'error',
      'im-gateway',
      reason === 'restart'
        ? `Feishu IM account "${runtime.account.id}" failed to restart gateway: ${runtime.lastConnectionError}`
        : `Feishu IM account "${runtime.account.id}" failed to start gateway: ${runtime.lastConnectionError}`,
      {
        accountId: runtime.account.id,
        event: reason === 'restart' ? 'restart-failed' : 'start-failed',
      },
    )
    this.scheduleRestart(runtime, runtime.lastConnectionError)
  }

  private async handleConnectionStateChange(
    accountId: string,
    generation: number,
    change: FeishuIMGatewayConnectionStateEvent,
  ) {
    const runtime = this.runtimes.get(accountId)
    if (!runtime || runtime.stopping || runtime.generation !== generation) return

    if (change.state === 'connected') {
      this.clearRestartTimer(runtime)
      runtime.connectionState = 'connected'
      runtime.lastConnectionError = undefined
      if (runtime.restartAttempt > 0) {
        this.recordRecentEvent(
          'info',
          'im-gateway',
          `Feishu IM account "${accountId}" gateway connected after restart attempt ${runtime.restartAttempt}.`,
          {
            accountId,
            event: 'connected',
          },
        )
      }
      this.startStabilityTimer(runtime, generation)
      this.refreshStatus()
      return
    }

    if (change.state === 'reconnecting') {
      this.clearStabilityTimer(runtime)
      runtime.lastConnectionError = change.message ?? runtime.lastConnectionError
      if (!runtime.restartTimer && runtime.connectionState !== 'restarting') {
        runtime.connectionState = 'reconnecting'
      }
      this.recordRecentEvent(
        'warn',
        'im-gateway',
        `Feishu IM account "${accountId}" gateway is reconnecting${change.message ? `: ${change.message}` : '.'}`,
        {
          accountId,
          event: 'reconnecting',
        },
      )
      this.refreshStatus()
      return
    }

    if (change.state === 'connection-error') {
      this.clearStabilityTimer(runtime)
      runtime.connectionState = 'error'
      runtime.lastConnectionError = change.message ?? 'Unknown connection error'
      this.recordRecentEvent(
        'error',
        'im-gateway',
        `Feishu IM account "${accountId}" connection error: ${runtime.lastConnectionError}`,
        {
          accountId,
          event: 'connection-error',
        },
      )
      this.scheduleRestart(runtime, runtime.lastConnectionError)
      return
    }

    this.clearStabilityTimer(runtime)
    if (!runtime.restartTimer && runtime.connectionState !== 'restarting') {
      runtime.connectionState = 'stopped'
      this.refreshStatus()
    }
  }

  private async handleOperationalError(accountId: string, error: Error) {
    await this.ctx.audit.write({
      platformId: this.ctx.platformId,
      level: 'warn',
      stage: 'im-gateway-operational',
      message: error.message,
      data: { accountId },
    })
  }

  private scheduleRestart(runtime: FeishuIMAccountRuntime, message?: string) {
    if (!runtime.restartable || runtime.stopping || runtime.restartTimer) {
      this.refreshStatus()
      return
    }

    this.clearStabilityTimer(runtime)
    runtime.connectionState = 'error'
    runtime.restartAttempt += 1
    const backoffMs = this.backoffForAttempt(runtime.restartAttempt)
    const scheduledGeneration = runtime.generation
    this.recordRecentEvent(
      'warn',
      'im-gateway',
      `Feishu IM account "${runtime.account.id}" scheduled a gateway restart in ${backoffMs}ms${message ? `: ${message}` : '.'}`,
      {
        accountId: runtime.account.id,
        event: 'restart-scheduled',
        backoffMs,
        restartAttempt: runtime.restartAttempt,
        error: message,
      },
    )
    const timer = this.scheduler.setTimeout(() => {
      if (runtime.stopping || runtime.restartTimer !== timer || runtime.generation !== scheduledGeneration) return
      runtime.restartTimer = undefined
      void this.restartGateway(runtime)
    }, backoffMs)
    runtime.restartTimer = timer
    this.refreshStatus()
  }

  private async restartGateway(runtime: FeishuIMAccountRuntime) {
    if (runtime.stopping || runtime.connectionState === 'restarting') return

    runtime.connectionState = 'restarting'
    const previousGateway = runtime.gateway
    runtime.generation += 1
    runtime.gateway = undefined
    this.refreshStatus()

    await previousGateway?.stop().catch(() => undefined)
    if (runtime.stopping) return
    await this.startGateway(runtime, 'restart')
  }

  private startStabilityTimer(runtime: FeishuIMAccountRuntime, generation: number) {
    this.clearStabilityTimer(runtime)
    if (runtime.restartAttempt === 0 || this.stabilityWindowMs <= 0) return

    const timer = this.scheduler.setTimeout(() => {
      if (
        runtime.stopping
        || runtime.stabilityTimer !== timer
        || runtime.generation !== generation
        || runtime.connectionState !== 'connected'
      ) {
        return
      }
      runtime.stabilityTimer = undefined
      runtime.restartAttempt = 0
      this.refreshStatus()
    }, this.stabilityWindowMs)
    runtime.stabilityTimer = timer
  }

  private clearRestartTimer(runtime: FeishuIMAccountRuntime) {
    if (!runtime.restartTimer) return
    this.scheduler.clearTimeout(runtime.restartTimer)
    runtime.restartTimer = undefined
  }

  private clearStabilityTimer(runtime: FeishuIMAccountRuntime) {
    if (!runtime.stabilityTimer) return
    this.scheduler.clearTimeout(runtime.stabilityTimer)
    runtime.stabilityTimer = undefined
  }

  private backoffForAttempt(attempt: number): number {
    const index = Math.max(0, Math.min(attempt - 1, this.retryBackoffMs.length - 1))
    return this.retryBackoffMs[index] ?? FEISHU_IM_RESTART_BACKOFF_MS[FEISHU_IM_RESTART_BACKOFF_MS.length - 1]!
  }

  private recordRecentEvent(
    level: PlatformRecentEvent['level'],
    stage: string,
    message: string,
    data?: Record<string, unknown>,
  ) {
    const entry = event(level, stage, message, data)
    this.recentEvents = [entry, ...this.recentEvents].slice(0, FEISHU_IM_RECENT_EVENT_LIMIT)
    if (level === 'warn' || level === 'error') {
      void this.ctx.audit.write({
        platformId: this.ctx.platformId,
        level,
        stage,
        message,
        data,
      })
    }
  }

  private refreshStatus() {
    const config = this.config()
    this.status = statusFromRuntime(config, [...this.runtimes.values()], this.recentEvents)
    latestSnapshot = snapshotFrom(config, this.status)
  }
}

function statusFromConfig(config: FeishuIMNormalizedConfig): PlatformRuntimeStatus {
  if (!config.enabled) {
    return {
      status: 'disabled',
      message: 'Feishu IM is disabled in platform settings.',
      cards: cardsFromConfig(config, 'disabled'),
    }
  }

  if (config.accounts.length === 0) {
    return {
      status: 'error',
      message: 'Feishu IM is enabled but no valid IM account is configured.',
      cards: cardsFromConfig(config, 'error'),
      recentEvents: [event('error', 'config', 'Feishu IM enabled without a valid account', {
        event: 'no-valid-account',
      })],
    }
  }

  return {
    status: 'degraded',
    message: 'Feishu IM background service is configured and waiting to start.',
    cards: cardsFromConfig(config, 'staged'),
    recentEvents: legacyEvents(config),
  }
}

function statusFromRuntime(
  config: FeishuIMNormalizedConfig,
  runtimes: FeishuIMAccountRuntime[],
  runtimeEvents: PlatformRecentEvent[],
): PlatformRuntimeStatus {
  if (runtimes.length === 0) {
    return statusFromConfig(config)
  }

  const healthy = runtimes.filter((runtime) => runtime.connectionState === 'connected')
  const reconnecting = runtimes.filter((runtime) => runtime.connectionState === 'reconnecting')
  const restarting = runtimes.filter((runtime) => runtime.connectionState === 'restarting')
  const starting = runtimes.filter((runtime) => runtime.connectionState === 'starting')
  const errors = runtimes.filter((runtime) => runtime.connectionState === 'error')
  const unhealthyCount = runtimes.length - healthy.length
  const recentEvents = mergedRecentEvents(config, runtimeEvents)

  if (healthy.length === runtimes.length) {
    return {
      status: 'available',
      message: `Feishu IM websocket is running for ${healthy.length} account(s).`,
      cards: cardsFromConfig(config, 'running', runtimes),
      recentEvents,
    }
  }

  if (healthy.length > 0) {
    const unhealthyKinds = [
      reconnecting.length ? `${reconnecting.length} reconnecting` : undefined,
      restarting.length ? `${restarting.length} restarting` : undefined,
      starting.length ? `${starting.length} starting` : undefined,
      errors.length ? `${errors.length} failing` : undefined,
    ].filter(Boolean).join(', ')

    return {
      status: 'degraded',
      message: `Feishu IM is running for ${healthy.length} account(s) while ${unhealthyCount} account(s) are ${unhealthyKinds || 'recovering'}.`,
      cards: cardsFromConfig(config, 'running', runtimes),
      recentEvents,
    }
  }

  const lastError = runtimes.find((runtime) => runtime.lastConnectionError)?.lastConnectionError
  return {
    status: 'error',
    message: lastError
      ? `Feishu IM is not currently healthy for any account. Last error: ${lastError}`
      : 'Feishu IM is not currently healthy for any account.',
    cards: cardsFromConfig(config, 'error', runtimes),
    recentEvents,
  }
}

function cardsFromConfig(
  config: FeishuIMNormalizedConfig,
  phase: string,
  runtimes: FeishuIMAccountRuntime[] = [],
): PlatformStatusCard[] {
  const gateway = summarizeGatewayState(phase, runtimes)
  const restartAttempts = summarizeRestartAttempts(runtimes)
  const cards: PlatformStatusCard[] = [
    {
      id: 'im-runtime',
      label: 'IM runtime',
      value: phase,
      tone: phase === 'error' ? 'danger' : phase === 'staged' ? 'warning' : phase === 'running' ? 'success' : 'neutral',
    },
    {
      id: 'im-gateway-state',
      label: 'Gateway state',
      value: gateway.value,
      tone: gateway.tone,
    },
    {
      id: 'im-restart-attempts',
      label: 'Restart attempts',
      value: restartAttempts.value,
      tone: restartAttempts.tone,
    },
    {
      id: 'im-accounts',
      label: 'IM accounts',
      value: String(config.accounts.length),
      tone: config.accounts.length > 0 ? 'success' : config.enabled ? 'danger' : 'neutral',
    },
  ]

  if (config.legacy.enabled) {
    cards.push({
      id: 'im-legacy',
      label: 'Legacy IM',
      value: 'active',
      tone: 'warning',
    })
  }

  return cards
}

function summarizeGatewayState(
  phase: string,
  runtimes: FeishuIMAccountRuntime[],
): Pick<PlatformStatusCard, 'value' | 'tone'> {
  if (runtimes.length === 0) {
    return {
      value: phase === 'running' ? 'running' : phase,
      tone: phase === 'error' ? 'danger' : phase === 'staged' ? 'warning' : 'neutral',
    }
  }

  if (runtimes.length === 1) {
    const runtime = runtimes[0]!
    return {
      value: displayGatewayState(runtime.connectionState),
      tone: toneForGatewayState([runtime]),
    }
  }

  const counts = new Map<string, number>()
  for (const runtime of runtimes) {
    const key = displayGatewayState(runtime.connectionState)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return {
    value: [...counts.entries()]
      .map(([state, count]) => `${count} ${state}`)
      .join(' / '),
    tone: toneForGatewayState(runtimes),
  }
}

function summarizeRestartAttempts(
  runtimes: FeishuIMAccountRuntime[],
): Pick<PlatformStatusCard, 'value' | 'tone'> {
  const attempts = runtimes.filter((runtime) => runtime.restartAttempt > 0)
  if (attempts.length === 0) {
    return {
      value: '0',
      tone: 'neutral',
    }
  }

  if (attempts.length === 1 && runtimes.length === 1) {
    return {
      value: String(attempts[0]!.restartAttempt),
      tone: 'warning',
    }
  }

  return {
    value: attempts
      .map((runtime) => `${runtime.account.id}:${runtime.restartAttempt}`)
      .join(', '),
    tone: 'warning',
  }
}

function displayGatewayState(state: FeishuIMAccountRuntimeState): string {
  return state === 'connected' ? 'running' : state
}

function toneForGatewayState(runtimes: FeishuIMAccountRuntime[]): PlatformStatusCard['tone'] {
  if (runtimes.every((runtime) => runtime.connectionState === 'connected')) {
    return 'success'
  }
  if (runtimes.some((runtime) => runtime.connectionState === 'error')) {
    return runtimes.some((runtime) => runtime.connectionState === 'connected') ? 'warning' : 'danger'
  }
  if (runtimes.some((runtime) => runtime.connectionState === 'reconnecting' || runtime.connectionState === 'restarting' || runtime.connectionState === 'starting')) {
    return 'warning'
  }
  return 'neutral'
}

function snapshotFrom(
  config: FeishuIMNormalizedConfig,
  status: PlatformRuntimeStatus,
  phase: FeishuIMRuntimeSnapshot['phase'] = status.status === 'error'
    ? 'error'
    : status.status === 'disabled'
      ? 'disabled'
      : status.status === 'available' || status.status === 'degraded'
        ? 'running'
        : 'staged',
): FeishuIMRuntimeSnapshot {
  const reply = getFeishuIMReplyRuntimeSummary()
  return {
    phase,
    status,
    accountCount: config.accounts.length,
    legacyActive: config.legacy.enabled,
    activeReplySinks: reply.activeSinks,
    pendingInteractions: reply.pendingInteractions,
    activeStreamingCards: reply.activeStreamingCards,
    cardUpdateFailures: reply.cardUpdateFailures,
    streamingFallbacks: reply.streamingFallbacks,
    lastReplyError: reply.lastReplyError,
    lastCardAction: reply.lastCardAction,
    lastCardUpdateError: reply.lastCardUpdateError,
    lastStreamingTransport: reply.lastStreamingTransport,
    lastStreamingFallbackReason: reply.lastStreamingFallbackReason,
    updatedAt: new Date().toISOString(),
  }
}

function event(
  level: PlatformRecentEvent['level'],
  stage: string,
  message: string,
  data?: Record<string, unknown>,
): PlatformRecentEvent {
  recentEventCounter += 1
  return {
    id: `feishu-im-${stage}-${Date.now()}-${recentEventCounter}`,
    at: new Date().toISOString(),
    level,
    stage,
    message,
    data,
  }
}

function legacyEvents(config: FeishuIMNormalizedConfig): PlatformRecentEvent[] {
  return config.legacy.enabled
    ? [event(
      'warn',
      'config',
      'Legacy feishu config is present but the legacy Feishu service is disabled; platform-feishu IM owns the websocket lifecycle.',
      { event: 'legacy-config-present' },
    )]
    : []
}

function mergedRecentEvents(
  config: FeishuIMNormalizedConfig,
  runtimeEvents: PlatformRecentEvent[],
): PlatformRecentEvent[] {
  return [
    ...legacyEvents(config),
    ...runtimeEvents,
    ...getFeishuIMReplyRuntimeRecentEvents(),
  ]
    .sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
    .slice(0, FEISHU_IM_RECENT_EVENT_LIMIT)
}

function createGatewayForAccount(options: {
  gatewayFactory: FeishuIMGatewayFactory
  account: FeishuIMAccount
  appSecret: string
  manager: FeishuIMRuntimeManagerHandle & {
    handleIncomingMessage(message: unknown): Promise<unknown>
  }
  controller: unknown
  onConnectionStateChange?: FeishuNodeIMGatewayOptions['onConnectionStateChange']
  onOperationalError?: FeishuNodeIMGatewayOptions['onOperationalError']
  continueUrlForSession: (sessionId: string) => string
  createCardActionHandler: (...args: any[]) => any
}): FeishuIMGatewayHandle {
  const {
    gatewayFactory,
    account,
    appSecret,
    manager,
    controller,
    onConnectionStateChange,
    onOperationalError,
    continueUrlForSession,
    createCardActionHandler,
  } = options
  return gatewayFactory({
    account,
    appSecret,
    onMessage: async (event) => {
      await manager.handleIncomingMessage(event.message)
    },
    onCardAction: createCardActionHandler({
      account,
      controller,
      manager,
      continueUrlForSession,
    }),
    onConnectionStateChange,
    onOperationalError,
  })
}

function createClient(
  sdk: typeof import('@larksuiteoapi/node-sdk'),
  account: FeishuIMAccount,
  appSecret: string,
) {
  const { AppType, Client, Domain, LoggerLevel } = sdk
  return new Client({
    appId: account.appId,
    appSecret,
    appType: AppType.SelfBuild,
    domain: Domain.Feishu,
    logger: {
      error: () => {},
      warn: () => {},
      info: () => {},
      debug: () => {},
      trace: () => {},
    },
    loggerLevel: LoggerLevel.info,
  })
}

function defaultDirectoryFor(ctx: PlatformBackgroundServiceContext, account: FeishuIMAccount): string {
  return account.defaultDirectory || ctx.projectDirectory || ctx.env.NINE1BOT_PROJECT_DIR || process.cwd()
}

async function resolveDirectory(baseDirectory: string | undefined, input: string): Promise<string> {
  const target = isAbsolute(input) ? resolve(input) : resolve(baseDirectory || process.cwd(), input)
  const stats = await stat(target)
  if (!stats.isDirectory()) throw new Error(`Not a directory: ${target}`)
  return target
}

function continueUrl(localUrl: string, sessionId: string): string {
  const url = new URL(localUrl)
  url.searchParams.set('session', sessionId)
  return url.toString()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
