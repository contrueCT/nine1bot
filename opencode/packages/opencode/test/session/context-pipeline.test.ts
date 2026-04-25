import { describe, expect, test } from "bun:test"
import { RuntimeContextPipeline } from "../../src/runtime/context/pipeline"

describe("RuntimeContextPipeline", () => {
  test("renders enabled blocks in stable layer order and audits dropped blocks", async () => {
    const compiled = await RuntimeContextPipeline.compile({
      now: 1_000,
      policy: {
        tokenBudget: 12,
      },
      blocks: [
        RuntimeContextPipeline.textBlock({
          id: "page:current",
          layer: "page",
          source: "test.page",
          content: "page context",
          lifecycle: "turn",
          priority: 1,
        }),
        RuntimeContextPipeline.textBlock({
          id: "base:identity",
          layer: "base",
          source: "test.base",
          content: "identity",
          lifecycle: "session",
          priority: 1,
        }),
        {
          ...RuntimeContextPipeline.textBlock({
            id: "user:disabled",
            layer: "user",
            source: "test.user",
            content: "disabled",
          }),
          enabled: false,
        },
        {
          ...RuntimeContextPipeline.textBlock({
            id: "runtime:stale",
            layer: "runtime",
            source: "test.runtime",
            content: "stale",
            observedAt: 100,
          }),
          staleAfterMs: 10,
        },
        {
          id: "platform:unsupported",
          layer: "platform",
          source: "test.platform",
          enabled: true,
          priority: 1,
          lifecycle: "turn",
          visibility: "developer-toggle",
          content: {
            resolver: "future-resolver",
          },
        },
        RuntimeContextPipeline.textBlock({
          id: "platform:budget",
          layer: "platform",
          source: "test.platform",
          content: "this optional block should exceed the small budget",
          lifecycle: "turn",
          priority: 1,
        }),
      ],
    })

    expect(compiled.blocks.map((block) => block.id)).toEqual(["base:identity", "page:current"])
    expect(compiled.rendered.join("\n")).toContain('<context_block id="base:identity" layer="base" source="test.base">')
    expect(compiled.dropped.map((block) => [block.id, block.reason])).toEqual([
      ["user:disabled", "disabled"],
      ["runtime:stale", "stale"],
      ["platform:unsupported", "resolver-error"],
      ["platform:budget", "budget"],
    ])
    expect(compiled.audit.find((block) => block.id === "page:current")?.rendered).toBe(true)
  })
})
