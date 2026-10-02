import { expect, spyOn, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Identifier } from "../../src/id/id"
import { MCP } from "../../src/mcp"
import { PermissionNext } from "../../src/permission/next"
import { Plugin } from "../../src/plugin"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { RunLease } from "../../src/session/run-lease"
import { SessionRequest } from "../../src/session/request"
import { ToolRegistry } from "../../src/tool/registry"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

const model = { id: "test", providerID: "test", api: { id: "test" } } as Provider.Model

for (const kind of ["builtin", "mcp"] as const) {
  test(`${kind} permission is cancelled by the parent even when the SDK supplies its own signal`, async () => {
    await using tmp = await tmpdir({
      config: {
        model: "test/test",
        autonomous: { enabled: false, maxRetries: 3, askAfterRetries: true, allowDoomLoop: true },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const controller = new AbortController()
        const sdkController = new AbortController()
        let effects = 0
        const registry = spyOn(ToolRegistry, "resolve").mockResolvedValue({
          declaredIDs: kind === "builtin" ? ["test_builtin"] : [],
          conflicts: [],
          tools:
            kind === "builtin"
              ? [
                  {
                    id: "test_builtin",
                    description: "test",
                    parameters: z.object({}),
                    async execute(_args: unknown, ctx: any) {
                      await ctx.ask({ permission: "test_builtin", patterns: ["*"], always: ["*"], metadata: {} })
                      effects++
                      return { title: "test", output: "test", metadata: {} }
                    },
                  },
                ]
              : [],
        } as never)
        const mcp = spyOn(MCP, "tools").mockResolvedValue(
          kind === "mcp"
            ? ({
                test_mcp: {
                  description: "test",
                  inputSchema: z.object({}),
                  execute: async () => {
                    effects++
                    return { content: [] }
                  },
                },
              } as never)
            : {},
        )
        const plugin = spyOn(Plugin, "trigger").mockImplementation(async (_event, _input, output) => output as never)
        const unsubscribe = Bus.subscribe(PermissionNext.Event.Asked, () =>
          controller.abort(new Error("parent stopped")),
        )
        try {
          const resolved = await SessionPrompt._testing.resolveTools({
            agent: { name: "build", permission: [{ permission: "*", pattern: "*", action: "ask" }] } as Agent.Info,
            model,
            session,
            processor: { message: { id: "message_test" }, partFromToolCall: () => undefined } as never,
            bypassAgentCheck: false,
            messages: [],
            templateIds: [],
            abort: controller.signal,
          })
          await expect(
            resolved.tools[`test_${kind}`].execute!(
              {},
              {
                toolCallId: "call_test",
                messages: [],
                abortSignal: sdkController.signal,
              },
            ),
          ).rejects.toThrow("parent stopped")
          expect(effects).toBe(0)
          expect(await PermissionNext.list()).toEqual([])
          expect(sdkController.signal.aborted).toBe(false)
        } finally {
          unsubscribe()
          registry.mockRestore()
          mcp.mockRestore()
          plugin.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })
}

test("cancellation during a builtin before-hook prevents tool side effects", async () => {
  await using tmp = await tmpdir({ config: { model: "test/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const controller = new AbortController()
      let effects = 0
      const registry = spyOn(ToolRegistry, "resolve").mockResolvedValue({
        declaredIDs: ["test_builtin"],
        conflicts: [],
        tools: [
          {
            id: "test_builtin",
            description: "test",
            parameters: z.object({}),
            async execute() {
              effects++
              return { title: "test", output: "test", metadata: {} }
            },
          },
        ],
      } as never)
      const mcp = spyOn(MCP, "tools").mockResolvedValue({})
      const plugin = spyOn(Plugin, "trigger").mockImplementation(async (_event, _input, output) => {
        controller.abort(new Error("stopped in hook"))
        return output as never
      })
      try {
        const resolved = await SessionPrompt._testing.resolveTools({
          agent: { name: "build", permission: [] } as unknown as Agent.Info,
          model,
          session,
          processor: { message: { id: "message_test" }, partFromToolCall: () => undefined } as never,
          bypassAgentCheck: false,
          messages: [],
          templateIds: [],
          abort: controller.signal,
        })
        await expect(
          resolved.tools.test_builtin.execute!({}, { toolCallId: "call_test", messages: [] }),
        ).rejects.toThrow("stopped in hook")
        expect(effects).toBe(0)
      } finally {
        registry.mockRestore()
        mcp.mockRestore()
        plugin.mockRestore()
        await Session.remove(session.id)
      }
    },
  })
})

test("Task cancellation during prompt-part resolution cannot start the child", async () => {
  await using tmp = await tmpdir({ config: { model: "test/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const controller = new AbortController()
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        parentID: Identifier.ascending("message"),
        role: "assistant",
        sessionID: session.id,
        agent: "build",
        mode: "build",
        modelID: "test",
        providerID: "test",
        path: { cwd: tmp.path, root: tmp.path },
        time: { created: Date.now() },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      })
      const resolve = spyOn(SessionPrompt, "resolvePromptParts").mockImplementation(async () => {
        controller.abort(new Error("parent stopped during resolution"))
        return [{ type: "text", text: "child task" }]
      })
      const prompt = spyOn(SessionPrompt, "prompt").mockRejectedValue(new Error("child must not start"))
      try {
        const task = await TaskTool.init()
        await expect(
          task.execute(
            { subagent_type: "general", description: "Test child", prompt: "child task" },
            {
              sessionID: session.id,
              messageID,
              agent: "build",
              cwd: tmp.path,
              messages: [],
              abort: controller.signal,
              ask: async () => {},
              metadata: () => {},
            },
          ),
        ).rejects.toThrow("parent stopped during resolution")
        expect(prompt).not.toHaveBeenCalled()
      } finally {
        resolve.mockRestore()
        prompt.mockRestore()
        await Session.remove(session.id)
      }
    },
  })
})

test("prompt admission rechecks cancellation after waiting for its request lock", async () => {
  await using tmp = await tmpdir({ config: { model: "test/test" } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")
      const controller = new AbortController()
      const lock = await SessionRequest.lock(messageID)
      const lockStarted = Promise.withResolvers<void>()
      const originalLock = SessionRequest.lock
      const lockSpy = spyOn(SessionRequest, "lock").mockImplementation(async (id) => {
        lockStarted.resolve()
        return originalLock(id)
      })
      const result = SessionPrompt.prompt(
        { sessionID: session.id, messageID, noReply: true, parts: [{ type: "text", text: "cancelled child" }] },
        controller.signal,
      )
      const outcome = result.catch((error: unknown) => error)
      await lockStarted.promise
      controller.abort(new Error("stopped before admission"))
      lock[Symbol.dispose]()
      expect(await outcome).toMatchObject({ message: "stopped before admission" })
      lockSpy.mockRestore()
      expect(RunLease.current(session.id)).toBeUndefined()
      expect(await Session.messages({ sessionID: session.id })).toEqual([])
      await Session.remove(session.id)
    },
  })
})
