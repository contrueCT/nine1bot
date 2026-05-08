import { describe, expect, test } from 'bun:test'
import type { PlatformSecretRef } from '@nine1bot/platform-protocol'
import {
  answerFeishuCardInteraction,
  clearFeishuIMReplyRuntimeSummaryForTesting,
  createFeishuIMCardActionHandler,
  createFeishuIMImmediateReplyHandler,
  createFeishuIMReplySinkFactory,
  FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID,
  FeishuIMSessionManager,
  FeishuReplySink,
  formatFeishuCardActionResponse,
  getFeishuIMReplyRuntimeRecentEvents,
  getFeishuIMReplyRuntimeSummary,
  MemoryFeishuIMBindingStore,
  MemoryFeishuIMReplyClient,
  normalizeFeishuIMConfig,
  parseFeishuCardAction,
  renderFeishuStreamingTurnCard,
  routeKeyForFeishuMessage,
  serializeFeishuRouteKey,
  type FeishuCardActionPayload,
  type FeishuControllerBridge,
  type FeishuControllerCreateSessionInput,
  type FeishuControllerCreateSessionResult,
  type FeishuControllerMessageResult,
  type FeishuControllerProject,
  type FeishuControllerSendMessageInput,
  type FeishuControllerSession,
  type FeishuControllerTurnResult,
  type FeishuIMCard,
  type FeishuIMCardEntity,
  type FeishuIMAccount,
  type FeishuIMIncomingMessage,
  type FeishuIMSentMessage,
  type FeishuRuntimeEventEnvelope,
  type FeishuRuntimeEventSubscription,
} from '../src/im'
import { createFeishuNodeReplyClient } from '../src/node'

const secretRef: PlatformSecretRef = {
  provider: 'nine1bot-local',
  key: 'platform:feishu:default:imDefaultAppSecret',
}

const account: FeishuIMAccount = {
  id: 'default',
  enabled: true,
  appId: 'cli_xxx',
  appSecretRef: secretRef,
  defaultDirectory: 'C:/work',
  connectionMode: 'websocket',
}

