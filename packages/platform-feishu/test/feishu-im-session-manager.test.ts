import { describe, expect, test } from 'bun:test'
import type { PlatformSecretRef } from '@nine1bot/platform-protocol'
import {
  FeishuIMHistoryStore,
  FeishuIMSessionManager,
  MemoryFeishuIMBindingStore,
  normalizeFeishuIMConfig,
  routeKeyForFeishuMessage,
  serializeFeishuRouteKey,
  type FeishuControllerBridge,
  type FeishuControllerCreateSessionInput,
  type FeishuControllerCreateSessionResult,
  type FeishuControllerMessageResult,
  type FeishuControllerProject,
  type FeishuControllerSendMessageInput,
  type FeishuControllerSession,
  type FeishuIMAccount,
  type FeishuIMIncomingMessage,
  type FeishuIMReplySinkFactoryInput,
  type FeishuIMSessionManagerOptions,
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

describe('Feishu IM session manager', () => {
  test('creates separate session routes for DM, group, and thread', () => {
    const dm = routeKeyForFeishuMessage(message({ chatType: 'p2p', chatId: 'oc_dm', openId: 'ou_alice' }), { accountId: 'acct' })
    const group = routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group' }), { accountId: 'acct' })
    const thread = routeKeyForFeishuMessage(message({ chatType: 'group', chatId: 'oc_group', rootId: 'omt_root' }), { accountId: 'acct' })

    expect(serializeFeishuRouteKey(dm)).toBe('feishu:acct:dm:ou_alice')
    expect(serializeFeishuRouteKey(group)).toBe('feishu:acct:group:oc_group')
    expect(serializeFeishuRouteKey(thread)).toBe('feishu:acct:thread:oc_group:omt_root')
  })

  test('reuses bindings and /new forces a new session', async () => {
    const bridge = new FakeBridge()
    const manager = sessionManager({ bridge, messageBufferMs: 0 })
    const first = await manager.handleIncomingMessage(message({ text: 'hello' }))
    const second = await manager.handleIncomingMessage(message({ text: 'again' }))

    expect(first).toMatchObject({ status: 'accepted', sessionId: 'ses_1' })
    expect(second).toMatchObject({ status: 'accepted', sessionId: 'ses_1' })

    const reset = await manager.handleIncomingMessage(message({ text: '/new' }))
    expect(reset).toMatchObject({
      status: 'control',
      control: {
        type: 'new-session',
        sessionId: 'ses_2',
      },
    })
  })

  test('buffers adjacent messages and flushes them as one controller call', async () => {
    const bridge = new FakeBridge()
    const manager = sessionManager({ bridge, messageBufferMs: 100, maxBufferMs: 1000 })
    const first = message({ text: 'first', messageId: 'om_1' })
    const route = serializeFeishuRouteKey(routeKeyForFeishuMessage(first, { accountId: account.id }))

    await expect(manager.handleIncomingMessage(first)).resolves.toMatchObject({
      status: 'buffered',
      messageCount: 1,
    })
    await expect(manager.handleIncomingMessage(message({ text: 'second', messageId: 'om_2' }))).resolves.toMatchObject({
      status: 'buffered',
      messageCount: 2,
    })

    await expect(manager.flushRoute(route)).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
    })
    expect(bridge.sent).toHaveLength(1)
    const text = (bridge.sent[0]?.parts[0] as { text: string }).text
    expect(text).toBe('first\n\nsecond')
    expect(text).not.toContain('message_id')
    expect(text).not.toContain('Feishu messages in this turn')
  })

  test('abort text cancels pending buffer before it reaches controller', async () => {
    const bridge = new FakeBridge()
    const manager = sessionManager({ bridge, messageBufferMs: 100, maxBufferMs: 1000 })

    await expect(manager.handleIncomingMessage(message({ text: 'first', messageId: 'om_1' }))).resolves.toMatchObject({
      status: 'buffered',
      messageCount: 1,
    })
    expect(manager.bufferSnapshot()).toMatchObject([{
      messageCount: 1,
      lastMessageId: 'om_1',
    }])

    await expect(manager.handleIncomingMessage(message({ text: '取消', messageId: 'om_abort' }))).resolves.toMatchObject({
      status: 'buffer-cancelled',
      messageCount: 1,
    })
    expect(manager.bufferSnapshot()).toEqual([])
    expect(bridge.sent).toHaveLength(0)
  })

  test('max buffer timer flushes buffered messages', async () => {
    const bridge = new FakeBridge()
    const results: unknown[] = []
    const manager = sessionManager({
      bridge,
      messageBufferMs: 1000,
      maxBufferMs: 10,
      onFlushResult: (result) => {
        results.push(result)
      },
    })

    await manager.handleIncomingMessage(message({ text: 'flush by max timer' }))
    await sleep(40)

    expect(results).toContainEqual(expect.objectContaining({ status: 'accepted' }))
    expect(bridge.sent).toHaveLength(1)
  })

  test('mention-only group messages enter history, while allow without mention dispatches', async () => {
    const mentionOnlyBridge = new FakeBridge()
    const mentionOnly = sessionManager({
      bridge: mentionOnlyBridge,
      messageBufferMs: 0,
      groupPolicy: 'mention-only',
    })
    await expect(mentionOnly.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      text: 'background context',
    }))).resolves.toMatchObject({ status: 'history-recorded' })

    await expect(mentionOnly.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      text: '@bot summarize',
      mentions: [{ openId: 'ou_bot', name: 'bot' }],
    }))).resolves.toMatchObject({ status: 'accepted' })
    expect(mentionOnlyBridge.sent[0]?.contextBlocks?.some((block) =>
      block.content.includes('background context')
    )).toBe(true)

    const allowBridge = new FakeBridge()
    const allow = sessionManager({
      bridge: allowBridge,
      messageBufferMs: 0,
      groupPolicy: 'allow',
    })
    await expect(allow.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      text: 'no mention but dispatch',
    }))).resolves.toMatchObject({ status: 'accepted' })
  })

  test('controller busy returns busy without accepting into runtime queue', async () => {
    const bridge = new FakeBridge({ busy: true })
    const manager = sessionManager({ bridge, messageBufferMs: 0 })

    await expect(manager.handleIncomingMessage(message({ text: 'busy?' }))).resolves.toMatchObject({
      status: 'busy',
      message: 'busy text',
    })
    expect(bridge.sent).toHaveLength(1)
  })

  test('abort text cancels active route turn and releases busy state', async () => {
    const bridge = new FakeBridge()
    const sink = new ManualSink()
    const manager = sessionManager({
      bridge,
      messageBufferMs: 0,
      replySinkFactory: () => sink,
    })

    await expect(manager.handleIncomingMessage(message({ text: 'run', messageId: 'om_1' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    expect(manager.activeTurnSnapshot()).toHaveLength(1)

    await expect(manager.handleIncomingMessage(message({ text: '/abort', messageId: 'om_abort' }))).resolves.toMatchObject({
      status: 'aborted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    expect(bridge.aborts).toEqual([{ sessionId: 'ses_1', directory: 'C:/work', reason: 'feishu-im-abort' }])
    expect(sink.stopped).toBe(true)
    expect(manager.activeTurnSnapshot()).toEqual([])

    await expect(manager.handleIncomingMessage(message({ text: 'after abort', messageId: 'om_2' }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_2',
    })
  })

  test('same group different threads run in parallel while same thread remains busy', async () => {
    const bridge = new FakeBridge()
    const manager = sessionManager({
      bridge,
      messageBufferMs: 0,
      groupPolicy: 'allow',
      replySinkFactory: () => new ManualSink(),
    })

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_a',
      text: 'thread a',
      messageId: 'om_a1',
    }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_b',
      text: 'thread b',
      messageId: 'om_b1',
    }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_2',
      turnSnapshotId: 'turn_2',
    })
    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_a',
      text: 'thread a again',
      messageId: 'om_a2',
    }))).resolves.toMatchObject({
      status: 'busy',
      message: 'busy text',
    })

    expect(manager.activeTurnSnapshot().map((turn) => turn.routeKeyString).sort()).toEqual([
      'feishu:default:thread:oc_group:omt_a',
      'feishu:default:thread:oc_group:omt_b',
    ])
  })

  test('control commands expose cwd and project operations as structured results', async () => {
    const bridge = new FakeBridge({
      projects: [{
        id: 'proj_1',
        name: 'Project One',
        rootDirectory: 'C:/project-one',
      }],
    })
    const manager = sessionManager({
      bridge,
      messageBufferMs: 0,
      resolveDirectory: async (_base, input) => `C:/resolved/${input}`,
    })

    await expect(manager.handleIncomingMessage(message({ text: '/cwd src' }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'cwd-switched',
        directory: 'C:/resolved/src',
      },
    })
    await expect(manager.handleIncomingMessage(message({ text: '/project list' }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'project-list',
        projects: [{
          id: 'proj_1',
          name: 'Project One',
          directory: 'C:/project-one',
        }],
      },
    })
    await expect(manager.handleIncomingMessage(message({ text: '/project proj_1' }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'project-switched',
        projectId: 'proj_1',
        directory: 'C:/project-one',
      },
    })
  })

  test('mention-only group slash control commands bypass mention gate', async () => {
    const bridge = new FakeBridge({
      projects: [{
        id: 'proj_1',
        name: 'Project One',
        rootDirectory: 'C:/project-one',
      }],
    })
    const manager = sessionManager({
      bridge,
      messageBufferMs: 0,
      groupPolicy: 'mention-only',
    })

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      text: '/control',
      messageId: 'om_control',
    }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'control-panel',
      },
    })

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      text: '/project list',
      messageId: 'om_project_list',
    }))).resolves.toMatchObject({
      status: 'control',
      control: {
        type: 'project-list',
        projects: [expect.objectContaining({
          id: 'proj_1',
        })],
      },
    })
  })

  test('mention-only group slash abort bypasses mention gate while plain text still does not', async () => {
    const bridge = new FakeBridge()
    const sink = new ManualSink()
    const manager = sessionManager({
      bridge,
      messageBufferMs: 0,
      groupPolicy: 'mention-only',
      replySinkFactory: () => sink,
    })

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_group',
      text: '@bot start task',
      mentions: [{ openId: 'ou_bot', name: 'bot' }],
      messageId: 'om_group_1',
    }))).resolves.toMatchObject({
      status: 'accepted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_group',
      text: '取消',
      messageId: 'om_group_plain_abort',
    }))).resolves.toMatchObject({
      status: 'history-recorded',
    })
    expect(bridge.aborts).toEqual([])

    await expect(manager.handleIncomingMessage(message({
      chatType: 'group',
      chatId: 'oc_group',
      rootId: 'omt_group',
      text: '/abort',
      messageId: 'om_group_abort',
    }))).resolves.toMatchObject({
      status: 'aborted',
      sessionId: 'ses_1',
      turnSnapshotId: 'turn_1',
    })
    expect(bridge.aborts).toEqual([expect.objectContaining({
      sessionId: 'ses_1',
      reason: 'feishu-im-abort',
    })])
  })
})

