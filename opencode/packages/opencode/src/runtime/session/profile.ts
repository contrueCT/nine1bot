import z from "zod"
import { ulid } from "ulid"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import {
  AGENT_RUNTIME_PROTOCOL_VERSION,
  type ModelSpec,
  type SessionPermissionGrant,
  type SessionProfileSnapshot,
} from "@/runtime/protocol/agent-run-spec"

export namespace SessionRuntimeProfile {
  export const CurrentModel = z.object({
    providerID: z.string(),
    modelID: z.string(),
    source: z.enum(["profile-snapshot", "session-choice"]),
    updatedAt: z.number().optional(),
  })
  export type CurrentModel = z.infer<typeof CurrentModel>

  export const Summary = z.object({
    protocolVersion: z.literal(AGENT_RUNTIME_PROTOCOL_VERSION),
    profileSnapshotId: z.string(),
    profileSource: z.enum(["new-session", "legacy-resumed"]).optional(),
    agent: z.string(),
    currentModel: CurrentModel.optional(),
  })
  export type Summary = z.infer<typeof Summary>

  export type SessionRef = {
    id: string
    projectID?: string
    runtime?: Summary
  }

  export type Rule = {
    permission: string
    pattern: string
    action: "allow" | "deny" | "ask"
  }

  export function storageKey(projectID: string, sessionID: string) {
    return ["runtime_profile", projectID, sessionID]
  }

  export async function read(session: SessionRef) {
    const projectID = session.projectID ?? Instance.project.id
    return Storage.read<SessionProfileSnapshot>(storageKey(projectID, session.id)).catch((error) => {
      if (Storage.NotFoundError.isInstance(error) || Storage.CorruptedError.isInstance(error)) return undefined
      throw error
    })
  }

  export async function write(session: SessionRef, snapshot: SessionProfileSnapshot) {
    const projectID = session.projectID ?? Instance.project.id
    await Storage.write(storageKey(projectID, session.id), snapshot)
  }

  export async function remove(session: SessionRef) {
    const projectID = session.projectID ?? Instance.project.id
    await Storage.remove(storageKey(projectID, session.id))
  }

  export async function initialize(
    session: SessionRef,
    snapshot: SessionProfileSnapshot,
    options?: { currentModel?: CurrentModel },
  ) {
    const stored: SessionProfileSnapshot = {
      ...snapshot,
      sessionId: session.id,
    }
    await write(session, stored)
    return summarize(stored, options?.currentModel)
  }

  export async function cloneForFork(parent: SessionRef, child: SessionRef) {
    const snapshot = await read(parent)
    if (!snapshot) return undefined
    const forked = structuredClone(snapshot) as SessionProfileSnapshot
    forked.id = ulid()
    forked.sessionId = child.id
    forked.createdAt = Date.now()
    forked.sourceTemplateIds = [...forked.sourceTemplateIds, "session-fork"]
    return {
      snapshot: forked,
      summary: summarize(forked, parent.runtime?.currentModel),
    }
  }

  export function summarize(snapshot: SessionProfileSnapshot, currentModel?: CurrentModel): Summary {
    return {
      protocolVersion: AGENT_RUNTIME_PROTOCOL_VERSION,
      profileSnapshotId: snapshot.id,
      profileSource: snapshot.source,
      agent: snapshot.agent.name,
      currentModel: currentModel ?? {
        providerID: snapshot.defaultModel.providerID,
        modelID: snapshot.defaultModel.modelID,
        source: "profile-snapshot",
      },
    }
  }

  export function currentModel(model: Pick<ModelSpec, "providerID" | "modelID">, source: CurrentModel["source"]) {
    return {
      providerID: model.providerID,
      modelID: model.modelID,
      source,
      updatedAt: Date.now(),
    } satisfies CurrentModel
  }

  export function withCurrentModel(summary: Summary, model: CurrentModel): Summary {
    return {
      ...summary,
      currentModel: model,
    }
  }

  export function rulesetFromGrants(grants?: SessionPermissionGrant[]): Rule[] {
    return (grants ?? []).flatMap((grant) =>
      grant.patterns.map((pattern) => ({
        permission: grant.permission,
        pattern,
        action: "allow" as const,
      })),
    )
  }

  export function rulesetFromSnapshot(snapshot?: SessionProfileSnapshot): Rule[] {
    return rulesetFromGrants(snapshot?.sessionPermissionGrants)
  }

  export async function grantRuleset(sessionID: string) {
    const snapshot = await read({ id: sessionID })
    return rulesetFromSnapshot(snapshot)
  }

  export async function addPermissionGrant(input: {
    sessionID: string
    permission: string
    patterns: string[]
    metadata?: Record<string, unknown>
  }) {
    const key = storageKey(Instance.project.id, input.sessionID)
    const grant: SessionPermissionGrant = {
      id: ulid(),
      permission: input.permission,
      patterns: input.patterns,
      metadata: input.metadata,
      grantedAt: Date.now(),
      source: "permission-ask",
    }
    await Storage.update<SessionProfileSnapshot>(key, (draft) => {
      draft.sessionPermissionGrants ??= []
      draft.sessionPermissionGrants.push(grant)
      draft.permissions.sessionGrants = draft.sessionPermissionGrants
    }).catch((error) => {
      if (Storage.NotFoundError.isInstance(error) || Storage.CorruptedError.isInstance(error)) return undefined
      throw error
    })
    return grant
  }
}
