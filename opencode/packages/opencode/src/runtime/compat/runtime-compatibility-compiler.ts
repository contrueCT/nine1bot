import { ulid } from "ulid"
import type { SessionPrompt } from "@/session/prompt"
import type { AgentRunSpec, TurnRuntimeSnapshot } from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeCompatibilityCompiler {
  export type LegacyPromptBridge = Pick<SessionPrompt.PromptInput, "messageID" | "tools" | "system" | "variant">

  export function compileTurnSnapshot(spec: AgentRunSpec, legacy?: LegacyPromptBridge): TurnRuntimeSnapshot {
    const turnSnapshotId = spec.runtime.turnSnapshotId ?? ulid()
    return {
      id: turnSnapshotId,
      createdAt: Date.now(),
      session: spec.session,
      entry: spec.entry,
      input: spec.input,
      model: spec.model,
      agent: spec.agent,
      context: spec.context,
      resources: spec.resources,
      permissions: spec.permissions,
      orchestration: spec.orchestration,
      runtime: {
        ...spec.runtime,
        turnSnapshotId,
      },
      audit: spec.audit
        ? {
            ...spec.audit,
            turnSnapshotId,
          }
        : undefined,
      legacy,
    }
  }

  export function compilePrompt(snapshot: TurnRuntimeSnapshot): SessionPrompt.PromptInput {
    if (!snapshot.session.id) throw new Error("Cannot compile legacy prompt without session id")
    return {
      sessionID: snapshot.session.id,
      messageID: snapshot.legacy?.messageID,
      model: {
        providerID: snapshot.model.providerID,
        modelID: snapshot.model.modelID,
      },
      agent: snapshot.agent.name,
      noReply: snapshot.runtime.noReply,
      tools: compileTools(snapshot),
      system: snapshot.legacy?.system,
      variant: snapshot.legacy?.variant,
      parts: snapshot.input.parts as SessionPrompt.PromptInput["parts"],
    }
  }

  export function compileTools(snapshot: TurnRuntimeSnapshot): SessionPrompt.PromptInput["tools"] {
    return snapshot.legacy?.tools
  }
}
