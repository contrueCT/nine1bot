import { afterEach, describe, expect, test } from "bun:test"
import z from "zod"
import fs from "fs/promises"
import { Tool } from "../../src/tool/tool"

const createdOutputPaths: string[] = []

const baseContext: Tool.Context = {
  sessionID: "session_test",
  messageID: "message_test",
  agent: "agent_test",
  abort: new AbortController().signal,
  cwd: process.cwd(),
  extra: {},
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

afterEach(async () => {
  while (createdOutputPaths.length > 0) {
    const outputPath = createdOutputPaths.pop()
    if (!outputPath) continue
    await fs.unlink(outputPath).catch(() => {})
  }
})

describe("Tool.define truncation options", () => {
  test("uses head truncation when direction is not specified", async () => {
    const output = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const tool = Tool.define(
      "test_head_truncation",
      {
        description: "test",
        parameters: z.object({}),
        execute: async () => ({
          title: "head",
          output,
          metadata: {},
        }),
      },
      {
        truncation: { maxLines: 3 },
      },
    )

    const initialized = await tool.init()
    const result = await initialized.execute({}, baseContext)
    const metadata = result.metadata as { truncated?: boolean; outputPath?: string }
    const outputPath = metadata.outputPath
    if (outputPath) createdOutputPaths.push(outputPath)

    expect(metadata.truncated).toBe(true)
    expect(result.output).toContain("line0")
    expect(result.output).toContain("line1")
    expect(result.output).toContain("line2")
    expect(result.output).not.toContain("line9")
  })

  test("uses tail truncation when direction is tail", async () => {
    const output = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n")
    const tool = Tool.define(
      "test_tail_truncation",
      {
        description: "test",
        parameters: z.object({}),
        execute: async () => ({
          title: "tail",
          output,
          metadata: {},
        }),
      },
      {
        truncation: { maxLines: 3, direction: "tail" },
      },
    )

    const initialized = await tool.init()
    const result = await initialized.execute({}, baseContext)
    const metadata = result.metadata as { truncated?: boolean; outputPath?: string }
    const outputPath = metadata.outputPath
    if (outputPath) createdOutputPaths.push(outputPath)

    expect(metadata.truncated).toBe(true)
    expect(result.output).toContain("line7")
    expect(result.output).toContain("line8")
    expect(result.output).toContain("line9")
    expect(result.output).not.toContain("line0")
  })
})
