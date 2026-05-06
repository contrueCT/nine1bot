import { describe, expect, test } from 'bun:test'
import type { PlatformAdapterContext, PlatformSecretRef } from '@nine1bot/platform-protocol'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  clearFeishuIMRuntimeSnapshotForTesting,
  createFeishuIMBackgroundServices,
  evaluateFeishuIMGate,
  FeishuEventDeduplicator,
  MemoryFeishuIMBindingStore,
  normalizeFeishuIMConfig,
  parseFeishuIMEvent,
  routeKeyForFeishuMessage,
  serializeFeishuRouteKey,
  validateFeishuIMConfig,
} from '../src/im'
import { FeishuFileIMBindingStore } from '../src/node'

const secretRef: PlatformSecretRef = {
  provider: 'nine1bot-local',
  key: 'platform:feishu:default:imDefaultAppSecret',
}

describe('Feishu IM skeleton', () => {
  test('normalizes platform settings without enabling from legacy config', () => {
    const config = normalizeFeishuIMConfig({
      imEnabled: false,
    }, {
      legacyConfig: {
        enabled: true,
        appId: 'legacy-app',
        appSecret: 'legacy-secret',
        defaultDirectory: 'C:/legacy',
      },
    })

    expect(config.enabled).toBe(false)
    expect(config.accounts).toEqual([])
    expect(config.legacy).toMatchObject({
      enabled: true,
      appId: 'legacy-app',
      hasAppSecret: true,
      defaultDirectory: 'C:/legacy',
    })
  })

  test('normalizes default account and rejects plaintext secrets inside account JSON', () => {
    const valid = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
      imDefaultDirectory: 'C:/work',
      imMessageBufferMs: 1200,
      imMaxBufferMs: 3000,
      imAccounts: [{
        id: 'team-a',
        appId: 'cli_team',
        appSecretRef: {
          provider: 'env',
          key: 'FEISHU_TEAM_SECRET',
        },
      }],
    })

    expect(valid.accounts.map((account) => account.id)).toEqual(['default', 'team-a'])
    expect(valid.policy).toMatchObject({
      messageBufferMs: 1200,
      maxBufferMs: 3000,
      groupPolicy: 'mention-only',
      replyPresentation: 'auto',
      replyTimeoutMs: 600_000,
      streamingCardUpdateMs: 1_000,
      streamingCardMaxChars: 6_000,
    })

    expect(validateFeishuIMConfig({
      imEnabled: true,
      imAccounts: [{
        id: 'bad',
        appId: 'cli_bad',
        appSecret: 'plaintext',
      }],
    })).toMatchObject({
      ok: false,
      fieldErrors: {
        imAccounts: expect.stringContaining('plaintext appSecret'),
      },
    })
  })

  test('validates enabled IM requires at least one secret-backed account', () => {
    expect(validateFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
    })).toMatchObject({
      ok: false,
      fieldErrors: {
        imAccounts: expect.stringContaining('At least one IM account'),
      },
    })
  })

  test('normalizes reply presentation and validates timeout settings', () => {
    expect(normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
      imReplyPresentation: 'streaming-card',
      imReplyTimeoutMs: 12_000,
      imStreamingCardUpdateMs: 800,
      imStreamingCardMaxChars: 2000,
    }).policy).toMatchObject({
      replyPresentation: 'streaming-card',
      replyTimeoutMs: 12_000,
      streamingCardUpdateMs: 800,
      streamingCardMaxChars: 2000,
    })

    expect(validateFeishuIMConfig({
      imReplyPresentation: 'unknown',
      imReplyTimeoutMs: 0,
      imStreamingCardUpdateMs: 0,
      imStreamingCardMaxChars: 0,
    })).toMatchObject({
      ok: false,
      fieldErrors: {
        imReplyPresentation: expect.stringContaining('auto'),
        imReplyTimeoutMs: expect.stringContaining('positive'),
        imStreamingCardUpdateMs: expect.stringContaining('positive'),
        imStreamingCardMaxChars: expect.stringContaining('positive'),
      },
    })
  })

  test('parses receive events, deduplicates events, and evaluates gate policies', () => {
    const message = parseFeishuIMEvent({
      header: {
        event_id: 'evt_1',
      },
      event: {
        sender: {
          sender_type: 'user',
          sender_id: {
            open_id: 'ou_sender',
          },
        },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          content: JSON.stringify({ text: '@bot hello' }),
          mentions: [{
            id: {
              open_id: 'ou_bot',
            },
            name: 'bot',
          }],
        },
      },
    })

    expect(message).toMatchObject({
      eventId: 'evt_1',
      messageId: 'om_1',
      chatId: 'oc_group',
      chatType: 'group',
      text: '@bot hello',
      sender: {
        openId: 'ou_sender',
        name: undefined,
      },
    })

    const dedup = new FeishuEventDeduplicator()
    expect(dedup.accept(message?.eventId)).toBe(true)
    expect(dedup.accept(message?.eventId)).toBe(false)

    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
      imGroupPolicy: 'mention-only',
    })
    expect(evaluateFeishuIMGate(message!, config, { botOpenId: 'ou_bot' })).toMatchObject({
      action: 'dispatch',
      allowed: true,
    })
    expect(evaluateFeishuIMGate(message!, config)).toMatchObject({
      action: 'dispatch',
      allowed: true,
    })
    expect(evaluateFeishuIMGate({
      ...message!,
      mentions: [],
    }, config)).toEqual({
      action: 'history',
      allowed: false,
      reason: 'mention-required',
    })
  })

  test('parses Feishu thread identifiers into isolated thread routes', () => {
    const message = parseFeishuIMEvent({
      event: {
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
          message_id: 'om_thread',
          chat_id: 'oc_group',
          chat_type: 'group',
          message_type: 'text',
          thread_id: 'omt_thread',
          content: JSON.stringify({ text: 'thread message' }),
        },
      },
    })!

    expect(serializeFeishuRouteKey(routeKeyForFeishuMessage(message, { accountId: 'acct' }))).toBe(
      'feishu:acct:thread:oc_group:omt_thread',
    )
  })

  test('builds stable route keys and stores bindings', async () => {
    const message = parseFeishuIMEvent({
      event: {
        sender: { sender_id: { open_id: 'ou_sender' } },
        message: {
          message_id: 'om_1',
          chat_id: 'oc_p2p',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hello' }),
        },
      },
    })!
    const routeKey = routeKeyForFeishuMessage(message)
    const serialized = serializeFeishuRouteKey(routeKey)
    const store = new MemoryFeishuIMBindingStore()

    await store.set(serialized, {
      routeKey,
      sessionId: 'ses_1',
      directory: 'C:/work',
      updatedAt: '2026-05-04T00:00:00.000Z',
    })

    await expect(store.get(serialized)).resolves.toMatchObject({
      sessionId: 'ses_1',
      routeKey: {
        accountId: 'default',
        kind: 'dm',
        chatId: 'oc_p2p',
      },
    })
  })

  test('persists v2 route bindings outside the removed legacy store', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nine1bot-feishu-im-store-'))
    try {
      const filepath = join(directory, 'bindings.json')
      const message = parseFeishuIMEvent({
        event: {
          sender: { sender_id: { open_id: 'ou_sender' } },
          message: {
            message_id: 'om_store',
            chat_id: 'oc_p2p',
            chat_type: 'p2p',
            message_type: 'text',
            content: JSON.stringify({ text: 'persist me' }),
          },
        },
      })!
      const routeKey = routeKeyForFeishuMessage(message, { accountId: 'acct' })
      const serialized = serializeFeishuRouteKey(routeKey)

      const first = new FeishuFileIMBindingStore({ filepath })
      await first.set(serialized, {
        routeKey,
        sessionId: 'ses_persisted',
        directory: 'C:/work',
        updatedAt: '2026-05-04T00:00:00.000Z',
      })

      const second = new FeishuFileIMBindingStore({ filepath })
      await expect(second.get(serialized)).resolves.toMatchObject({
        sessionId: 'ses_persisted',
        routeKey: {
          accountId: 'acct',
          kind: 'dm',
          openId: 'ou_sender',
        },
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test('stages platform IM on Windows when legacy Feishu config is still enabled', async () => {
    clearFeishuIMRuntimeSnapshotForTesting()
    const ctx = platformContext({
      imEnabled: true,
      imDefaultAppId: 'cli_xxx',
      imDefaultAppSecret: secretRef,
    })
    const services = createFeishuIMBackgroundServices(ctx)
    expect(services).toHaveLength(1)

    const handle = await services[0]!.start({
      ...ctx,
      localUrl: 'http://127.0.0.1:4096',
      legacySettings: {
        feishu: {
          enabled: true,
          appId: 'legacy',
          appSecret: 'secret',
        },
      },
    })

    expect(handle.getStatus?.()).toMatchObject({
      status: process.platform === 'win32' ? 'degraded' : 'error',
      message: process.platform === 'win32'
        ? expect.stringContaining('legacy feishu.enabled')
        : expect.stringContaining('Secret ref is missing'),
    })
    expect(handle.getStatus?.().recentEvents).toContainEqual(expect.objectContaining({
      message: process.platform === 'win32'
        ? expect.stringContaining('not started while legacy Feishu config is still enabled')
        : expect.stringContaining('legacy Feishu service is disabled'),
    }))
    await handle.stop()
  })
})

function platformContext(settings: Record<string, unknown>): PlatformAdapterContext {
  return {
    platformId: 'feishu',
    enabled: true,
    settings,
    features: {},
    env: {},
    secrets: {
      async get() { return undefined },
      async set() {},
      async delete() {},
      async has() { return false },
    },
    audit: {
      write() {},
    },
  }
}
