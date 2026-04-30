import { Bus } from "@/bus"
import type { PermissionNext } from "@/permission/next"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Instance } from "@/project/instance"
import type { RuntimeControllerProtocol } from "@/runtime/controller/protocol"
import {
  answerInteraction,
  createControllerSession,
  sendControllerMessage,
} from "./nine1bot-agent"

export type AutomatedRunStatus = "succeeded" | "failed"

export type AutomatedInteractionPolicy = {
  permission: "deny" | "allow-session"
  question: "deny"
  permissionAllowMessage: string
  permissionDenyMessage: string
  questionDenyMessage: string
}

export type AutomatedControllerResponse = {
  accepted: boolean
  sessionID: string
  turnSnapshotId?: string
  status: number
  response: RuntimeControllerProtocol.MessageSendResponse
}

export type AutomatedControllerInput = {
  title: string
  directory: string
  permission?: PermissionNext.Ruleset
  sessionChoice?: RuntimeControllerProtocol.SessionChoice
  entry: RuntimeControllerProtocol.Entry
  clientCapabilities: RuntimeControllerProtocol.ClientCapabilities
  parts: RuntimeControllerProtocol.MessageSendRequest["parts"]
  interactionPolicy: AutomatedInteractionPolicy
  timeoutMs: number
  timeoutMessage?: string
  onControllerResponse?: (response: AutomatedControllerResponse) => Promise<void>
  onFinished?: (result: { status: AutomatedRunStatus; error?: string }) => Promise<void>
  onInteraction?: (interaction: {
    kind: "permission" | "question"
    requestID: string
    action: "allow-session" | "deny"
    error?: string
  }) => Promise<void>
}

export type AutomatedControllerRunner = typeof runAutomatedControllerSession

export async function runAutomatedControllerSession(input: AutomatedControllerInput): Promise<AutomatedControllerResponse> {
  return Instance.provide({
    directory: input.directory,
    init: InstanceBootstrap,
    async fn() {
      const sessionResponse = await createControllerSession({
        directory: input.directory,
        title: input.title,
        permission: input.permission,
        sessionChoice: input.sessionChoice,
        entry: input.entry,
        clientCapabilities: input.clientCapabilities,
      })
      const messageResponse = await sendControllerMessage(sessionResponse.sessionId, {
        parts: input.parts,
        entry: input.entry,
        clientCapabilities: input.clientCapabilities,
      })
      const response = {
        accepted: messageResponse.response.accepted,
        sessionID: sessionResponse.sessionId,
        turnSnapshotId: messageResponse.response.turnSnapshotId,
        status: messageResponse.status,
        response: messageResponse.response,
      } satisfies AutomatedControllerResponse

      await input.onControllerResponse?.(response)

      if (!response.accepted) {
        await input.onFinished?.({
          status: "failed",
          error: "controller_message_not_accepted",
        })
        return response
      }

      startAutomatedRunMonitor({
        sessionID: sessionResponse.sessionId,
        timeoutMs: input.timeoutMs,
        timeoutMessage: input.timeoutMessage,
        interactionPolicy: input.interactionPolicy,
        onFinished: input.onFinished,
        onInteraction: input.onInteraction,
      })

      return response
    },
  })
}

export function startAutomatedRunMonitor(input: {
  sessionID: string
  timeoutMs: number
  timeoutMessage?: string
  interactionPolicy: AutomatedInteractionPolicy
  onFinished?: (result: { status: AutomatedRunStatus; error?: string }) => Promise<void>
  onInteraction?: AutomatedControllerInput["onInteraction"]
}) {
  let finished = false
  let unsubscribe: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined

  const finish = async (status: AutomatedRunStatus, error?: string) => {
    if (finished) return
    finished = true
    if (timeout) clearTimeout(timeout)
    unsubscribe?.()
    await input.onFinished?.({ status, error }).catch(() => undefined)
  }

  unsubscribe = Bus.subscribeAll(async (event) => {
    const properties = event.properties as Record<string, any> | undefined
    const eventSessionID = properties?.sessionID || properties?.info?.id
    if (eventSessionID !== input.sessionID) return

    if (event.type === "permission.asked") {
      const allow = input.interactionPolicy.permission === "allow-session"
      const action = allow ? "allow-session" : "deny"
      const error = allow
        ? undefined
        : `Permission request denied automatically: ${String(properties?.permission || "unknown")}`
      await answerInteraction(String(properties?.id || ""), {
        kind: "permission",
        answer: action,
        message: allow
          ? input.interactionPolicy.permissionAllowMessage
          : input.interactionPolicy.permissionDenyMessage,
      }).catch(() => undefined)
      await input.onInteraction?.({
        kind: "permission",
        requestID: String(properties?.id || ""),
        action,
        error,
      }).catch(() => undefined)
      return
    }

    if (event.type === "question.asked") {
      await answerInteraction(String(properties?.id || ""), {
        kind: "question",
        answer: "deny",
      }).catch(() => undefined)
      await input.onInteraction?.({
        kind: "question",
        requestID: String(properties?.id || ""),
        action: "deny",
        error: input.interactionPolicy.questionDenyMessage,
      }).catch(() => undefined)
      return
    }

    if (event.type === "session.idle") {
      await finish("succeeded")
      return
    }

    if (event.type === "session.error") {
      await finish("failed", formatSessionError(properties?.error))
    }
  })

  timeout = setTimeout(() => {
    finish("failed", input.timeoutMessage ?? "Automated run monitor timed out.").catch(() => undefined)
  }, input.timeoutMs)
  timeout.unref?.()

  return {
    stop() {
      if (timeout) clearTimeout(timeout)
      unsubscribe?.()
      finished = true
    },
  }
}

function formatSessionError(error: unknown) {
  if (!error) return "Session failed"
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  return JSON.stringify(error)
}
