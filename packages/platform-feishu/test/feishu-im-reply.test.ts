import { describe, expect, test } from 'bun:test'
import type { PlatformSecretRef } from '@nine1bot/platform-protocol'
import {
  answerFeishuCardInteraction,
  createFeishuIMImmediateReplyHandler,
  createFeishuIMReplySinkFactory,
  FeishuIMSessionManager,
  FeishuReplySink,
  MemoryFeishuIMBindingStore,
  MemoryFeishuIMReplyClient,
  normalizeFeishuIMConfig,
  parseFeishuCardAction,
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
  type FeishuIMAccount,
  type FeishuIMIncomingMessage,
  type FeishuRuntimeEventEnvelope,
  type FeishuRuntimeEventSubscription,
} from '../src/im'

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

class EventBridge implements FeishuControllerBridge {
  sessions = new Map<string, FeishuControllerSession>()
  sent: FeishuControllerSendMessageInput[] = []
  aborts: any[] = []
  answers: any[] = []
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