describe('Feishu IM reply sink', () => {
  test('text sink sends deltas and finishes on normalized turn completion', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const routeKey = routeKeyForFeishuMessage(message(), { accountId: account.id })
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey,
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'message',
      presentation: 'text',
      timeoutMs: 10_000,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_1',
      data: {
        delta: { text: 'hello' },
      },
    })
    await bridge.emit({
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_1',
      data: { status: 'idle' },
    })

    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    expect(client.texts).toEqual([expect.objectContaining({ text: 'hello' })])
  })

  test('reply sink releases completion even when terminal delivery fails', async () => {
    const bridge = new EventBridge()
    const client = new FailingTextReplyClient()
    const routeKey = routeKeyForFeishuMessage(message(), { accountId: account.id })
    const errors: Error[] = []
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey,
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'message',
      presentation: 'text',
      timeoutMs: 10_000,
      onError: (error) => {
        errors.push(error)
      },
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_1',
      data: { status: 'idle' },
    })

    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    expect(errors.at(-1)?.message).toContain('send text failed')
  })

  test('streaming card polls completed session result when runtime events are missed', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    bridge.latestTurnResult = {
      completed: true,
      text: '已记录请假申请到飞书多维表格。',
    }
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      directory: 'C:/work',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 5,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })

    const finalCard = JSON.stringify(client.updates.at(-1)?.card)
    expect(finalCard).toContain('已记录请假申请')
    expect(client.updates.at(-1)?.card).toEqual(expect.objectContaining({
      header: expect.objectContaining({ template: 'green' }),
    }))
  })

  test('card sink creates and updates simplified cards for progress and errors', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const routeKey = routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id })
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey,
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'card',
      timeoutMs: 10_000,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'message.part.updated',
      properties: {
        turnSnapshotId: 'turn_1',
        part: { id: 'part_1', type: 'text', text: 'first draft' },
      },
    })
    await bridge.emit({
      type: 'session.error',
      properties: {
        turnSnapshotId: 'turn_1',
        error: { message: 'boom' },
      },
    })

    await expect(sink.done).resolves.toMatchObject({ status: 'error' })
    expect(client.cards).toHaveLength(1)
    expect(client.updates.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(client.updates.at(-1)?.card)).toContain('boom')
  })

  test('permission and question card actions answer controller interactions', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const routeKey = routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id })
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey,
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'message',
      presentation: 'card',
      timeoutMs: 10_000,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.interaction.requested',
      turnSnapshotId: 'turn_1',
      data: {
        kind: 'permission',
        requestId: 'perm_1',
        permission: 'edit',
        patterns: ['src/*'],
      },
    })
    await bridge.emit({
      type: 'runtime.interaction.requested',
      turnSnapshotId: 'turn_1',
      data: {
        kind: 'question',
        requestId: 'question_1',
        questions: [{
          question: 'Choose one',
          options: [{ label: 'A', description: 'Option A' }],
        }],
      },
    })

    expect(client.cards).toHaveLength(3)
    const permissionAction = parseFirstPayload(client.cards[1]!.card)
    await expect(answerFeishuCardInteraction({
      controller: bridge,
      payload: permissionAction,
      expected: {
        accountId: account.id,
        routeKey: serializeFeishuRouteKey(routeKey),
        sessionId: 'ses_1',
        turnSnapshotId: 'turn_1',
      },
    })).resolves.toMatchObject({ status: 'answered', requestId: 'perm_1' })

    const questionAction = parseFirstPayload(client.cards[2]!.card, 'question.answer')
    await expect(answerFeishuCardInteraction({
      controller: bridge,
      payload: questionAction,
      value: { answer: 'A' },
    })).resolves.toMatchObject({ status: 'answered', requestId: 'question_1' })

    expect(bridge.answers).toEqual([
      expect.objectContaining({ requestId: 'perm_1', answer: 'allow-once' }),
      expect.objectContaining({ requestId: 'question_1', answer: { answers: [['A']] } }),
    ])
    sink.stop()
  })

  test('auto presentation uses text for DM and streaming card for group routes', async () => {
    const dmBridge = new EventBridge()
    const dmClient = new MemoryFeishuIMReplyClient()
    const dmSink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message(), { accountId: account.id }),
      sessionId: 'ses_dm',
      controller: dmBridge,
      client: dmClient,
      replyMode: 'message',
      presentation: 'auto',
      timeoutMs: 10_000,
    })

    await dmSink.start()
    await dmSink.bindTurnSnapshotId('turn_dm')
    await dmBridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_dm',
      data: { delta: { text: 'dm text' } },
    })
    await dmBridge.emit({
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_dm',
    })
    await expect(dmSink.done).resolves.toMatchObject({ status: 'final' })
    expect(dmClient.texts).toEqual([expect.objectContaining({ text: 'dm text' })])
    expect(dmClient.cards).toHaveLength(0)

    const groupBridge = new EventBridge()
    const groupClient = new MemoryFeishuIMReplyClient()
    const groupSink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_group',
      controller: groupBridge,
      client: groupClient,
      replyMode: 'thread',
      presentation: 'auto',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 20,
    })

    await groupSink.start()
    await groupSink.bindTurnSnapshotId('turn_group')
    expect(groupClient.cards).toHaveLength(1)
    expect(JSON.stringify(groupClient.cards[0]?.card)).toContain('停止')
    groupSink.stop()
  })

  test('streaming card throttles running updates and flushes terminal state immediately', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 30,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'a' } } })
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'b' } } })
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'c' } } })
    expect(client.updates).toHaveLength(0)
    await sleep(45)
    expect(client.updates).toHaveLength(1)
    expect(JSON.stringify(client.updates[0]?.card)).toContain('abc')

    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'd' } } })
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    expect(client.updates.at(-1)?.card).toEqual(expect.objectContaining({
      header: expect.objectContaining({ template: 'green' }),
    }))
    expect(JSON.stringify(client.updates.at(-1)?.card)).toContain('abcd')
  })

  test('streaming card hides pre-tool assistant notes and waits for post-tool final text', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 5,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_1',
      data: { delta: { text: '用户想要查看当前目录下有什么文件。我需要使用 bash 命令来列出目录内容。' } },
    })
    await sleep(15)
    expect(JSON.stringify(client.updates.at(-1)?.card)).toContain('我需要使用 bash')

    await bridge.emit({
      type: 'runtime.tool.started',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        input: { description: 'List files in current directory', command: 'ls -la' },
      },
    })
    await sleep(15)
    const toolCard = JSON.stringify(client.updates.at(-1)?.card)
    expect(toolCard).toContain('工具状态')
    expect(toolCard).not.toContain('我需要使用 bash')

    await bridge.emit({
      type: 'runtime.tool.completed',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        title: 'List files in current directory',
        durationMs: 105,
      },
    })
    await sleep(15)
    expect(JSON.stringify(client.updates.at(-1)?.card)).not.toContain('工具状态')
    await bridge.emit({
      type: 'session.idle',
      properties: {
        turnSnapshotId: 'turn_1',
      },
    })

    await sleep(80)
    await bridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_1',
      data: {
        delta: {
          text: '当前目录 C:\\code\\nine1bot 包含：docs、opencode、packages、scripts、web。',
        },
      },
    })

    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    const finalCard = JSON.stringify(client.updates.at(-1)?.card)
    expect(finalCard).toContain('当前目录 C:\\\\code\\\\nine1bot 包含')
    expect(finalCard).not.toContain('工具状态')
    expect(finalCard).not.toContain('我需要使用 bash')
    expect(finalCard).not.toContain('用户想要查看当前目录')
  })

  test('streaming card defers direct turn completion until post-tool final text arrives', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 5,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    let resolved = false
    void sink.done.then(() => {
      resolved = true
    })

    await bridge.emit({
      type: 'runtime.tool.started',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        input: { command: 'pwd' },
      },
    })
    await sleep(15)
    expect(JSON.stringify(client.updates.at(-1)?.card)).toContain('工具状态')

    await bridge.emit({
      type: 'runtime.tool.completed',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        title: 'Print working directory',
      },
    })
    await bridge.emit({
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_1',
    })

    await sleep(100)
    expect(resolved).toBe(false)

    await bridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_1',
      data: {
        delta: {
          text: '当前工作目录是 C:\\code\\nine1bot。',
        },
      },
    })

    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    const finalCard = JSON.stringify(client.updates.at(-1)?.card)
    expect(finalCard).toContain('当前工作目录是 C:\\\\code\\\\nine1bot')
    expect(finalCard).not.toContain('工具状态')
  })

  test('node message patch keeps the original card identity when Feishu returns empty data', async () => {
    const bridge = new EventBridge()
    const calls = {
      replies: [] as unknown[],
      patches: [] as unknown[],
    }
    const client = createFeishuNodeReplyClient({
      client: {
        im: {
          message: {
            reply: async (input: unknown) => {
              calls.replies.push(input)
              return {
                code: 0,
                data: {
                  message_id: 'om_card_1',
                  card_id: 'card_1',
                },
              }
            },
            patch: async (input: unknown) => {
              calls.patches.push(input)
              return { code: 0, data: {} }
            },
          },
        },
      },
    })
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 5,
      rootMessageId: 'om_user_1',
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'hello' } } })
    await sleep(15)
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })

    expect(calls.replies).toHaveLength(1)
    expect(calls.patches.length).toBeGreaterThanOrEqual(1)
    expect(calls.patches.every((call) => messageIdFromPatchCall(call) === 'om_card_1')).toBe(true)
  })

  test('CardKit create failure falls back to message patch without creating a second card', async () => {
    const bridge = new EventBridge()
    const calls = {
      cardKitCreates: [] as unknown[],
      replies: [] as unknown[],
      patches: [] as unknown[],
    }
    const client = createFeishuNodeReplyClient({
      client: {
        im: {
          message: {
            reply: async (input: unknown) => {
              calls.replies.push(input)
              return {
                code: 0,
                data: {
                  message_id: 'om_fallback_card',
                  card_id: 'fallback_card',
                },
              }
            },
            patch: async (input: unknown) => {
              calls.patches.push(input)
              return { code: 0, data: {} }
            },
          },
        },
        cardkit: {
          v1: {
            card: {
              create: async (input: unknown) => {
                calls.cardKitCreates.push(input)
                return {
                  code: 300303,
                  msg: 'cardkit create denied',
                  error: {
                    log_id: 'log_cardkit_create',
                    troubleshooter: 'https://open.feishu.cn/trouble',
                  },
                }
              },
            },
          },
        },
      },
    })
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 5,
      rootMessageId: 'om_user_1',
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'fallback text' } } })
    await sleep(15)
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })

    expect(calls.cardKitCreates).toHaveLength(1)
    expect(calls.replies).toHaveLength(1)
    expect(calls.patches.length).toBeGreaterThanOrEqual(1)
    expect(calls.patches.every((call) => messageIdFromPatchCall(call) === 'om_fallback_card')).toBe(true)
  })

  test('streaming card uses CardKit native transport when client supports it', async () => {
    const bridge = new EventBridge()
    const client = new CardKitReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 20,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    expect(client.entities).toHaveLength(1)
    expect(client.entityMessages).toEqual([expect.objectContaining({ cardId: 'entity_1' })])
    expect(client.cards).toHaveLength(0)

    await bridge.emit({
      type: 'runtime.tool.started',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        input: { command: 'pwd', token: 'hidden-secret' },
      },
    })
    await sleep(35)
    expect(client.streams).toEqual(expect.arrayContaining([
      expect.objectContaining({
        cardId: 'entity_1',
        elementId: 'nine1bot_streaming_content',
        content: '正在等待 Agent 输出...',
      }),
      expect.objectContaining({
        cardId: 'entity_1',
        elementId: FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID,
      }),
    ]))
    const runningToolStream = lastCardKitStream(client.streams, FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID)
    expect(runningToolStream?.content).toContain('工具状态')
    expect(runningToolStream?.content).toContain('bash')
    expect(runningToolStream?.content).toContain('pwd')
    expect(runningToolStream?.content).not.toContain('hidden-secret')

    await bridge.emit({
      type: 'runtime.tool.completed',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        title: 'Print working directory',
      },
    })
    await sleep(35)
    expect(lastCardKitStream(client.streams, FEISHU_STREAMING_CARD_TOOL_ELEMENT_ID)?.content).toBe('')

    bridge.latestTurnResult = {
      completed: true,
      text: '当前工作目录是 C:/code/nine1bot。',
    }
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
    const finalCard = JSON.stringify(client.entityUpdates.at(-1)?.card)
    expect(finalCard).toContain('当前工作目录是 C:/code/nine1bot。')
    expect(finalCard).not.toContain('工具状态')
    expect(client.settings.at(-1)).toEqual(expect.objectContaining({
      cardId: 'entity_1',
      streaming: false,
    }))
    expect(client.updates).toHaveLength(0)
  })

  test('streaming card falls back from CardKit content to message patch', async () => {
    clearFeishuIMReplyRuntimeSummaryForTesting()
    const bridge = new EventBridge()
    const client = new FailingCardKitContentReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 10,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'fallback text' } } })
    await sleep(20)
    expect(client.streams).toHaveLength(1)
    expect(client.updates.length).toBeGreaterThan(0)
    expect(JSON.stringify(client.updates.at(-1)?.card)).toContain('fallback text')
    expect(client.texts).toHaveLength(0)
    const summary = getFeishuIMReplyRuntimeSummary()
    expect(summary.streamingFallbacks).toBeGreaterThan(0)
    expect(summary.lastStreamingTransport).toBe('patch')
    expect(getFeishuIMReplyRuntimeRecentEvents()).toContainEqual(expect.objectContaining({
      stage: 'im-reply',
      data: expect.objectContaining({
        event: 'streaming-fallback',
        transport: 'patch',
        reason: 'cardkit content failed',
      }),
    }))
    sink.stop()
  })

  test('streaming group cards hide internal session route and transport metadata', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 10,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({ type: 'runtime.message.part.updated', turnSnapshotId: 'turn_1', data: { delta: { text: 'clean content' } } })
    await sleep(15)
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })

    for (const card of [client.cards[0]?.card, ...client.updates.map((update) => update.card)]) {
      const rendered = JSON.stringify(card)
      expect(rendered).not.toContain('Session')
      expect(rendered).not.toContain('Route')
      expect(rendered).not.toContain('投递')
      expect(rendered).not.toContain('cardkit create failed')
    }
  })

  test('new card action trigger responses wrap updated cards in the official raw card envelope', () => {
    const routeKey = routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id })
    const card = renderFeishuStreamingTurnCard({
      accountId: account.id,
      routeKey,
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
      status: 'running',
      maxChars: 1000,
      content: 'working',
    })

    const response = formatFeishuCardActionResponse({
      header: {
        event_type: 'card.action.trigger',
      },
    }, card)
    expect(response).toMatchObject({
      toast: {
        type: 'success',
      },
      card: {
        type: 'raw',
        data: card,
      },
    })
    expect(parseFirstPayload((response as { card: { data: FeishuIMCard } }).card.data, 'turn.abort')).toMatchObject({
      action: 'turn.abort',
      routeKey: serializeFeishuRouteKey(routeKey),
    })

    expect(formatFeishuCardActionResponse({
      header: {
        event_type: 'card.action.trigger_v1',
      },
    }, card)).toBe(card)
  })

  test('Feishu API errors include response troubleshooting fields', async () => {
    const client = createFeishuNodeReplyClient({
      client: {
        im: {
          message: {
            reply: async () => ({
              code: 19001,
              msg: 'permission denied',
              error: {
                log_id: 'log_permission',
                troubleshooter: 'https://open.feishu.cn/trouble',
              },
            }),
          },
        },
      },
    })

    await expect(client.sendCard({
      chatId: 'oc_group',
      rootMessageId: 'om_user',
      replyTarget: 'thread',
      card: { elements: [] },
    })).rejects.toThrow(/im\.message\.reply failed: code=19001, msg=permission denied, log_id=log_permission, troubleshooter=https:\/\/open\.feishu\.cn\/trouble/)
  })

  test('streaming card renders only the current running tool status', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 10,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.tool.started',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        input: {
          command: 'bun test',
          token: 'super-secret',
        },
      },
    })
    await sleep(15)
    const rendered = JSON.stringify(client.updates.at(-1)?.card)
    expect(rendered).toContain('工具状态')
    expect(rendered).toContain('bash')
    expect(rendered).toContain('bun test')
    expect(rendered).not.toContain('super-secret')

    await bridge.emit({
      type: 'runtime.tool.completed',
      turnSnapshotId: 'turn_1',
      data: {
        toolCallId: 'tool_1',
        tool: 'bash',
        title: 'Run tests',
      },
    })
    await sleep(15)
    expect(JSON.stringify(client.updates.at(-1)?.card)).not.toContain('工具状态')
    sink.stop()
  })

  test('streaming card truncates long content and degrades when card update fails', async () => {
    clearFeishuIMReplyRuntimeSummaryForTesting()
    const bridge = new EventBridge()
    const client = new FailingUpdateReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 10,
      streamingCardMaxChars: 5,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    await bridge.emit({
      type: 'runtime.message.part.updated',
      turnSnapshotId: 'turn_1',
      data: { delta: { text: '123456789' } },
    })
    await sleep(25)
    expect(client.updates).toHaveLength(1)
    expect(JSON.stringify(client.updates[0]?.card)).toContain('内容较长')
    expect(client.texts.at(-1)?.text).toContain('流式卡片更新失败')
    expect(getFeishuIMReplyRuntimeSummary().cardUpdateFailures).toBeGreaterThan(0)
    expect(getFeishuIMReplyRuntimeRecentEvents()).toContainEqual(expect.objectContaining({
      stage: 'im-reply',
      data: expect.objectContaining({
        event: 'card-update-failed',
      }),
    }))
    expect(getFeishuIMReplyRuntimeRecentEvents().filter((event) => event.data?.event === 'reply-error')).toHaveLength(0)
    sink.stop()
  })

  test('streaming card degrades when initial card send fails without failing the sink', async () => {
    const bridge = new EventBridge()
    const client = new FailingSendCardReplyClient()
    const sink = new FeishuReplySink({
      accountId: account.id,
      routeKey: routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: account.id }),
      sessionId: 'ses_1',
      controller: bridge,
      client,
      replyMode: 'thread',
      presentation: 'streaming-card',
      timeoutMs: 10_000,
      streamingCardUpdateMs: 10,
    })

    await sink.start()
    await sink.bindTurnSnapshotId('turn_1')
    expect(client.texts.at(-1)?.text).toContain('流式卡片更新失败')
    await bridge.emit({ type: 'runtime.turn.completed', turnSnapshotId: 'turn_1' })
    await expect(sink.done).resolves.toMatchObject({ status: 'final' })
  })
})

