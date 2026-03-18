export interface FeishuConversationBinding {
  bindingKey: string
  openId: string
  sessionId: string
  directory: string
  projectId: string
  updatedAt: number
}

export interface FeishuMessageLockState {
  openId: string
  sessionId: string
  messageId: string
  startedAt: number
}

export interface FeishuEventDedupEntry {
  eventId: string
  createdAt: number
}

export interface FeishuBindingsFile {
  version: 1
  bindings: FeishuConversationBinding[]
}