function sessionManager(options: {
  bridge?: FakeBridge
  messageBufferMs?: number
  maxBufferMs?: number
  groupPolicy?: 'mention-only' | 'allow' | 'deny'
  resolveDirectory?: (baseDirectory: string | undefined, input: string) => Promise<string>
  onFlushResult?: (result: any) => void | Promise<void>
  replySinkFactory?: FeishuIMSessionManagerOptions['replySinkFactory']
}) {
  const config = normalizeFeishuIMConfig({
    imEnabled: true,
    imDefaultAppId: account.appId,
    imDefaultAppSecret: secretRef,
    imMessageBufferMs: options.messageBufferMs ?? 0,
    imMaxBufferMs: options.maxBufferMs ?? 1000,
    imGroupPolicy: options.groupPolicy ?? 'mention-only',
    imBusyRejectText: 'busy text',
  })
  return new FeishuIMSessionManager({
    account,
    config,
    controller: options.bridge ?? new FakeBridge(),
    store: new MemoryFeishuIMBindingStore(),
    history: new FeishuIMHistoryStore({ ttlMs: 60_000, limit: 5 }),
    botOpenId: 'ou_bot',
    resolveDirectory: options.resolveDirectory,
    onFlushResult: options.onFlushResult,
    replySinkFactory: options.replySinkFactory,
  })
}

