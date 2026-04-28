export type Tokens = {
  input: number
  output: number
  reasoning: number
  cache: {
    read: number
    write: number
  }
}

export type ControllerApiMetricEvent = {
  kind: "controller_api"
  recordedAt: number
  route: string
  method: string
  status: number
  durationMs: number
  entrySource?: string
  platform?: string
  mode?: string
  traceId?: string
  protocolVersion?: string
  accepted?: boolean
  busy?: boolean
  errorType?: string
}

export type TurnMetricEvent =
  | {
      kind: "turn"
      status: "completed"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      agent?: string
      providerID?: string
      modelID?: string
      finishReason?: string
      tokens?: Tokens
      costUsd?: number
      firstTokenLatencyMs?: number
      durationMs?: number
    }
  | {
      kind: "turn"
      status: "failed"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      agent?: string
      providerID?: string
      modelID?: string
      errorType?: string
      errorMessage?: string
      durationMs?: number
    }

export type ToolMetricEvent =
  | {
      kind: "tool"
      status: "started"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      messageID: string
      partID: string
      tool: string
      toolCallId: string
      startedAt: number
    }
  | {
      kind: "tool"
      status: "completed"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      messageID: string
      partID: string
      tool: string
      toolCallId: string
      startedAt: number
      finishedAt: number
      durationMs: number
      title?: string
      attachmentCount?: number
    }
  | {
      kind: "tool"
      status: "failed"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      messageID: string
      partID: string
      tool: string
      toolCallId: string
      startedAt: number
      finishedAt: number
      durationMs: number
      errorType?: string
      errorMessage?: string
    }

export type ResourceMetricEvent =
  | {
      kind: "resource"
      status: "resolved"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      declaredMcp: number
      declaredSkills: number
      resolvedMcp: number
      resolvedSkills: number
      failures: number
    }
  | {
      kind: "resource"
      status: "failed"
      recordedAt: number
      sessionID: string
      turnSnapshotId?: string
      resourceType: "mcp" | "skill"
      resourceID: string
      failureStatus: "degraded" | "unavailable" | "auth-required"
      stage: "resolve" | "connect" | "auth" | "load" | "execute"
      reason?: string
      recoverable: boolean
    }

export type RuntimeMetricEvent =
  | ControllerApiMetricEvent
  | TurnMetricEvent
  | ToolMetricEvent
  | ResourceMetricEvent

export type MetricsOverview = {
  requestsTotal: number
  requestsSucceeded: number
  requestsFailed: number
  successRate: number
  busyRejects: number
  busyRejectRate: number
  p95ApiDurationMs?: number
  p99ApiDurationMs?: number
  totalTokens: number
  totalCostUsd: number
  toolCallsTotal: number
  toolSuccessRate: number
  resourceFailuresTotal: number
}

export type ModelMetricsRow = {
  providerID: string
  modelID: string
  turns: number
  failures: number
  avgFirstTokenLatencyMs?: number
  p95DurationMs?: number
  totalInputTokens: number
  totalOutputTokens: number
  totalReasoningTokens: number
  totalCostUsd: number
  finishReasons: Record<string, number>
}

export type ToolMetricsRow = {
  tool: string
  calls: number
  successes: number
  failures: number
  successRate: number
  avgDurationMs?: number
  p95DurationMs?: number
  failureReasons: Record<string, number>
}

export type ResourceMetricsRow = {
  resourceType: "mcp" | "skill"
  resourceID: string
  failures: number
  recoverableFailures: number
  statuses: Record<string, number>
  stages: Record<string, number>
  reasons: Record<string, number>
}

export type MetricsTimelineBucket = {
  timestamp: number
  requests: number
  successRate: number
  avgApiDurationMs: number
  totalTokens: number
  totalCostUsd: number
  toolCalls: number
}
