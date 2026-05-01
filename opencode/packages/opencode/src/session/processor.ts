import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"
import type { RuntimeTiming } from "./timing"
import { RuntimeControllerEvents } from "@/runtime/controller/events"
import { RuntimeMetricsEvents } from "@/runtime/metrics/events"

export namespace SessionProcessor {
  const DOOM_LOOP_THRESHOLD = 3
  const DOOM_LOOP_FORCE_ASK_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  // Session-level doom loop counter (persists across processor instances)
  const sessionDoomLoopCounts: Map<string, number> = new Map()

  function assistantErrorMessage(error: MessageV2.Assistant["error"] | undefined) {
    if (!error) return undefined
    const directMessage = "message" in error ? error.message : undefined
    if (typeof directMessage === "string") return directMessage
    const data = "data" in error ? error.data : undefined
    if (data && typeof data === "object" && "message" in data && typeof data.message === "string") {
      return data.message
    }
    return undefined
  }

  export function getDoomLoopCount(sessionID: string): number {
    return sessionDoomLoopCounts.get(sessionID) || 0
  }

  export function incrementDoomLoopCount(sessionID: string): number {
    const count = getDoomLoopCount(sessionID) + 1
    sessionDoomLoopCounts.set(sessionID, count)
    return count
  }

  export function resetDoomLoopCount(sessionID: string): void {
    sessionDoomLoopCounts.delete(sessionID)
  }

  // Random hints to help LLM break out of doom loops
  const DOOM_LOOP_HINTS = [
    "You've tried this approach multiple times without success. Consider a completely different strategy.",
    "The same tool call has been repeated. Try analyzing the problem from a different angle.",
    "This approach isn't working. What alternative methods could solve this problem?",
    "Step back and reconsider: is there a simpler or different way to achieve this goal?",
    "The repeated attempts suggest the current approach has limitations. What other options exist?",
    "You seem to be stuck in a loop. Try breaking out by using a completely different tool or approach.",
    "Multiple identical attempts have failed. Consider whether the task requirements need clarification from the user.",
    "The same action keeps failing. Perhaps the underlying assumption is wrong - what else could you try?",
  ]

  function getRandomHint(): string {
    return DOOM_LOOP_HINTS[Math.floor(Math.random() * DOOM_LOOP_HINTS.length)]
  }

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    const toolcalls: Record<string, MessageV2.ToolPart> = {}
    let snapshot: string | undefined
    let blocked = false
    let attempt = 0
    let needsCompaction = false
    let firstResponseAt: number | undefined

    const markFirstResponse = () => {
      firstResponseAt ??= Date.now()
    }

    const turnSnapshotId = () => RuntimeControllerEvents.turnSnapshotIdFor(input.sessionID)

    const publishTurnCompleted = async () => {
      const completedAt = input.assistantMessage.time.completed ?? Date.now()
      await Bus.publish(RuntimeControllerEvents.TurnCompleted, {
        sessionID: input.sessionID,
        turnSnapshotId: turnSnapshotId(),
        agent: input.assistantMessage.agent,
        providerID: input.model.providerID,
        modelID: input.model.id,
        finishReason: input.assistantMessage.finish,
        tokens: input.assistantMessage.tokens,
        costUsd: input.assistantMessage.cost,
        firstTokenLatencyMs: firstResponseAt
          ? Math.max(0, firstResponseAt - input.assistantMessage.time.created)
          : undefined,
        durationMs: Math.max(0, completedAt - input.assistantMessage.time.created),
        completedAt,
      })
    }

    const publishTurnFailed = async () => {
      const failedAt = input.assistantMessage.time.completed ?? Date.now()
      const error = input.assistantMessage.error
      await Bus.publish(RuntimeControllerEvents.TurnFailed, {
        sessionID: input.sessionID,
        turnSnapshotId: turnSnapshotId(),
        agent: input.assistantMessage.agent,
        providerID: input.model.providerID,
        modelID: input.model.id,
        errorType: error?.name ?? RuntimeMetricsEvents.normalizeErrorType(error),
        errorMessage: assistantErrorMessage(error),
        durationMs: Math.max(0, failedAt - input.assistantMessage.time.created),
        failedAt,
      })
    }

    const publishToolStarted = async (part: MessageV2.ToolPart) => {
      if (part.state.status !== "running") return
      await Bus.publish(RuntimeControllerEvents.ToolStarted, {
        sessionID: part.sessionID,
        turnSnapshotId: turnSnapshotId(),
        messageID: part.messageID,
        partID: part.id,
        tool: part.tool,
        toolCallId: part.callID,
        startedAt: part.state.time.start,
        input: part.state.input,
      })
    }

    const publishToolCompleted = async (part: MessageV2.ToolPart) => {
      if (part.state.status !== "completed") return
      await Bus.publish(RuntimeControllerEvents.ToolCompleted, {
        sessionID: part.sessionID,
        turnSnapshotId: turnSnapshotId(),
        messageID: part.messageID,
        partID: part.id,
        tool: part.tool,
        toolCallId: part.callID,
        startedAt: part.state.time.start,
        finishedAt: part.state.time.end,
        durationMs: Math.max(0, part.state.time.end - part.state.time.start),
        title: part.state.title,
        attachmentCount: part.state.attachments?.length,
      })
    }

    const publishToolFailed = async (part: MessageV2.ToolPart, error?: unknown) => {
      if (part.state.status !== "error") return
      await Bus.publish(RuntimeControllerEvents.ToolFailed, {
        sessionID: part.sessionID,
        turnSnapshotId: turnSnapshotId(),
        messageID: part.messageID,
        partID: part.id,
        tool: part.tool,
        toolCallId: part.callID,
        startedAt: part.state.time.start,
        finishedAt: part.state.time.end,
        durationMs: Math.max(0, part.state.time.end - part.state.time.start),
        errorType: RuntimeMetricsEvents.normalizeErrorType(error ?? part.state.error),
        errorMessage: part.state.error,
      })
    }

