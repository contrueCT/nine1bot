import { describe, expect, test } from "bun:test"
import { RuntimeMetricsNormalizer } from "../../src/runtime/metrics/normalizer"
import { RuntimeMetricsAggregator } from "../../src/runtime/metrics/aggregator"
import { RuntimeMetricsQueries } from "../../src/runtime/metrics/queries"

describe("Runtime metrics pipeline", () => {
  test("normalizes controller, turn, and tool events", () => {
    const controller = RuntimeMetricsNormalizer.normalize({
      type: "runtime.metrics.controller_api.completed",
      properties: {
        route: "/nine1bot/agent/sessions/:sessionID/messages",
        method: "POST",
        status: 200,
        durationMs: 120,
        completedAt: 1000,
      },
    })

    const turn = RuntimeMetricsNormalizer.normalize({
      type: "runtime.turn.completed",
      properties: {
        sessionID: "session_test",
        turnSnapshotId: "turn_test",
        providerID: "openai",
        modelID: "gpt-5.4",
        finishReason: "stop",
        costUsd: 0.25,
        durationMs: 900,
        firstTokenLatencyMs: 140,
        completedAt: 2000,
        tokens: {
          input: 100,
          output: 40,
          reasoning: 5,
          cache: {
            read: 20,
            write: 10,
          },
        },
      },
    })

    const tool = RuntimeMetricsNormalizer.normalize({
      type: "runtime.tool.failed",
      properties: {
        sessionID: "session_test",
        turnSnapshotId: "turn_test",
        messageID: "message_test",
        partID: "part_test",
        tool: "read_file",
        toolCallId: "call_test",
        startedAt: 3000,
        finishedAt: 3200,
        durationMs: 200,
        errorType: "PermissionDeniedError",
      },
    })

    expect(controller[0]).toMatchObject({
      kind: "controller_api",
      route: "/nine1bot/agent/sessions/:sessionID/messages",
    })
    expect(turn[0]).toMatchObject({
      kind: "turn",
      status: "completed",
      providerID: "openai",
      modelID: "gpt-5.4",
    })
    expect(tool[0]).toMatchObject({
      kind: "tool",
      status: "failed",
      tool: "read_file",
      errorType: "PermissionDeniedError",
    })
  })

  test("aggregates overview, models, and tools", () => {
    const events = [
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.metrics.controller_api.completed",
        properties: {
          route: "/nine1bot/runtime/capabilities",
          method: "GET",
          status: 200,
          durationMs: 40,
          completedAt: 100,
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.metrics.controller_api.completed",
        properties: {
          route: "/nine1bot/agent/sessions/:sessionID/messages",
          method: "POST",
          status: 409,
          durationMs: 80,
          busy: true,
          completedAt: 200,
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.turn.completed",
        properties: {
          sessionID: "session_test",
          providerID: "openai",
          modelID: "gpt-5.4",
          finishReason: "stop",
          costUsd: 0.5,
          durationMs: 1000,
          firstTokenLatencyMs: 150,
          completedAt: 300,
          tokens: {
            input: 120,
            output: 30,
            reasoning: 10,
            cache: {
              read: 25,
              write: 5,
            },
          },
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.tool.completed",
        properties: {
          sessionID: "session_test",
          messageID: "message_test",
          partID: "part_test_1",
          tool: "read_file",
          toolCallId: "call_test_1",
          startedAt: 400,
          finishedAt: 460,
          durationMs: 60,
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.tool.failed",
        properties: {
          sessionID: "session_test",
          messageID: "message_test",
          partID: "part_test_2",
          tool: "read_file",
          toolCallId: "call_test_2",
          startedAt: 500,
          finishedAt: 620,
          durationMs: 120,
          errorType: "PermissionDeniedError",
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.resource.failed",
        properties: {
          sessionID: "session_test",
          resourceType: "mcp",
          resourceID: "github",
          status: "auth-required",
          stage: "auth",
          reason: "missing-token",
          recoverable: true,
        },
      }),
    ]

    const overview = RuntimeMetricsAggregator.overview(events)
    const models = RuntimeMetricsAggregator.models(events)
    const tools = RuntimeMetricsAggregator.tools(events)
    const resources = RuntimeMetricsAggregator.resources(events)
    const summary = RuntimeMetricsQueries.summarize(events)

    expect(overview).toMatchObject({
      requestsTotal: 2,
      requestsSucceeded: 1,
      busyRejects: 1,
      totalCostUsd: 0.5,
      toolCallsTotal: 2,
    })
    expect(models[0]).toMatchObject({
      providerID: "openai",
      modelID: "gpt-5.4",
      turns: 1,
      totalInputTokens: 120,
      totalOutputTokens: 30,
    })
    expect(tools[0]).toMatchObject({
      tool: "read_file",
      calls: 2,
      successes: 1,
      failures: 1,
    })
    expect(resources[0]).toMatchObject({
      resourceType: "mcp",
      resourceID: "github",
      failures: 1,
      recoverableFailures: 1,
    })
    expect(summary.resources[0]).toMatchObject({
      resourceID: "github",
    })
  })

  test("filters detail events by session-aware fields without leaking controller events", () => {
    const events = [
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.metrics.controller_api.completed",
        properties: {
          route: "/nine1bot/agent/capabilities",
          method: "GET",
          status: 200,
          durationMs: 4,
          completedAt: 100,
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.turn.completed",
        properties: {
          sessionID: "session_a",
          turnSnapshotId: "turn_a",
          providerID: "openai",
          modelID: "gpt-5.4",
          completedAt: 200,
          durationMs: 50,
        },
      }),
      ...RuntimeMetricsNormalizer.normalize({
        type: "runtime.turn.completed",
        properties: {
          sessionID: "session_b",
          turnSnapshotId: "turn_b",
          providerID: "openai",
          modelID: "gpt-5.4",
          completedAt: 300,
          durationMs: 60,
        },
      }),
    ]

    const detail = RuntimeMetricsQueries.detail(events, {
      sessionID: "session_a",
    })

    expect(detail).toHaveLength(1)
    expect(detail[0]).toMatchObject({
      kind: "turn",
      sessionID: "session_a",
    })
  })
})