function message(input: {
  text?: string
  messageId?: string
  chatType?: 'p2p' | 'group'
  chatId?: string
  openId?: string
  rootId?: string
  mentions?: FeishuIMIncomingMessage['mentions']
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
    mentions: input.mentions ?? [],
    createTime: 1_778_000_000_000,
    raw: {},
  }
}

class FakeBridge implements FeishuControllerBridge {
  sessions = new Map<string, FeishuControllerSession>()
  sent: FeishuControllerSendMessageInput[] = []
  aborts: Array<{ sessionId: string; directory?: string; reason?: string }> = []
  private sequence = 0

  constructor(private readonly options: {
    busy?: boolean
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
    return {
      sessionId: id,
      session,
    }
  }

  async getSession(input: { sessionId: string }): Promise<FeishuControllerSession | undefined> {
    return this.sessions.get(input.sessionId)
  }

  async sendMessage(input: FeishuControllerSendMessageInput): Promise<FeishuControllerMessageResult> {
    this.sent.push(input)
    return {
      accepted: !this.options.busy,
      busy: this.options.busy,
      sessionId: input.sessionId,
      turnSnapshotId: this.options.busy ? undefined : `turn_${this.sent.length}`,
      status: this.options.busy ? 409 : 202,
    }
  }

  async abortSession(input: { sessionId: string; directory?: string; reason?: string }): Promise<boolean> {
    this.aborts.push(input)
    return true
  }

  async answerInteraction(): Promise<boolean> {
    return true
  }

  async listProjects(): Promise<FeishuControllerProject[]> {
    return this.options.projects ?? []
  }

  async getProject(projectId: string): Promise<FeishuControllerProject | undefined> {
    return (this.options.projects ?? []).find((project) => project.id === projectId)
  }

  subscribeEvents() {
    return {
      stop() {},
    }
  }

  private projectForDirectory(directory: string | undefined): FeishuControllerProject | undefined {
    return (this.options.projects ?? []).find((project) => project.rootDirectory === directory || project.worktree === directory)
  }
}

class ManualSink {
  stopped = false
  boundTurnSnapshotId?: string
  done = new Promise(() => undefined)

  start() {}

  bindTurnSnapshotId(turnSnapshotId?: string) {
    this.boundTurnSnapshotId = turnSnapshotId
  }

  stop() {
    this.stopped = true
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