    const result = {
      get message() {
        return input.assistantMessage
      },
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },
      async process(streamInput: LLM.StreamInput, options?: { timing?: RuntimeTiming.Trace }) {
        log.info("process")
        const timing = options?.timing
        timing?.mark("processor.process.started")
        needsCompaction = false
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}
            timing?.mark("llm.stream.call.started", { attempt })
            const stream = await LLM.stream(streamInput)
            timing?.mark("llm.stream.call.completed", { attempt })

            for await (const value of stream.fullStream) {
              input.abort.throwIfAborted()
              switch (value.type) {
                case "start":
                  timing?.mark("llm.stream.first_event", { attempt })
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  reasoningMap[value.id] = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "reasoning-delta":
                  markFirstResponse()
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    if (part.text) await Session.updatePart({ part, delta: value.text })
                  }
                  break

                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()

                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                case "tool-input-delta":
                  break

                case "tool-input-end":
                  break

                case "tool-call": {
                  markFirstResponse()
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart
                    await publishToolStarted(toolcalls[value.toolCallId]!)

                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      const doomLoopCount = incrementDoomLoopCount(input.sessionID)
                      const config = await Config.get()
                      const agent = await Agent.mustGet(input.assistantMessage.agent)

                      // In autonomous mode with allowDoomLoop, handle doom loops progressively
                      if (config.autonomous?.enabled !== false && config.autonomous?.allowDoomLoop !== false) {
                        if (doomLoopCount >= DOOM_LOOP_FORCE_ASK_THRESHOLD) {
                          // After 3 doom loops, force the LLM to ask the user
                          log.info("doom_loop forcing question after multiple attempts", {
                            tool: value.toolName,
                            count: doomLoopCount,
                          })
                          // Inject a system hint that forces asking the user
                          await Session.updatePart({
                            id: Identifier.ascending("part"),
                            messageID: input.assistantMessage.id,
                            sessionID: input.assistantMessage.sessionID,
                            type: "text",
                            text: `<system-hint priority="critical">
IMPORTANT: You have attempted the same approach ${doomLoopCount} times without success.
You MUST now use the question tool to ask the user for guidance.
Do not attempt to solve this on your own - ask the user what they want you to do differently.
Possible questions to ask:
- What alternative approach should I try?
- Is there something I'm missing about this task?
- Should I skip this step and move on?
</system-hint>`,
                            time: { start: Date.now(), end: Date.now() },
                          })
                        } else {
                          // Before 3 doom loops, inject a random hint to help LLM adjust
                          const hint = getRandomHint()
                          log.info("doom_loop injecting hint in autonomous mode", {
                            tool: value.toolName,
                            count: doomLoopCount,
                            hint,
                          })
                          await Session.updatePart({
                            id: Identifier.ascending("part"),
                            messageID: input.assistantMessage.id,
                            sessionID: input.assistantMessage.sessionID,
                            type: "text",
                            text: `<system-hint>${hint}</system-hint>`,
                            time: { start: Date.now(), end: Date.now() },
                          })
                        }
                      } else {
                        await PermissionNext.ask({
                          permission: "doom_loop",
                          patterns: [value.toolName],
                          sessionID: input.assistantMessage.sessionID,
                          metadata: {
                            tool: value.toolName,
                            input: value.input,
                          },
                          always: [value.toolName],
                          ruleset: agent.permission,
                        })
                      }
                    }
                  }
                  break
                }
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const updated = (await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })) as MessageV2.ToolPart
                    await publishToolCompleted(updated)

                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    const config = await Config.get()
                    const isAutonomous = config.autonomous?.enabled !== false

                    const updated = (await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })) as MessageV2.ToolPart
                    await publishToolFailed(updated, value.error)

                    // In autonomous mode, only block on explicit user rejection (RejectedError)
                    // CorrectedError and other errors should allow the LLM to try alternatives
                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      // In autonomous mode, only block if askAfterRetries is false
                      // Otherwise, let the LLM try alternative approaches
                      if (isAutonomous && config.autonomous?.askAfterRetries !== false) {
                        log.info("tool error in autonomous mode - allowing retry", {
                          tool: match.tool,
                          error: (value.error as any).toString(),
                        })
                        // Don't set blocked - let the LLM try alternatives
                      } else {
                        blocked = shouldBreak
                      }
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }
                case "error":
                  throw value.error

                case "start-step":
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                case "finish-step":
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  break

                case "text-delta":
                  markFirstResponse()
                  if (currentText) {
                    currentText.text += value.text
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    if (currentText.text)
                      await Session.updatePart({
                        part: currentText,
                        delta: value.text,
                      })
                  }
                  break

                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                case "finish":
                  break

                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              if (needsCompaction) break
            }
          } catch (e: any) {
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (SessionCompaction.isContextLengthError(error)) {
              log.info("context length error, triggering compaction", { sessionID: input.sessionID })
              needsCompaction = true
              break
            }
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue
            }
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
          }
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              const start = "time" in part.state ? part.state.time.start : Date.now()
              const updated = (await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start,
                    end: Date.now(),
                  },
                },
              })) as MessageV2.ToolPart
              await publishToolFailed(updated, new Error("Tool execution aborted"))
            }
          }
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)
          if (needsCompaction) return "compact"
          if (input.assistantMessage.error) {
            await publishTurnFailed()
            return "stop"
          }
          await publishTurnCompleted()
          if (blocked) return "stop"
          return "continue"
        }
      },
    }
    return result
  }
}
