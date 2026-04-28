import type { RuntimeMetricEvent } from "./types"

type RawBusEvent = {
  type: string
  properties?: unknown
}

export namespace RuntimeMetricsNormalizer {
  export function normalize(event: RawBusEvent): RuntimeMetricEvent[] {
    const properties = asRecord(event.properties)

    switch (event.type) {
      case "runtime.metrics.controller_api.completed":
        return [
          {
            kind: "controller_api",
            recordedAt: numberValue(properties.completedAt) ?? Date.now(),
            route: stringValue(properties.route) ?? "unknown",
            method: stringValue(properties.method) ?? "UNKNOWN",
            status: numberValue(properties.status) ?? 0,
            durationMs: numberValue(properties.durationMs) ?? 0,
            entrySource: stringValue(properties.entrySource),
            platform: stringValue(properties.platform),
            mode: stringValue(properties.mode),
            traceId: stringValue(properties.traceId),
            protocolVersion: stringValue(properties.protocolVersion),
            accepted: booleanValue(properties.accepted),
            busy: booleanValue(properties.busy),
            errorType: stringValue(properties.errorType),
          },
        ]

      case "runtime.turn.completed":
        return [
          {
            kind: "turn",
            status: "completed",
            recordedAt: numberValue(properties.completedAt) ?? Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            agent: stringValue(properties.agent),
            providerID: stringValue(properties.providerID),
            modelID: stringValue(properties.modelID),
            finishReason: stringValue(properties.finishReason),
            tokens: tokensValue(properties.tokens),
            costUsd: numberValue(properties.costUsd),
            firstTokenLatencyMs: numberValue(properties.firstTokenLatencyMs),
            durationMs: numberValue(properties.durationMs),
          },
        ]

      case "runtime.turn.failed":
        return [
          {
            kind: "turn",
            status: "failed",
            recordedAt: numberValue(properties.failedAt) ?? Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            agent: stringValue(properties.agent),
            providerID: stringValue(properties.providerID),
            modelID: stringValue(properties.modelID),
            errorType: stringValue(properties.errorType),
            errorMessage: stringValue(properties.errorMessage),
            durationMs: numberValue(properties.durationMs),
          },
        ]

      case "runtime.tool.started":
        return [
          {
            kind: "tool",
            status: "started",
            recordedAt: numberValue(properties.startedAt) ?? Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            messageID: stringValue(properties.messageID) ?? "",
            partID: stringValue(properties.partID) ?? "",
            tool: stringValue(properties.tool) ?? "unknown",
            toolCallId: stringValue(properties.toolCallId) ?? "",
            startedAt: numberValue(properties.startedAt) ?? 0,
          },
        ]

      case "runtime.tool.completed":
        return [
          {
            kind: "tool",
            status: "completed",
            recordedAt: numberValue(properties.finishedAt) ?? Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            messageID: stringValue(properties.messageID) ?? "",
            partID: stringValue(properties.partID) ?? "",
            tool: stringValue(properties.tool) ?? "unknown",
            toolCallId: stringValue(properties.toolCallId) ?? "",
            startedAt: numberValue(properties.startedAt) ?? 0,
            finishedAt: numberValue(properties.finishedAt) ?? 0,
            durationMs: numberValue(properties.durationMs) ?? 0,
            title: stringValue(properties.title),
            attachmentCount: numberValue(properties.attachmentCount),
          },
        ]

      case "runtime.tool.failed":
        return [
          {
            kind: "tool",
            status: "failed",
            recordedAt: numberValue(properties.finishedAt) ?? Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            messageID: stringValue(properties.messageID) ?? "",
            partID: stringValue(properties.partID) ?? "",
            tool: stringValue(properties.tool) ?? "unknown",
            toolCallId: stringValue(properties.toolCallId) ?? "",
            startedAt: numberValue(properties.startedAt) ?? 0,
            finishedAt: numberValue(properties.finishedAt) ?? 0,
            durationMs: numberValue(properties.durationMs) ?? 0,
            errorType: stringValue(properties.errorType),
            errorMessage: stringValue(properties.errorMessage),
          },
        ]

      case "runtime.resources.resolved": {
        const declared = asRecord(properties.declared)
        const resolved = asRecord(properties.resolved)
        return [
          {
            kind: "resource",
            status: "resolved",
            recordedAt: Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            declaredMcp: arrayValue(declared.mcp).length,
            declaredSkills: arrayValue(declared.skills).length,
            resolvedMcp: arrayValue(resolved.mcp).length,
            resolvedSkills: arrayValue(resolved.skills).length,
            failures: numberValue(properties.failures) ?? 0,
          },
        ]
      }

      case "runtime.resource.failed":
        return [
          {
            kind: "resource",
            status: "failed",
            recordedAt: Date.now(),
            sessionID: stringValue(properties.sessionID) ?? "",
            turnSnapshotId: stringValue(properties.turnSnapshotId),
            resourceType: enumValue(properties.resourceType, ["mcp", "skill"]) ?? "mcp",
            resourceID: stringValue(properties.resourceID) ?? "",
            failureStatus: enumValue(properties.status, ["degraded", "unavailable", "auth-required"]) ?? "unavailable",
            stage: enumValue(properties.stage, ["resolve", "connect", "auth", "load", "execute"]) ?? "resolve",
            reason: stringValue(properties.reason),
            recoverable: booleanValue(properties.recoverable) ?? false,
          },
        ]

      default:
        return []
    }
  }

  function asRecord(input: unknown): Record<string, unknown> {
    if (input && typeof input === "object") return input as Record<string, unknown>
    return {}
  }

  function stringValue(input: unknown) {
    return typeof input === "string" ? input : undefined
  }

  function numberValue(input: unknown) {
    return typeof input === "number" && Number.isFinite(input) ? input : undefined
  }

  function booleanValue(input: unknown) {
    return typeof input === "boolean" ? input : undefined
  }

  function arrayValue(input: unknown) {
    return Array.isArray(input) ? input : []
  }

  function enumValue<T extends string>(input: unknown, values: readonly T[]) {
    return typeof input === "string" && values.includes(input as T) ? (input as T) : undefined
  }

  function tokensValue(input: unknown) {
    const record = asRecord(input)
    const cache = asRecord(record.cache)
    if (
      typeof record.input !== "number" ||
      typeof record.output !== "number" ||
      typeof record.reasoning !== "number" ||
      typeof cache.read !== "number" ||
      typeof cache.write !== "number"
    ) {
      return undefined
    }
    return {
      input: record.input,
      output: record.output,
      reasoning: record.reasoning,
      cache: {
        read: cache.read,
        write: cache.write,
      },
    }
  }
}
