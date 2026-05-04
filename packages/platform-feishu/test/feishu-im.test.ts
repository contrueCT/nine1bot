import { describe, expect, test } from 'bun:test'
import type { PlatformAdapterContext, PlatformSecretRef } from '@nine1bot/platform-protocol'
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

  test('parses receive events, deduplicates events, and evaluates gate policies', () => {
    const message = parseFeishuIMEvent({
      header: {
        event_id: 'evt_1',
      },
      event: {
        sender: {
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
    expect(evaluateFeishuIMGate(message!, config, { botOpenId: 'ou_bot' })).toEqual({
      allowed: true,
    })
    expect(evaluateFeishuIMGate({
      ...message!,
      mentions: [],
    }, config, { botOpenId: 'ou_bot' })).toEqual({
      allowed: false,
      reason: 'mention-required',
    })
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
        chatId: 'oc_p2p',
      },
    })
  })

  test('stages background service when legacy Feishu service is active', async () => {
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
      status: 'degraded',
      message: expect.stringContaining('Legacy Feishu service is enabled'),
    })
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
