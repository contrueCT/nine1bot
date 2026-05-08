import type { PlatformRuntimeStatus, PlatformSecretRef } from '@nine1bot/platform-protocol'

export type FeishuIMConnectionMode = 'websocket'

export type FeishuIMChatType = 'p2p' | 'group' | 'unknown'

export type FeishuIMRouteKind = 'dm' | 'group' | 'thread'

export type FeishuIMReplyPresentation = 'auto' | 'text' | 'card' | 'streaming-card'

export type FeishuIMAccount = {
  id: string
  name?: string
  enabled: boolean
  appId: string
  appSecretRef: PlatformSecretRef
  defaultDirectory?: string
  connectionMode: FeishuIMConnectionMode
}

export type FeishuIMPolicy = {
  dmPolicy: 'allow' | 'deny'
  groupPolicy: 'mention-only' | 'allow' | 'deny'
  allowFrom: string[]
  replyMode: 'message' | 'thread'
  replyPresentation: FeishuIMReplyPresentation
  replyTimeoutMs: number
  streamingCardUpdateMs: number
  streamingCardMaxChars: number
  messageBufferMs: number
  maxBufferMs: number
  busyRejectText: string
}

export type FeishuIMLegacyState = {
  enabled: boolean
  mode?: string
  appId?: string
  hasAppSecret: boolean
  defaultDirectory?: string
}

export type FeishuIMNormalizedConfig = {
  enabled: boolean
  connectionMode: FeishuIMConnectionMode
  accounts: FeishuIMAccount[]
  policy: FeishuIMPolicy
  legacy: FeishuIMLegacyState
  warnings: string[]
}

export type FeishuIMRuntimePhase = 'disabled' | 'staged' | 'running' | 'stopped' | 'error'

export type FeishuIMRuntimeSnapshot = {
  phase: FeishuIMRuntimePhase
  status: PlatformRuntimeStatus
  accountCount: number
  legacyActive: boolean
  activeReplySinks?: number
  pendingInteractions?: number
  activeStreamingCards?: number
  cardUpdateFailures?: number
  streamingFallbacks?: number
  lastReplyError?: string
  lastCardAction?: string
  lastCardUpdateError?: string
  lastStreamingTransport?: string
  lastStreamingFallbackReason?: string
  updatedAt: string
}

export type FeishuIMMention = {
  key?: string
  name?: string
  openId?: string
  userId?: string
  unionId?: string
}

export type FeishuIMSender = {
  openId?: string
  userId?: string
  unionId?: string
  tenantKey?: string
  name?: string
}

export type FeishuIMIncomingMessage = {
  eventId?: string
  messageId: string
  rootId?: string
  parentId?: string
  chatId: string
  chatType: FeishuIMChatType
  messageType: string
  text?: string
  sender: FeishuIMSender
  mentions: FeishuIMMention[]
  createTime?: number
  raw: unknown
}

export type FeishuIMGateDecision = {
  action: 'dispatch' | 'history' | 'drop'
  allowed: boolean
  reason?: 'dm-denied' | 'group-denied' | 'mention-required' | 'not-allowlisted'
}

export type FeishuIMControllerTextPart = {
  type: 'text'
  text: string
}

export type FeishuIMControllerFilePart = {
  type: 'file'
  filename: string
  mime: string
  url: string
}

export type FeishuIMControllerMessagePart = FeishuIMControllerTextPart | FeishuIMControllerFilePart

export type FeishuIMControlResult =
  | {
      type: 'control-panel'
      sessionId: string
      routeKey: string
      directory?: string
      projectId?: string
      projectName?: string
    }
  | {
      type: 'new-session'
      sessionId: string
      directory?: string
      projectId?: string
    }
  | {
      type: 'cwd-current'
      sessionId: string
      directory?: string
      projectId?: string
    }
  | {
      type: 'cwd-switched'
      sessionId: string
      directory: string
      projectId?: string
    }
  | {
      type: 'project-current'
      sessionId: string
      projectId?: string
      projectName?: string
      directory?: string
    }
  | {
      type: 'project-list'
      projects: Array<{
        id: string
        name?: string
        directory?: string
      }>
    }
  | {
      type: 'project-switched'
      sessionId: string
      projectId: string
      projectName?: string
      directory: string
    }
  | {
      type: 'unknown-command'
      command: string
    }
  | {
      type: 'failed'
      command: string
      message: string
    }
  | {
      type: 'help'
      commands: string[]
    }
  | {
      type: 'turn-aborted'
      sessionId: string
      turnSnapshotId?: string
      message: string
    }

export type FeishuIMHandleMessageResult =
  | {
      status: 'ignored'
      reason?: string
    }
  | {
      status: 'history-recorded'
      routeKey: string
    }
  | {
      status: 'buffered'
      routeKey: string
      messageCount: number
    }
  | {
      status: 'accepted'
      routeKey: string
      sessionId: string
      turnSnapshotId?: string
    }
  | {
      status: 'busy'
      routeKey: string
      message: string
    }
  | {
      status: 'control'
      routeKey: string
      control: FeishuIMControlResult
    }
    | {
        status: 'failed'
        routeKey?: string
        message: string
      }
    | {
        status: 'aborted'
        routeKey: string
        sessionId: string
        turnSnapshotId?: string
        message: string
      }
    | {
        status: 'abort-noop'
        routeKey: string
        message: string
      }
    | {
        status: 'buffer-cancelled'
        routeKey: string
        messageCount: number
        message: string
      }
