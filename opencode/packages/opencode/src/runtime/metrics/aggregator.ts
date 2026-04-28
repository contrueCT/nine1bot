import type {
  MetricsOverview,
  MetricsTimelineBucket,
  ModelMetricsRow,
  ResourceMetricsRow,
  RuntimeMetricEvent,
  ToolMetricsRow,
} from "./types"

export namespace RuntimeMetricsAggregator {
  export function overview(events: RuntimeMetricEvent[]): MetricsOverview {
    const controller = events.filter((event) => event.kind === "controller_api")
    const completedTurns = events.filter((event) => event.kind === "turn" && event.status === "completed")
    const completedTools = events.filter((event) => event.kind === "tool" && event.status === "completed")
    const failedTools = events.filter((event) => event.kind === "tool" && event.status === "failed")
    const resourceFailures = events.filter((event) => event.kind === "resource" && event.status === "failed")

    const requestDurations = controller.map((event) => event.durationMs)
    const requestsSucceeded = controller.filter((event) => event.status >= 200 && event.status < 400).length
    const busyRejects = controller.filter((event) => event.busy).length
    const totalTokens = completedTurns.reduce((sum, event) => {
      const tokens = event.tokens
      if (!tokens) return sum
      return sum + tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
    }, 0)

    return {
      requestsTotal: controller.length,
      requestsSucceeded,
      requestsFailed: controller.length - requestsSucceeded,
      successRate: rate(requestsSucceeded, controller.length),
      busyRejects,
      busyRejectRate: rate(busyRejects, controller.length),
      p95ApiDurationMs: percentile(requestDurations, 95),
      p99ApiDurationMs: percentile(requestDurations, 99),
      totalTokens,
      totalCostUsd: completedTurns.reduce((sum, event) => sum + (event.costUsd ?? 0), 0),
      toolCallsTotal: completedTools.length + failedTools.length,
      toolSuccessRate: rate(completedTools.length, completedTools.length + failedTools.length),
      resourceFailuresTotal: resourceFailures.length,
    }
  }

  export function models(events: RuntimeMetricEvent[]): ModelMetricsRow[] {
    const grouped = new Map<string, ModelMetricsRow & { durations: number[]; firstTokenLatencies: number[] }>()

    for (const event of events) {
      if (event.kind !== "turn") continue
      const providerID = event.providerID ?? "unknown"
      const modelID = event.modelID ?? "unknown"
      const key = `${providerID}/${modelID}`
      const existing =
        grouped.get(key) ??
        {
          providerID,
          modelID,
          turns: 0,
          failures: 0,
          totalInputTokens: 0,
          totalOutputTokens: 0,
          totalReasoningTokens: 0,
          totalCostUsd: 0,
          finishReasons: {},
          durations: [],
          firstTokenLatencies: [],
        }

      if (event.status === "completed") {
        existing.turns += 1
        existing.totalInputTokens += event.tokens?.input ?? 0
        existing.totalOutputTokens += event.tokens?.output ?? 0
        existing.totalReasoningTokens += event.tokens?.reasoning ?? 0
        existing.totalCostUsd += event.costUsd ?? 0
        if (event.durationMs !== undefined) existing.durations.push(event.durationMs)
        if (event.firstTokenLatencyMs !== undefined) existing.firstTokenLatencies.push(event.firstTokenLatencyMs)
        if (event.finishReason) {
          existing.finishReasons[event.finishReason] = (existing.finishReasons[event.finishReason] ?? 0) + 1
        }
      } else {
        existing.failures += 1
      }

      grouped.set(key, existing)
    }

    return [...grouped.values()]
      .map((row) => ({
        providerID: row.providerID,
        modelID: row.modelID,
        turns: row.turns,
        failures: row.failures,
        avgFirstTokenLatencyMs: average(row.firstTokenLatencies),
        p95DurationMs: percentile(row.durations, 95),
        totalInputTokens: row.totalInputTokens,
        totalOutputTokens: row.totalOutputTokens,
        totalReasoningTokens: row.totalReasoningTokens,
        totalCostUsd: row.totalCostUsd,
        finishReasons: row.finishReasons,
      }))
      .sort((a, b) => b.turns - a.turns)
  }

