import { describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"

describe("MCP prompt tool resolution", () => {
  test("isolates a stalled client while returning healthy tools", async () => {
    const failures: string[] = []
    const starts: string[] = []
    const startedAt = Date.now()
    const resolution = MCP._testing.resolveToolSources(
      [
        {
          server: "stalled",
          timeoutMs: 20,
          client: {
            listTools: () => {
              starts.push("stalled")
              return new Promise(() => {})
            },
          },
        },
        {
          server: "healthy",
          timeoutMs: 20,
          client: {
            async listTools() {
              starts.push("healthy")
              return {
                tools: [
                  {
                    name: "healthy-tool",
                    description: "healthy",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            },
          },
        },
      ],
      async (failure) => {
        failures.push(failure.server)
      },
    )
    await Promise.resolve()
    expect(starts).toEqual(["stalled", "healthy"])
    const result = await resolution

    expect(Date.now() - startedAt).toBeLessThan(200)
    expect(result).toEqual([
      {
        server: "healthy",
        cached: false,
        tools: [
          {
            name: "healthy-tool",
            description: "healthy",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ])
    expect(failures).toEqual(["stalled"])
  })

  test("uses a valid cache without calling the client again", async () => {
    let calls = 0
    const result = await MCP._testing.resolveToolSources([
      {
        server: "cached",
        timeoutMs: 20,
        cached: [
          {
            name: "cached-tool",
            description: "cached",
            inputSchema: { type: "object", properties: {} },
          },
        ],
        client: {
          async listTools() {
            calls++
            return { tools: [] }
          },
        },
      },
    ])

    expect(calls).toBe(0)
    expect(result[0]?.cached).toBe(true)
    expect(result[0]?.tools[0]?.name).toBe("cached-tool")
  })
})


test("MCP execution forwards cancellation and does not dispatch already-aborted calls", async () => {
  const controller = new AbortController()
  let calls = 0
  let receivedSignal: AbortSignal | undefined
  const started = Promise.withResolvers<void>()
  const mcpTool = await MCP._testing.convertMcpTool("test", {
    name: "cancel-test", inputSchema: { type: "object" },
  }, {
    async callTool(_request: unknown, _schema: unknown, options: { signal?: AbortSignal }) {
      calls++
      receivedSignal = options.signal
      started.resolve()
      return await new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true })
      })
    },
  } as never)
  const options = { toolCallId: "test", messages: [], abortSignal: controller.signal }
  const execution = mcpTool.execute!({}, options)
  const outcome = Promise.resolve(execution).catch((error: unknown) => error)
  await started.promise
  controller.abort(new Error("MCP stopped"))
  expect(await outcome).toMatchObject({ message: "MCP stopped" })
  expect(receivedSignal).toBe(controller.signal)
  await expect(mcpTool.execute!({}, options)).rejects.toThrow("MCP stopped")
  expect(calls).toBe(1)
})
