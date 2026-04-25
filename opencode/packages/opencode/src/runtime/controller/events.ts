import z from "zod"
import { ulid } from "ulid"
import { BusEvent } from "@/bus/bus-event"
import type { MessageV2 } from "@/session/message-v2"
import { RuntimeControllerProtocol } from "@/runtime/controller/protocol"

export namespace RuntimeControllerEvents {
  export type RuntimeEventEnvelope<T = unknown> = {
    version: typeof RuntimeControllerProtocol.VERSION
    id: string
    sessionId: string
    turnSnapshotId?: string
    createdAt: number
    type: RuntimeControllerProtocol.RuntimeEventType
    data: T
    legacy?: {
      type: string
      properties?: unknown
    }
  }

  export const TurnStarted = BusEvent.define(
    "runtime.turn.started",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string(),
      profileSnapshotId: z.string().optional(),
      agent: z.string().optional(),
      model: z
        .object({
          providerID: z.string(),
          modelID: z.string(),
          source: z.string().optional(),
        })
        .optional(),
    }),
  )

  export const ContextCompiled = BusEvent.define(
    "runtime.context.compiled",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string().optional(),
      blockCount: z.number(),
      renderedCount: z.number(),
      droppedCount: z.number(),
      tokenEstimate: z.number(),
      audit: z.array(z.record(z.string(), z.unknown())),
      dropped: z.array(z.record(z.string(), z.unknown())),
    }),
  )

  const activeTurns = new Map<string, string>()

  export function bindTurn(sessionID: string, turnSnapshotId: string) {
    activeTurns.set(sessionID, turnSnapshotId)
  }

  export function turnSnapshotIdFor(sessionID: string) {
    return activeTurns.get(sessionID)
  }

  export function clearTurn(sessionID: string, turnSnapshotId?: string) {
    if (turnSnapshotId && activeTurns.get(sessionID) !== turnSnapshotId) return
    activeTurns.delete(sessionID)
  }

  export function connected(sessionID: string): RuntimeEventEnvelope {
    return envelope({
      sessionID,
      type: "runtime.server.connected",
      data: {
        protocolVersions: [RuntimeControllerProtocol.VERSION],
        eventTypes: RuntimeControllerProtocol.RuntimeEventTypes,
      },
    })
  }

  export function heartbeat(sessionID: string): RuntimeEventEnvelope {
    return envelope({
      sessionID,
      type: "runtime.server.heartbeat",
      data: {},
    })
  }

  export function project(
    event: { type: string; properties?: unknown },
    options?: { sessionID?: string },
  ): RuntimeEventEnvelope[] {
    const properties = asRecord(event.properties)
    const sessionID = sessionIDFrom(event.type, properties)
    if (!sessionID) return []
    if (options?.sessionID && options.sessionID !== sessionID) return []

    const turnSnapshotId = turnSnapshotIdFrom(properties) ?? turnSnapshotIdFor(sessionID)
    const base = {
      sessionID,
      turnSnapshotId,
      legacy: {
        type: event.type,
        properties: event.properties,
      },
    }

    let projected: RuntimeEventEnvelope[] = []
    switch (event.type) {
      case "session.created":
        projected = [
          envelope({
            ...base,
            type: "runtime.session.created",
            data: { session: properties.info },
          }),
        ]
        break
      case "session.updated":
        projected = [
          envelope({
            ...base,
            type: "runtime.session.updated",
            data: { session: properties.info },
          }),
        ]
        break
      case "session.deleted":
        projected = [
          envelope({
            ...base,
            type: "runtime.session.deleted",
            data: { session: properties.info },
          }),
        ]
        break
      case "session.status":
        projected = [
          envelope({
            ...base,
            type: "runtime.session.status",
            data: { status: properties.status },
          }),
        ]
        break
      case "session.idle":
        projected = [
          envelope({
            ...base,
            type: "runtime.turn.completed",
            data: { status: "idle" },
          }),
        ]
        clearTurn(sessionID, turnSnapshotId)
        break
      case "session.error":
        projected = [
          envelope({
            ...base,
            type: "runtime.turn.failed",
            data: { error: properties.error },
          }),
        ]
        clearTurn(sessionID, turnSnapshotId)
        break
      case "message.created":
        projected = [
          envelope({
            ...base,
            type: "runtime.message.created",
            data: { message: properties.info },
          }),
        ]
        break
      case "message.updated":
        projected = [
          envelope({
            ...base,
            type: "runtime.message.updated",
            data: { message: properties.info },
          }),
        ]
        break
      case "message.removed":
        projected = [
          envelope({
            ...base,
            type: "runtime.message.removed",
            data: {
              messageId: properties.messageID,
            },
          }),
        ]
        break
      case "message.part.updated":
        projected = [
          envelope({
            ...base,
            type: "runtime.message.part.updated",
            data: {
              part: properties.part,
              delta: properties.delta,
            },
          }),
          ...artifactEventsFromPart(base, properties.part),
        ]
        break
      case "message.part.removed":
        projected = [
          envelope({
            ...base,
            type: "runtime.message.part.removed",
            data: {
              messageId: properties.messageID,
              partId: properties.partID,
            },
          }),
        ]
        break
      case "question.asked":
        projected = [
          envelope({
            ...base,
            type: "runtime.interaction.requested",
            data: {
              kind: "question",
              requestId: properties.id,
              questions: properties.questions,
              tool: properties.tool,
              fallbackAction: {
                type: "continue-in-web",
                label: "Continue in web",
              },
            },
          }),
        ]
        break
      case "question.replied":
        projected = [
          envelope({
            ...base,
            type: "runtime.interaction.answered",
            data: {
              kind: "question",
              requestId: properties.requestID,
              answer: {
                answers: properties.answers,
              },
            },
          }),
        ]
        break
      case "question.rejected":
        projected = [
          envelope({
            ...base,
            type: "runtime.interaction.answered",
            data: {
              kind: "question",
              requestId: properties.requestID,
              answer: "deny",
            },
          }),
        ]
        break
      case "permission.asked":
        projected = [
          envelope({
            ...base,
            type: "runtime.interaction.requested",
            data: {
              kind: "permission",
              requestId: properties.id,
              permission: properties.permission,
              patterns: properties.patterns,
              always: properties.always,
              metadata: properties.metadata,
              options: ["allow-once", "allow-session", "deny"],
              fallbackAction: {
                type: "continue-in-web",
                label: "Continue in web",
              },
            },
          }),
        ]
        break
      case "permission.replied":
        projected = [
          envelope({
            ...base,
            type: "runtime.interaction.answered",
            data: {
              kind: "permission",
              requestId: properties.requestID,
              answer: permissionAnswer(properties.reply),
            },
          }),
        ]
        break
      case "file-preview.open":
        projected = [
          envelope({
            ...base,
            type: "runtime.artifact.available",
            data: {
              artifactId: properties.id,
              kind: "preview",
              filename: properties.filename,
              mime: properties.mime,
              path: properties.path,
              size: properties.size,
              preview: {
                inlineContentBase64: properties.content,
                interactive: properties.interactive,
              },
              source: {
                type: "tool",
                tool: "display_file",
              },
            },
          }),
        ]
        break
      case "file-preview.close":
        projected = [
          envelope({
            ...base,
            type: "runtime.artifact.closed",
            data: {
              artifactId: properties.id,
            },
          }),
        ]
        break
      case "runtime.resource.failed":
        projected = [
          envelope({
            ...base,
            type: "runtime.resource.failed",
            data: properties,
          }),
        ]
        break
      case "runtime.resources.resolved":
        projected = [
          envelope({
            ...base,
            type: "runtime.resources.resolved",
            data: properties,
          }),
        ]
        break
      case "runtime.context.compiled":
        projected = [
          envelope({
            ...base,
            type: "runtime.context.compiled",
            data: properties,
          }),
        ]
        break
      case "runtime.turn.started":
        projected = [
          envelope({
            ...base,
            type: "runtime.turn.started",
            data: properties,
          }),
        ]
        break
      case "todo.updated":
        projected = [
          envelope({
            ...base,
            type: "runtime.todo.updated",
            data: properties,
          }),
        ]
        break
    }

    return projected
  }

  function artifactEventsFromPart(
    base: { sessionID: string; turnSnapshotId?: string; legacy?: RuntimeEventEnvelope["legacy"] },
    part: unknown,
  ) {
    const record = asRecord(part)
    if (record.type === "file") {
      return [
        envelope({
          ...base,
          type: "runtime.artifact.available",
          data: artifactFromFilePart(record as MessageV2.FilePart, {
            type: "message-part",
            messageId: stringValue(record.messageID),
            partId: stringValue(record.id),
          }),
        }),
      ]
    }
    if (record.type !== "tool") return []
    const toolPart = record as MessageV2.ToolPart
    if (toolPart.state.status !== "completed" || !toolPart.state.attachments?.length) return []
    return toolPart.state.attachments.map((attachment) =>
      envelope({
        ...base,
        type: "runtime.artifact.available",
        data: artifactFromFilePart(attachment, {
          type: "tool-call",
          tool: toolPart.tool,
          callId: toolPart.callID,
          messageId: toolPart.messageID,
          partId: toolPart.id,
        }),
      }),
    )
  }

  function artifactFromFilePart(file: MessageV2.FilePart, source: Record<string, unknown>) {
    return {
      artifactId: file.id,
      kind: artifactKind(file.mime),
      filename: file.filename,
      mime: file.mime,
      url: file.url,
      source,
      presentation: {
        downloadable: true,
        previewable: file.mime.startsWith("image/"),
      },
    }
  }

  function artifactKind(mime: string) {
    if (mime.startsWith("image/")) return "image"
    if (mime === "application/pdf") return "document"
    return "file"
  }

  function permissionAnswer(reply: unknown) {
    if (reply === "once") return "allow-once"
    if (reply === "always") return "allow-session"
    return "deny"
  }

  function envelope<T>(input: {
    sessionID: string
    turnSnapshotId?: string
    type: RuntimeControllerProtocol.RuntimeEventType
    data: T
    legacy?: RuntimeEventEnvelope["legacy"]
  }): RuntimeEventEnvelope<T> {
    return {
      version: RuntimeControllerProtocol.VERSION,
      id: ulid(),
      sessionId: input.sessionID,
      turnSnapshotId: input.turnSnapshotId,
      createdAt: Date.now(),
      type: input.type,
      data: input.data,
      legacy: input.legacy,
    }
  }

  function sessionIDFrom(eventType: string, properties: Record<string, unknown>) {
    const direct = stringValue(properties.sessionID) ?? stringValue(properties.sessionId)
    if (direct) return direct

    const info = asRecord(properties.info)
    if (stringValue(info.sessionID)) return stringValue(info.sessionID)
    if (eventType.startsWith("session.") && stringValue(info.id)) return stringValue(info.id)

    const part = asRecord(properties.part)
    if (stringValue(part.sessionID)) return stringValue(part.sessionID)

    const message = asRecord(properties.message)
    const messageInfo = asRecord(message.info)
    return stringValue(messageInfo.sessionID)
  }

  function turnSnapshotIdFrom(properties: Record<string, unknown>) {
    return stringValue(properties.turnSnapshotId) ?? stringValue(properties.turnSnapshotID)
  }

  function asRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object") return input as Record<string, unknown>
    return {}
  }

  function stringValue(input: unknown) {
    return typeof input === "string" ? input : undefined
  }
}
