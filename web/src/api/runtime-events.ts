export interface RuntimeEventEnvelope<T = Record<string, any>> {
  version: string
  id: string
  sessionId: string
  turnSnapshotId?: string
  createdAt: number
  type: string
  data: T
  legacy?: {
    type: string
    properties?: unknown
  }
}

export interface NormalizedSSEEvent {
  type: string
  properties: Record<string, any>
}

export const RUNTIME_EVENT_TYPES = [
  'runtime.server.connected',
  'runtime.server.heartbeat',
  'runtime.session.created',
  'runtime.session.updated',
  'runtime.session.deleted',
  'runtime.session.status',
  'runtime.message.created',
  'runtime.message.updated',
  'runtime.message.removed',
  'runtime.message.part.updated',
  'runtime.message.part.removed',
  'runtime.interaction.requested',
  'runtime.interaction.answered',
  'runtime.artifact.available',
  'runtime.artifact.closed',
  'runtime.resource.failed',
  'runtime.resources.resolved',
  'runtime.context.compiled',
  'runtime.turn.started',
  'runtime.turn.completed',
  'runtime.turn.failed',
  'runtime.todo.updated',
]

export function normalizeRuntimeEventEnvelope(envelope: RuntimeEventEnvelope): NormalizedSSEEvent[] {
  const data = asRecord(envelope.data)
  const sessionID = envelope.sessionId

  switch (envelope.type) {
    case 'runtime.server.connected':
    case 'runtime.server.heartbeat':
      return []

    case 'runtime.session.created':
      return [{ type: 'session.created', properties: { info: data.session, sessionID } }]

    case 'runtime.session.updated':
      return [{ type: 'session.updated', properties: { info: data.session, sessionID } }]

    case 'runtime.session.deleted':
      return [{ type: 'session.deleted', properties: { info: data.session, sessionID } }]

    case 'runtime.session.status':
      return [
        {
          type: 'session.status',
          properties: {
            sessionID,
            status: {
              ...asRecord(data.status),
              sessionID,
            },
          },
        },
      ]

    case 'runtime.message.created':
      return [
        {
          type: 'message.created',
          properties: {
            info: data.message,
            message: {
              info: data.message,
              parts: [],
            },
          },
        },
      ]

    case 'runtime.message.updated':
      return [{ type: 'message.updated', properties: { info: data.message } }]

    case 'runtime.message.removed':
      return [
        {
          type: 'message.removed',
          properties: {
            messageID: data.messageId ?? data.messageID,
            sessionID,
          },
        },
      ]

    case 'runtime.message.part.updated':
      return [
        {
          type: 'message.part.updated',
          properties: {
            part: data.part,
            delta: data.delta,
          },
        },
      ]

    case 'runtime.message.part.removed':
      return [
        {
          type: 'message.part.removed',
          properties: {
            messageID: data.messageId ?? data.messageID,
            partID: data.partId ?? data.partID,
            sessionID,
          },
        },
      ]

    case 'runtime.interaction.requested':
      return normalizeInteractionRequested(sessionID, data)

    case 'runtime.interaction.answered':
      return normalizeInteractionAnswered(sessionID, data)

    case 'runtime.artifact.available':
      return normalizeArtifactAvailable(sessionID, data)

    case 'runtime.artifact.closed':
      return [
        {
          type: 'file-preview.close',
          properties: {
            id: data.artifactId ?? data.id,
            sessionID,
          },
        },
      ]

    case 'runtime.resource.failed':
      return [
        {
          type: 'runtime.resource.failed',
          properties: {
            ...data,
            sessionID,
          },
        },
      ]

    case 'runtime.resources.resolved':
      return [{ type: 'runtime.resources.resolved', properties: { ...data, sessionID } }]

    case 'runtime.context.compiled':
      return [{ type: 'runtime.context.compiled', properties: { ...data, sessionID } }]

    case 'runtime.turn.started':
      return [
        {
          type: 'session.status',
          properties: {
            sessionID,
            status: {
              type: 'busy',
              sessionID,
              turnSnapshotId: envelope.turnSnapshotId ?? data.turnSnapshotId,
            },
          },
        },
      ]

    case 'runtime.turn.completed':
      return [{ type: 'session.idle', properties: { sessionID } }]

    case 'runtime.turn.failed':
      return [
        {
          type: 'session.error',
          properties: {
            sessionID,
            error: {
              ...asRecord(data.error),
              sessionID,
            },
          },
        },
      ]

    case 'runtime.todo.updated':
      return [{ type: 'todo.updated', properties: { ...data, sessionID } }]

    default:
      return [{ type: envelope.type, properties: { ...data, sessionID } }]
  }
}

function normalizeInteractionRequested(sessionID: string, data: Record<string, any>): NormalizedSSEEvent[] {
  if (data.kind === 'question') {
    return [
      {
        type: 'question.asked',
        properties: {
          id: data.requestId ?? data.requestID ?? data.id,
          sessionID,
          questions: data.questions || [],
          tool: data.tool,
        },
      },
    ]
  }

  if (data.kind === 'permission') {
    return [
      {
        type: 'permission.asked',
        properties: {
          id: data.requestId ?? data.requestID ?? data.id,
          sessionID,
          permission: data.permission,
          patterns: data.patterns || [],
          metadata: data.metadata || {},
          always: data.always,
        },
      },
    ]
  }

  return [{ type: 'runtime.interaction.requested', properties: { ...data, sessionID } }]
}

function normalizeInteractionAnswered(sessionID: string, data: Record<string, any>): NormalizedSSEEvent[] {
  const requestID = data.requestId ?? data.requestID ?? data.id
  if (data.kind === 'question') {
    const answer = asRecord(data.answer)
    if (data.answer === 'deny') {
      return [{ type: 'question.rejected', properties: { requestID, sessionID } }]
    }
    return [
      {
        type: 'question.replied',
        properties: {
          requestID,
          sessionID,
          answers: answer.answers,
        },
      },
    ]
  }

  if (data.kind === 'permission') {
    return [
      {
        type: 'permission.replied',
        properties: {
          requestID,
          sessionID,
          reply: legacyPermissionReply(data.answer),
        },
      },
    ]
  }

  return [{ type: 'runtime.interaction.answered', properties: { ...data, sessionID } }]
}

function normalizeArtifactAvailable(sessionID: string, data: Record<string, any>): NormalizedSSEEvent[] {
  if (data.kind !== 'preview') {
    return [{ type: 'runtime.artifact.available', properties: { ...data, sessionID } }]
  }

  const preview = asRecord(data.preview)
  return [
    {
      type: 'file-preview.open',
      properties: {
        id: data.artifactId ?? data.id,
        sessionID,
        path: data.path || '',
        filename: data.filename || data.path || 'preview',
        mime: data.mime || 'application/octet-stream',
        content: preview.inlineContentBase64 ?? data.content,
        size: data.size || 0,
        interactive: preview.interactive ?? data.interactive,
      },
    },
  ]
}

function legacyPermissionReply(answer: unknown) {
  if (answer === 'allow-once') return 'once'
  if (answer === 'allow-session') return 'always'
  return 'reject'
}

function asRecord(input: unknown): Record<string, any> {
  if (input && typeof input === 'object') {
    return input as Record<string, any>
  }
  return {}
}
