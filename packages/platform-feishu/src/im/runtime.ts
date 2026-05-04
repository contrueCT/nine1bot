import type {
  PlatformAdapterContext,
  PlatformBackgroundService,
  PlatformBackgroundServiceContext,
  PlatformBackgroundServiceHandle,
  PlatformRecentEvent,
  PlatformRuntimeStatus,
  PlatformStatusCard,
} from '@nine1bot/platform-protocol'
import { normalizeFeishuIMConfig } from './config'
import type { FeishuIMNormalizedConfig, FeishuIMRuntimeSnapshot } from './types'
import { getFeishuIMReplyRuntimeSummary } from './reply-telemetry'

const FEISHU_IM_SERVICE_ID = 'feishu-im'

let latestSnapshot: FeishuIMRuntimeSnapshot | undefined

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

  constructor(private readonly ctx: PlatformBackgroundServiceContext) {
    this.status = statusFromConfig(this.config())
  }

  async start(): Promise<void> {
    const config = this.config()
    this.status = statusFromConfig(config)
    latestSnapshot = snapshotFrom(config, this.status)
  }

  async stop(): Promise<void> {
    const config = this.config()
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
      recentEvents: [event('error', 'config', 'Feishu IM enabled without a valid account')],
    }
  }

  if (config.legacy.enabled) {
    return {
      status: 'degraded',
      message: 'Legacy Feishu service is enabled, so the new IM background service is staged and will not open a websocket.',
      cards: cardsFromConfig(config, 'staged'),
      recentEvents: [event('warn', 'runtime', 'Feishu IM staged because legacy feishu.enabled is active')],
    }
  }

  return {
    status: 'degraded',
    message: 'Feishu IM background service is configured. Real websocket activation is deferred after Phase 1.',
    cards: cardsFromConfig(config, 'staged'),
    recentEvents: [event('info', 'runtime', 'Feishu IM skeleton staged without opening a websocket')],
  }
}

function cardsFromConfig(config: FeishuIMNormalizedConfig, phase: string): PlatformStatusCard[] {
  const reply = getFeishuIMReplyRuntimeSummary()
  return [
    {
      id: 'im-runtime',
      label: 'IM runtime',
      value: phase,
      tone: phase === 'error' ? 'danger' : phase === 'staged' ? 'warning' : 'neutral',
    },
    {
      id: 'im-accounts',
      label: 'IM accounts',
      value: String(config.accounts.length),
      tone: config.accounts.length > 0 ? 'success' : config.enabled ? 'danger' : 'neutral',
    },
    {
      id: 'im-buffer',
      label: 'IM buffer',
      value: `${config.policy.messageBufferMs}ms / max ${config.policy.maxBufferMs}ms`,
      tone: 'neutral',
    },
    {
      id: 'im-reply',
      label: 'IM reply',
      value: `${config.policy.replyPresentation} · ${config.policy.replyMode}`,
      tone: 'neutral',
    },
    {
      id: 'im-streaming-card',
      label: 'Streaming card',
      value: `${config.policy.streamingCardUpdateMs}ms / max ${config.policy.streamingCardMaxChars} chars`,
      tone: config.policy.replyPresentation === 'streaming-card' || config.policy.replyPresentation === 'auto' ? 'success' : 'neutral',
    },
    {
      id: 'im-active-sinks',
      label: 'Reply sinks',
      value: String(reply.activeSinks),
      tone: reply.activeSinks > 0 ? 'success' : 'neutral',
    },
    {
      id: 'im-active-turns',
      label: 'Active turns',
      value: String(reply.activeTurns),
      tone: reply.activeTurns > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'im-pending-buffers',
      label: 'Buffers',
      value: `${reply.pendingBuffers} routes / ${reply.bufferedMessages} messages`,
      tone: reply.pendingBuffers > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'im-pending-interactions',
      label: 'Interactions',
      value: String(reply.pendingInteractions),
      tone: reply.pendingInteractions > 0 ? 'warning' : 'neutral',
    },
    {
      id: 'im-active-streaming-cards',
      label: 'Streaming cards',
      value: String(reply.activeStreamingCards),
      tone: reply.activeStreamingCards > 0 ? 'success' : 'neutral',
    },
    {
      id: 'im-card-update-failures',
      label: 'Card failures',
      value: String(reply.cardUpdateFailures),
      tone: reply.cardUpdateFailures > 0 ? 'danger' : 'neutral',
    },
    {
      id: 'im-last-card-update-error',
      label: 'Card update error',
      value: reply.lastCardUpdateError ?? 'none',
      tone: reply.lastCardUpdateError ? 'danger' : 'neutral',
    },
    {
      id: 'im-last-reply-error',
      label: 'Reply error',
      value: reply.lastReplyError ?? 'none',
      tone: reply.lastReplyError ? 'danger' : 'neutral',
    },
    {
      id: 'im-last-card-action',
      label: 'Card action',
      value: reply.lastCardAction ?? 'none',
      tone: reply.lastCardAction ? 'success' : 'neutral',
    },
    {
      id: 'im-legacy',
      label: 'Legacy IM',
      value: config.legacy.enabled ? 'active' : 'inactive',
      tone: config.legacy.enabled ? 'warning' : 'neutral',
    },
  ]
}

function snapshotFrom(
  config: FeishuIMNormalizedConfig,
  status: PlatformRuntimeStatus,
  phase: FeishuIMRuntimeSnapshot['phase'] = status.status === 'error'
    ? 'error'
    : status.status === 'disabled'
      ? 'disabled'
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
    lastReplyError: reply.lastReplyError,
    lastCardAction: reply.lastCardAction,
    lastCardUpdateError: reply.lastCardUpdateError,
    updatedAt: new Date().toISOString(),
  }
}

function event(level: PlatformRecentEvent['level'], stage: string, message: string): PlatformRecentEvent {
  return {
    id: `feishu-im-${stage}-${Date.now()}`,
    at: new Date().toISOString(),
    level,
    stage,
    message,
  }
}
