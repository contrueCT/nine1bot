import type {
  FeishuIMControlResult,
  FeishuIMControllerMessagePart,
} from './types'

export const FEISHU_CONTROLLER_CAPABILITIES = {
  interactions: true,
  permissionRequests: true,
  questionRequests: true,
  artifacts: true,
  resourceFailures: true,
  turnSnapshots: true,
  continueInWeb: true,
} as const

export type FeishuControllerEntry = {
  source: 'feishu'
  platform: 'feishu'
  mode: 'feishu-im'
  templateIds: string[]
  traceId?: string
}

export type FeishuControllerContextBlock = {
  id: string
  layer: 'platform' | 'user' | 'turn'
  source: string
  enabled: boolean
  priority: number
  lifecycle: 'turn'
  visibility: 'system-required' | 'developer-toggle'
  mergeKey?: string
  content: string
}

export type FeishuControllerProject = {
  id: string
  name?: string
  worktree?: string
  rootDirectory?: string
  time?: {
    updated: number
  }
}

export type FeishuControllerSession = {
  id: string
  projectID?: string
  directory: string
  title?: string
}

export type FeishuControllerCreateSessionInput = {
  title?: string
  directory?: string
  entry?: FeishuControllerEntry
  contextBlocks?: FeishuControllerContextBlock[]
}

export type FeishuControllerCreateSessionResult = {
  sessionId: string
  session: FeishuControllerSession
  agent?: string
  currentModel?: {
    providerID: string
    modelID: string
  }
}

export type FeishuControllerSendMessageInput = {
  sessionId: string
  directory?: string
  messageId?: string
  parts: FeishuIMControllerMessagePart[]
  contextBlocks?: FeishuControllerContextBlock[]
  system?: string
  entry?: FeishuControllerEntry
}

export type FeishuControllerMessageResult = {
  accepted: boolean
  sessionId: string
  turnSnapshotId?: string
  busy?: boolean
  status?: number
  fallbackAction?: {
    type: 'continue-in-web'
    label: string
  }
}

export type FeishuControllerTurnResult = {
  completed: boolean
  failed?: boolean
  text?: string
  error?: string
}

export type FeishuControllerAbortSessionInput = {
  sessionId: string
  directory?: string
  reason?: string
}

export type FeishuInteractionAnswerInput = {
  requestId: string
  kind?: 'question' | 'permission'
  answer:
    | 'allow-once'
    | 'allow-session'
    | 'deny'
    | {
        answers: string[][]
      }
  message?: string
}

export type FeishuRuntimeEventEnvelope = {
  id?: string
  version?: string
  sessionId?: string
  turnSnapshotId?: string
  createdAt?: number
  type: string
  at?: number
  data?: unknown
  properties?: Record<string, unknown>
  legacy?: {
    type: string
    properties?: unknown
  }
}

export type FeishuRuntimeEventSubscription = {
  ready?: Promise<void>
  stop(): void
}

export type FeishuControllerBridge = {
  createSession(input: FeishuControllerCreateSessionInput): Promise<FeishuControllerCreateSessionResult>
  getSession(input: { sessionId: string; directory?: string }): Promise<FeishuControllerSession | undefined>
  sendMessage(input: FeishuControllerSendMessageInput): Promise<FeishuControllerMessageResult>
  getLatestTurnResult?(input: { sessionId: string; directory?: string }): Promise<FeishuControllerTurnResult | undefined>
  abortSession(input: FeishuControllerAbortSessionInput): Promise<boolean>
  answerInteraction(input: FeishuInteractionAnswerInput): Promise<boolean>
  listProjects(): Promise<FeishuControllerProject[]>
  getProject(projectId: string): Promise<FeishuControllerProject | undefined>
  subscribeEvents(input: {
    sessionId: string
    onEvent: (event: FeishuRuntimeEventEnvelope) => void | Promise<void>
    onError?: (error: Error) => void | Promise<void>
  }): FeishuRuntimeEventSubscription
}

export function feishuControllerEntry(traceId?: string): FeishuControllerEntry {
  return {
    source: 'feishu',
    platform: 'feishu',
    mode: 'feishu-im',
    templateIds: ['default-user-template', 'feishu-chat'],
    traceId,
  }
}

export function projectDisplayName(project: Pick<FeishuControllerProject, 'id' | 'name' | 'rootDirectory' | 'worktree'>): string {
  return project.name || project.rootDirectory || project.worktree || project.id
}

export function projectDirectory(project: Pick<FeishuControllerProject, 'rootDirectory' | 'worktree'>): string | undefined {
  return project.rootDirectory || project.worktree
}

export function controlResultLabel(result: FeishuIMControlResult): string {
  if (result.type === 'failed') return result.message
  if (result.type === 'unknown-command') return `Unknown command: ${result.command}`
  return result.type
}
