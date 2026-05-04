import type { PlatformRuntimeStatus, PlatformSecretRef } from '@nine1bot/platform-protocol'

export type FeishuIMConnectionMode = 'websocket'

export type FeishuIMChatType = 'p2p' | 'group' | 'unknown'

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
  requireMention: boolean
  allowFrom: string[]
  replyMode: 'message' | 'thread'
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
  allowed: boolean
  reason?: 'dm-denied' | 'group-denied' | 'mention-required' | 'not-allowlisted'
}