describe('Feishu IM reply coordinator with session manager', () => {
  test('accepted turn keeps route busy until reply sink finishes', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: account.appId,
      imDefaultAppSecret: secretRef,
      imMessageBufferMs: 0,
      imMaxBufferMs: 1000,
      imBusyRejectText: 'busy text',
      imReplyPresentation: 'text',
    })
    const manager = new FeishuIMSessionManager({
      account,
      config,
      controller: bridge,
      store: new MemoryFeishuIMBindingStore(),
      replySinkFactory: createFeishuIMReplySinkFactory({
        account,
        config,
        controller: bridge,
        client,
      }),
      onImmediateReply: createFeishuIMImmediateReplyHandler({
        account,
        config,
        client,
      }),
    })

    await expect(manager.handleIncomingMessage(message({ text: 'hello', messageId: 'om_1' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    await expect(manager.handleIncomingMessage(message({ text: 'second', messageId: 'om_2' }))).resolves.toMatchObject({
      status: 'busy',
      message: 'busy text',
    })
    expect(client.texts.at(-1)?.text).toBe('busy text')

    await bridge.emit({
      type: 'runtime.turn.completed',
      turnSnapshotId: 'turn_1',
      data: { status: 'idle' },
    })
    await expect(manager.handleIncomingMessage(message({ text: 'after done', messageId: 'om_3' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_2',
    })
  })

  test('abort result is delivered as immediate reply text', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: account.appId,
      imDefaultAppSecret: secretRef,
      imMessageBufferMs: 0,
      imMaxBufferMs: 1000,
      imReplyPresentation: 'text',
    })
    const manager = new FeishuIMSessionManager({
      account,
      config,
      controller: bridge,
      store: new MemoryFeishuIMBindingStore(),
      replySinkFactory: createFeishuIMReplySinkFactory({
        account,
        config,
        controller: bridge,
        client,
      }),
      onImmediateReply: createFeishuIMImmediateReplyHandler({
        account,
        config,
        client,
      }),
    })

    await expect(manager.handleIncomingMessage(message({ text: 'long task', messageId: 'om_1' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    await expect(manager.handleIncomingMessage(message({ text: '/abort', messageId: 'om_abort' }))).resolves.toMatchObject({
      status: 'aborted',
      sessionId: 'ses_1',
    })

    expect(bridge.aborts).toEqual([expect.objectContaining({ sessionId: 'ses_1', directory: 'C:/work' })])
    expect(client.texts.at(-1)?.text).toBe('已取消当前飞书会话的 Agent turn。')
  })

  test('control action handler supports new session and project list', async () => {
    const bridge = new EventBridge({
      projects: [{
        id: 'proj_1',
        name: 'Project One',
        rootDirectory: 'C:/project-one',
      }],
    })
    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: account.appId,
      imDefaultAppSecret: secretRef,
      imMessageBufferMs: 0,
      imMaxBufferMs: 1000,
    })
    const manager = new FeishuIMSessionManager({
      account,
      config,
      controller: bridge,
      store: new MemoryFeishuIMBindingStore(),
    })
    const routeKey = routeKeyForFeishuMessage(message(), { accountId: account.id })
    const routeKeyString = serializeFeishuRouteKey(routeKey)
    await manager.resolveOrCreateSession(routeKey)

    await expect(manager.handleIncomingMessage(message({ text: '/control' }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'control-panel',
        routeKey: routeKeyString,
      },
    })

    const payload: FeishuCardActionPayload = {
      v: 1,
      accountId: account.id,
      routeKey: routeKeyString,
      sessionId: 'ses_1',
      action: 'control.projectList',
      nonce: 'nonce',
      issuedAt: new Date().toISOString(),
    }
    await expect(manager.handleCardAction(payload)).resolves.toMatchObject({
      type: 'project-list',
      projects: [{ id: 'proj_1', name: 'Project One' }],
    })
  })

  test('card action handler returns updated control cards for project list and cwd', async () => {
    const bridge = new EventBridge({
      projects: [{
        id: 'proj_1',
        name: 'Project One',
        rootDirectory: 'C:/project-one',
      }],
    })
    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: account.appId,
      imDefaultAppSecret: secretRef,
      imMessageBufferMs: 0,
      imMaxBufferMs: 1000,
    })
    const manager = new FeishuIMSessionManager({
      account,
      config,
      controller: bridge,
      store: new MemoryFeishuIMBindingStore(),
    })
    const routeKey = routeKeyForFeishuMessage(message(), { accountId: account.id })
    const routeKeyString = serializeFeishuRouteKey(routeKey)
    await manager.resolveOrCreateSession(routeKey)
    const handler = createFeishuIMCardActionHandler({
      account,
      controller: bridge,
      manager,
      continueUrlForSession: (sessionId) => `http://127.0.0.1:4096/?session=${sessionId}`,
    })

    const projectListPayload: FeishuCardActionPayload = {
      v: 1,
      accountId: account.id,
      routeKey: routeKeyString,
      sessionId: 'ses_1',
      action: 'control.projectList',
      nonce: 'nonce-project-list',
      issuedAt: new Date().toISOString(),
    }
    const projectListCard = await handler({
      accountId: account.id,
      payload: projectListPayload,
      value: {},
      raw: {},
    })
    expect(JSON.stringify(projectListCard)).toContain('Project One')
    expect(JSON.stringify(projectListCard)).toContain('control.showCwd')

    const cwdCard = await handler({
      accountId: account.id,
      payload: {
        ...projectListPayload,
        action: 'control.showCwd',
        nonce: 'nonce-cwd',
      },
      value: {},
      raw: {},
    })
    expect(JSON.stringify(cwdCard)).toContain('当前目录')
    expect(JSON.stringify(cwdCard)).toContain('C:/work')
  })

  test('streaming card abort action cancels only the current active turn', async () => {
    const bridge = new EventBridge()
    const client = new MemoryFeishuIMReplyClient()
    const config = normalizeFeishuIMConfig({
      imEnabled: true,
      imDefaultAppId: account.appId,
      imDefaultAppSecret: secretRef,
      imMessageBufferMs: 0,
      imMaxBufferMs: 1000,
      imReplyPresentation: 'streaming-card',
      imStreamingCardUpdateMs: 20,
    })
    const manager = new FeishuIMSessionManager({
      account,
      config,
      controller: bridge,
      store: new MemoryFeishuIMBindingStore(),
      replySinkFactory: createFeishuIMReplySinkFactory({
        account,
        config,
        controller: bridge,
        client,
      }),
    })

    await expect(manager.handleIncomingMessage(message({ text: 'run', messageId: 'om_1' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    const payload = parseFirstPayload(client.cards[0]!.card, 'turn.abort')
    await expect(manager.handleCardAction({
      ...payload,
      turnSnapshotId: 'old_turn',
    })).resolves.toMatchObject({
      type: 'failed',
      message: expect.stringContaining('turn'),
    })
    const { turnSnapshotId: _turnSnapshotId, ...payloadWithoutTurn } = payload
    await expect(manager.handleCardAction(payloadWithoutTurn)).resolves.toMatchObject({
      type: 'failed',
      message: expect.stringContaining('turn'),
    })
    expect(bridge.aborts).toHaveLength(0)

    await expect(manager.handleCardAction(payload)).resolves.toMatchObject({
      type: 'turn-aborted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    expect(bridge.aborts).toEqual([expect.objectContaining({ sessionId: 'ses_1', directory: 'C:/work' })])
    expect(manager.activeTurnSnapshot()).toEqual([])
  })
})

function message(input: {
  text?: string
  messageId?: string
  chatType?: 'p2p' | 'group'
  chatId?: string
  openId?: string
  rootId?: string
} = {}): FeishuIMIncomingMessage {
  return {
    eventId: `evt_${input.messageId ?? '1'}`,
    messageId: input.messageId ?? 'om_1',
    chatId: input.chatId ?? 'oc_dm',
    chatType: input.chatType ?? 'p2p',
    rootId: input.rootId,
    messageType: 'text',
    text: input.text ?? 'hello',
    sender: {
      openId: input.openId ?? 'ou_alice',
      name: 'Alice',
    },
    mentions: [],
    createTime: 1_778_000_000_000,
    raw: {},
  }
}

function parseFirstPayload(card: Record<string, unknown>, action?: string): FeishuCardActionPayload {
  const raw = JSON.stringify(card)
  const parsed = JSON.parse(raw) as any
  const buttons: any[] = []
  for (const element of parsed.elements ?? []) {
    for (const button of element.actions ?? []) {
      if (button.value?.nine1bot && (!action || button.value.nine1bot.action === action)) {
        buttons.push(button)
      }
    }
  }
  const result = parseFeishuCardAction({ action: { value: buttons[0]!.value } })
  if (!result.ok) throw new Error(result.reason)
  return result.payload
}

function messageIdFromPatchCall(input: unknown): string | undefined {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : undefined
  const path = record?.path && typeof record.path === 'object' ? record.path as Record<string, unknown> : undefined
  return typeof path?.message_id === 'string' ? path.message_id : undefined
}

function lastCardKitStream(
  streams: Array<{ cardId: string; elementId: string; content: string; sequence: number }>,
  elementId: string,
) {
  return [...streams].reverse().find((stream) => stream.elementId === elementId)
}

class EventBridge implements FeishuControllerBridge {
  sessions = new Map<string, FeishuControllerSession>()
  sent: FeishuControllerSendMessageInput[] = []
  aborts: any[] = []
  answers: any[] = []
  latestTurnResult?: FeishuControllerTurnResult
  private sequence = 0
  private subscribers: Array<(event: FeishuRuntimeEventEnvelope) => void | Promise<void>> = []

  constructor(private readonly options: {
    projects?: FeishuControllerProject[]
  } = {}) {}

  async createSession(input: FeishuControllerCreateSessionInput): Promise<FeishuControllerCreateSessionResult> {
    const id = `ses_${++this.sequence}`
    const session = {
      id,
      directory: input.directory ?? 'C:/work',
      projectID: this.projectForDirectory(input.directory)?.id,
      title: input.title,
    }
    this.sessions.set(id, session)
    return { sessionId: id, session }
  }

  async getSession(input: { sessionId: string }): Promise<FeishuControllerSession | undefined> {
    return this.sessions.get(input.sessionId)
  }

  async sendMessage(input: FeishuControllerSendMessageInput): Promise<FeishuControllerMessageResult> {
    this.sent.push(input)
    return {
      accepted: true,
      sessionId: input.sessionId,
      turnSnapshotId: `turn_${this.sent.length}`,
      status: 202,
    }
  }

  async getLatestTurnResult(): Promise<FeishuControllerTurnResult | undefined> {
    return this.latestTurnResult
  }

  async abortSession(input: any): Promise<boolean> {
    this.aborts.push(input)
    return true
  }

  async answerInteraction(input: any): Promise<boolean> {
    this.answers.push(input)
    return true
  }

  async listProjects(): Promise<FeishuControllerProject[]> {
    return this.options.projects ?? []
  }

  async getProject(projectId: string): Promise<FeishuControllerProject | undefined> {
    return (this.options.projects ?? []).find((project) => project.id === projectId)
  }

  subscribeEvents(input: {
    onEvent: (event: FeishuRuntimeEventEnvelope) => void | Promise<void>
  }): FeishuRuntimeEventSubscription {
    this.subscribers.push(input.onEvent)
    return {
      stop: () => {
        this.subscribers = this.subscribers.filter((subscriber) => subscriber !== input.onEvent)
      },
    }
  }

  async emit(event: FeishuRuntimeEventEnvelope): Promise<void> {
    await Promise.all(this.subscribers.map((subscriber) => subscriber(event)))
  }

  private projectForDirectory(directory: string | undefined): FeishuControllerProject | undefined {
    return (this.options.projects ?? []).find((project) => project.rootDirectory === directory || project.worktree === directory)
  }
}

class FailingUpdateReplyClient extends MemoryFeishuIMReplyClient {
  async updateCard(input: { messageId?: string; cardId?: string; card: Record<string, unknown> }): Promise<FeishuIMSentMessage> {
    this.updates.push(JSON.parse(JSON.stringify(input)))
    throw new Error('update failed')
  }
}

class FailingTextReplyClient extends MemoryFeishuIMReplyClient {
  async sendText(input: { chatId: string; rootMessageId?: string; replyTarget: 'message' | 'thread'; text: string }): Promise<FeishuIMSentMessage> {
    this.texts.push(JSON.parse(JSON.stringify(input)))
    throw new Error('send text failed')
  }
}

class CardKitReplyClient extends MemoryFeishuIMReplyClient {
  readonly entities: Array<{ card: FeishuIMCard }> = []
  readonly entityMessages: Array<{ chatId: string; rootMessageId?: string; replyTarget: 'message' | 'thread'; cardId: string }> = []
  readonly streams: Array<{ cardId: string; elementId: string; content: string; sequence: number }> = []
  readonly entityUpdates: Array<{ cardId: string; card: FeishuIMCard; sequence: number }> = []
  readonly settings: Array<{ cardId: string; streaming: boolean; sequence: number }> = []

  async createCardEntity(input: { card: FeishuIMCard }): Promise<FeishuIMCardEntity> {
    this.entities.push(JSON.parse(JSON.stringify(input)))
    return { cardId: `entity_${this.entities.length}` }
  }

  async sendCardEntity(input: {
    chatId: string
    rootMessageId?: string
    replyTarget: 'message' | 'thread'
    cardId: string
  }): Promise<FeishuIMSentMessage> {
    this.entityMessages.push(JSON.parse(JSON.stringify(input)))
    return {
      messageId: `entity_message_${this.entityMessages.length}`,
      cardId: input.cardId,
    }
  }

  async streamCardContent(input: {
    cardId: string
    elementId: string
    content: string
    sequence: number
  }): Promise<void> {
    this.streams.push(JSON.parse(JSON.stringify(input)))
  }

  async updateCardEntity(input: {
    cardId: string
    card: FeishuIMCard
    sequence: number
  }): Promise<void> {
    this.entityUpdates.push(JSON.parse(JSON.stringify(input)))
  }

  async setCardStreamingMode(input: {
    cardId: string
    streaming: boolean
    sequence: number
  }): Promise<void> {
    this.settings.push(JSON.parse(JSON.stringify(input)))
  }
}

class FailingCardKitContentReplyClient extends CardKitReplyClient {
  async streamCardContent(input: {
    cardId: string
    elementId: string
    content: string
    sequence: number
  }): Promise<void> {
    this.streams.push(JSON.parse(JSON.stringify(input)))
    throw new Error('cardkit content failed')
  }
}

class FailingSendCardReplyClient extends MemoryFeishuIMReplyClient {
  async sendCard(input: { chatId: string; rootMessageId?: string; replyTarget: 'message' | 'thread'; card: Record<string, unknown> }): Promise<FeishuIMSentMessage> {
    this.cards.push(JSON.parse(JSON.stringify(input)))
    throw new Error('send failed')
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
