import { describe, expect, it } from 'bun:test'
import { normalizeRuntimeEventEnvelope, type RuntimeEventEnvelope } from '../src/api/runtime-events'

function envelope(type: string, data: Record<string, any>): RuntimeEventEnvelope {
  return {
    version: '2026-04-25',
    id: `evt-${type}`,
    sessionId: 'ses_123',
    turnSnapshotId: 'turn_123',
    createdAt: Date.now(),
    type,
    data,
  }
}

describe('normalizeRuntimeEventEnvelope', () => {
  it('maps message deltas to legacy message part events', () => {
    const [event] = normalizeRuntimeEventEnvelope(
      envelope('runtime.message.part.updated', {
        part: {
          id: 'part_1',
          sessionID: 'ses_123',
          messageID: 'msg_1',
          type: 'text',
          text: 'hello',
        },
        delta: 'hello',
      }),
    )

    expect(event).toEqual({
      type: 'message.part.updated',
      properties: {
        part: {
          id: 'part_1',
          sessionID: 'ses_123',
          messageID: 'msg_1',
          type: 'text',
          text: 'hello',
        },
        delta: 'hello',
      },
    })
  })

  it('maps interaction requests for permission and question', () => {
    expect(
      normalizeRuntimeEventEnvelope(
        envelope('runtime.interaction.requested', {
          kind: 'permission',
          requestId: 'perm_1',
          permission: 'bash',
          patterns: ['npm test'],
          metadata: { command: 'npm test' },
        }),
      )[0],
    ).toEqual({
      type: 'permission.asked',
      properties: {
        id: 'perm_1',
        sessionID: 'ses_123',
        permission: 'bash',
        patterns: ['npm test'],
        metadata: { command: 'npm test' },
        always: undefined,
      },
    })

    expect(
      normalizeRuntimeEventEnvelope(
        envelope('runtime.interaction.requested', {
          kind: 'question',
          requestId: 'question_1',
          questions: [{ question: 'Pick one', header: 'Choice', options: [] }],
        }),
      )[0],
    ).toEqual({
      type: 'question.asked',
      properties: {
        id: 'question_1',
        sessionID: 'ses_123',
        questions: [{ question: 'Pick one', header: 'Choice', options: [] }],
        tool: undefined,
      },
    })
  })

  it('maps preview artifacts and resource failures', () => {
    expect(
      normalizeRuntimeEventEnvelope(
        envelope('runtime.artifact.available', {
          artifactId: 'preview_1',
          kind: 'preview',
          filename: 'report.md',
          mime: 'text/markdown',
          path: '/tmp/report.md',
          size: 12,
          preview: {
            inlineContentBase64: 'SGk=',
            interactive: true,
          },
        }),
      )[0],
    ).toEqual({
      type: 'file-preview.open',
      properties: {
        id: 'preview_1',
        sessionID: 'ses_123',
        path: '/tmp/report.md',
        filename: 'report.md',
        mime: 'text/markdown',
        content: 'SGk=',
        size: 12,
        interactive: true,
      },
    })

    expect(
      normalizeRuntimeEventEnvelope(
        envelope('runtime.resource.failed', {
          type: 'mcp',
          id: 'gitlab',
          reason: 'disabled-by-current-config',
          message: 'GitLab MCP disabled',
        }),
      )[0],
    ).toEqual({
      type: 'runtime.resource.failed',
      properties: {
        type: 'mcp',
        id: 'gitlab',
        reason: 'disabled-by-current-config',
        message: 'GitLab MCP disabled',
        sessionID: 'ses_123',
      },
    })
  })

  it('maps turn completion and failures to session lifecycle events', () => {
    expect(normalizeRuntimeEventEnvelope(envelope('runtime.turn.completed', { status: 'idle' }))[0]).toEqual({
      type: 'session.idle',
      properties: {
        sessionID: 'ses_123',
      },
    })

    expect(normalizeRuntimeEventEnvelope(envelope('runtime.turn.failed', { error: { message: 'failed' } }))[0]).toEqual({
      type: 'session.error',
      properties: {
        sessionID: 'ses_123',
        error: {
          message: 'failed',
          sessionID: 'ses_123',
        },
      },
    })
  })
})