  export function tools(events: RuntimeMetricEvent[]): ToolMetricsRow[] {
    const grouped = new Map<string, ToolMetricsRow & { durations: number[] }>()

    for (const event of events) {
      if (event.kind !== "tool" || event.status === "started") continue
      const existing =
        grouped.get(event.tool) ??
        {
          tool: event.tool,
          calls: 0,
          successes: 0,
          failures: 0,
          successRate: 0,
          failureReasons: {},
          durations: [],
        }

      existing.calls += 1
      existing.durations.push(event.durationMs)
      if (event.status === "completed") {
        existing.successes += 1
      } else {
        existing.failures += 1
        const reason = event.errorType ?? "UnknownError"
        existing.failureReasons[reason] = (existing.failureReasons[reason] ?? 0) + 1
      }

      grouped.set(event.tool, existing)
    }

    return [...grouped.values()]
      .map((row) => ({
        tool: row.tool,
        calls: row.calls,
        successes: row.successes,
        failures: row.failures,
        successRate: rate(row.successes, row.calls),
        avgDurationMs: average(row.durations),
        p95DurationMs: percentile(row.durations, 95),
        failureReasons: row.failureReasons,
      }))
      .sort((a, b) => b.calls - a.calls)
  }

  export function resources(events: RuntimeMetricEvent[]): ResourceMetricsRow[] {
    const grouped = new Map<string, ResourceMetricsRow>()

    for (const event of events) {
      if (event.kind !== "resource" || event.status !== "failed") continue
      const key = `${event.resourceType}:${event.resourceID}`
      const existing =
        grouped.get(key) ??
        {
          resourceType: event.resourceType,
          resourceID: event.resourceID,
          failures: 0,
          recoverableFailures: 0,
          statuses: {},
          stages: {},
          reasons: {},
        }

      existing.failures += 1
      if (event.recoverable) existing.recoverableFailures += 1
      existing.statuses[event.failureStatus] = (existing.statuses[event.failureStatus] ?? 0) + 1
      existing.stages[event.stage] = (existing.stages[event.stage] ?? 0) + 1
      if (event.reason) {
        existing.reasons[event.reason] = (existing.reasons[event.reason] ?? 0) + 1
      }
      grouped.set(key, existing)
    }

    return [...grouped.values()].sort((a, b) => b.failures - a.failures)
  }

  export function timeline(events: RuntimeMetricEvent[], options?: { bucketMs?: number }): MetricsTimelineBucket[] {
    const bucketMs = options?.bucketMs ?? 60 * 60 * 1000
    const grouped = new Map<
      number,
      {
        timestamp: number
        requests: number
        requestSuccesses: number
        apiDurations: number[]
        totalTokens: number
        totalCostUsd: number
        toolCalls: number
      }
    >()

    for (const event of events) {
      const timestamp = floorToBucket(event.recordedAt, bucketMs)
      const existing =
        grouped.get(timestamp) ??
        {
          timestamp,
          requests: 0,
          requestSuccesses: 0,
          apiDurations: [],
          totalTokens: 0,
          totalCostUsd: 0,
          toolCalls: 0,
        }

      if (event.kind === "controller_api") {
        existing.requests += 1
        if (event.status >= 200 && event.status < 400) existing.requestSuccesses += 1
        existing.apiDurations.push(event.durationMs)
      }

      if (event.kind === "turn" && event.status === "completed") {
        existing.totalCostUsd += event.costUsd ?? 0
        existing.totalTokens +=
          (event.tokens?.input ?? 0) +
          (event.tokens?.output ?? 0) +
          (event.tokens?.reasoning ?? 0) +
          (event.tokens?.cache.read ?? 0) +
          (event.tokens?.cache.write ?? 0)
      }

      if (event.kind === "tool" && event.status !== "started") {
        existing.toolCalls += 1
      }

      grouped.set(timestamp, existing)
    }

    return [...grouped.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((bucket) => ({
        timestamp: bucket.timestamp,
        requests: bucket.requests,
        successRate: rate(bucket.requestSuccesses, bucket.requests),
        avgApiDurationMs: average(bucket.apiDurations) ?? 0,
        totalTokens: bucket.totalTokens,
        totalCostUsd: bucket.totalCostUsd,
        toolCalls: bucket.toolCalls,
      }))
  }

  function average(values: number[]) {
    if (!values.length) return undefined
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  function percentile(values: number[], p: number) {
    if (!values.length) return undefined
    const sorted = [...values].sort((a, b) => a - b)
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    return sorted[index]
  }

  function rate(numerator: number, denominator: number) {
    if (!denominator) return 0
    return numerator / denominator
  }

  function floorToBucket(timestamp: number, bucketMs: number) {
    return Math.floor(timestamp / bucketMs) * bucketMs
  }
}
