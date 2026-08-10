import { describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { RuntimeControllerProtocol } from "../../src/runtime/controller/protocol"
import { ControllerAgentRunCompiler } from "../../src/runtime/controller/agent-run-compiler"
import { RuntimeContextPipeline } from "../../src/runtime/context/pipeline"
import { SessionRuntimeProfile } from "../../src/runtime/session/profile"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { RuntimePromptBridgeCompiler } from "../../src/runtime/bridge/prompt-compiler"
import type { TurnRuntimeSnapshot } from "../../src/runtime/protocol/agent-run-spec"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

function messageBody(input: Partial<RuntimeControllerProtocol.MessageSendRequest> = {}) {
  return {
    parts: [
      {
        type: "text",
        text: "hello controller runtime",
      },
    ],
    entry: {
      source: "web",
      mode: "web-chat",
      templateIds: ["default-user-template", "web-chat"],
    },
    ...input,
  } satisfies RuntimeControllerProtocol.MessageSendRequest
}

describe("controller agent run compiler", () => {
  test("compiles controller messages without legacy adapter audit", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        if (!session.runtime?.profileSnapshotId || !session.runtime.currentModel) {
          throw new Error("Expected session runtime summary")
        }
        const turnBlock = RuntimeContextPipeline.textBlock({
          id: "turn:test",
          layer: "turn",
          source: "test.turn",
          content: "turn scoped context",
          lifecycle: "turn",
        })

        const spec = await ControllerAgentRunCompiler.compileSpec({
          session,
          turnSnapshotId: "turn_controller_test",
          body: messageBody({
            system: "controller scoped system",
            context: {
              blocks: [turnBlock],
            },
            clientCapabilities: {
              debug: true,
              pageContext: true,
              resourceFailures: true,
            },
          }),
        })

        expect(spec.runtime.turnSnapshotId).toBe("turn_controller_test")
        expect(spec.session.profileSnapshot?.id).toBe(session.runtime.profileSnapshotId)
        expect(spec.agent.name).toBe(session.runtime.agent)
        expect(spec.model.source).toBe(session.runtime.currentModel.source)
        expect(spec.audit?.legacy).toBeUndefined()
        expect(spec.context.blocks.map((block) => block.source)).toContain("test.turn")
        expect(spec.context.blocks.map((block) => block.source)).toContain("controller-message.system")
        expect(spec.capabilities?.client?.debugPanel).toBe(true)
        expect(spec.capabilities?.client?.pageContext).toBe(true)
        expect(spec.capabilities?.client?.resourceFailureEvents).toBe(true)

        await Session.remove(session.id)
      },
    })
  })

  test("uses explicit controller model as a session choice", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const spec = await ControllerAgentRunCompiler.compileSpec({
          session,
          turnSnapshotId: "turn_model_choice",
          body: messageBody({
            model: {
              providerID: "test-provider",
              modelID: "test-model",
            },
          }),
        })

        expect(spec.model).toEqual({
          providerID: "test-provider",
          modelID: "test-model",
          source: "session-choice",
        })
        expect(spec.audit?.modelSource).toBe("session-choice")

        await Session.remove(session.id)
      },
    })
  })

  test("audits registered tool ids frozen in the session profile", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        const profile = await SessionRuntimeProfile.read(session)
        if (!profile) throw new Error("Expected session runtime profile")
        await SessionRuntimeProfile.write(session, {
          ...profile,
          resources: {
            ...profile.resources,
            registeredTools: {
              tools: ["demo_lookup"],
              lifecycle: "session",
              mergeMode: "additive-only",
            },
          },
        })

        const spec = await ControllerAgentRunCompiler.compileSpec({
          session,
          turnSnapshotId: "turn_registered_tool_audit",
          body: messageBody(),
        })

        expect(spec.audit?.resources.registeredTools).toEqual(["demo_lookup"])

        await Session.remove(session.id)
      },
    })
  })

  test("audits but ignores per-turn controller agent overrides", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        if (!session.runtime?.agent) {
          throw new Error("Expected session runtime agent")
        }

        const spec = await ControllerAgentRunCompiler.compileSpec({
          session,
          turnSnapshotId: "turn_agent_override",
          body: messageBody({
            agent: "some-other-agent",
          }),
        })

        expect(spec.agent.name).toBe(session.runtime.agent)
        expect(spec.audit?.agentOverrideIgnored).toEqual({
          requested: "some-other-agent",
          profile: session.runtime.agent,
        })

        await Session.remove(session.id)
      },
    })
  })

  test("wraps controller system text as runtime context instead of direct prompt system", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})

        const prompt = await ControllerAgentRunCompiler.compilePrompt({
          session,
          turnSnapshotId: "turn_system_context",
          body: messageBody({
            system: "controller system should be a context block",
          }),
        })

        expect(prompt.system).toBeUndefined()
        expect(prompt.context?.blocks?.some((block) => block.source === "controller-message.system")).toBe(true)
        expect(prompt.runtimeProfileSnapshot?.id).toBe(session.runtime?.profileSnapshotId)
        expect(prompt.runtimeTurnSnapshotId).toBe("turn_system_context")

        await Session.remove(session.id)
      },
    })
  })

  test("propagates only explicit turn runtime timeouts to the prompt", async () => {
    const snapshot = (timeoutMs?: number) =>
      ({
        id: "turn_timeout_test",
        session: { id: "ses_timeout_test" },
        input: { parts: [] },
        model: { providerID: "test-provider", modelID: "test-model" },
        agent: { name: "build" },
        runtime: { timeoutMs },
      }) as unknown as TurnRuntimeSnapshot

    const bounded = RuntimePromptBridgeCompiler.compilePrompt(snapshot(12_345))
    const unbounded = RuntimePromptBridgeCompiler.compilePrompt(snapshot())

    expect(bounded.runtimeTimeoutMs).toBe(12_345)
    expect(unbounded.runtimeTimeoutMs).toBeUndefined()
  })

  test("compiles a transient legacy-resumed profile without persisting it before prompt acceptance", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const session = await Session.create({})
        await SessionRuntimeProfile.remove(session)
        const legacySession = await Session.update(
          session.id,
          (draft) => {
            draft.runtime = undefined
          },
          { touch: false },
        )

        const spec = await ControllerAgentRunCompiler.compileSpec({
          session: legacySession,
          turnSnapshotId: "turn_legacy_resumed_compile",
          body: messageBody(),
        })

        expect(spec.session.profileSnapshot?.source).toBe("legacy-resumed")
        expect(await SessionRuntimeProfile.read(legacySession)).toBeUndefined()

        await Session.remove(session.id)
      },
    })
  })
})
