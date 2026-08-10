import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { RuntimeToolCatalog } from "@/runtime/tool/catalog"
import { sanitizePlatformToolDiagnostic } from "@/runtime/tool/sanitize"
import type {
  McpResourceSpec,
  ResourceAvailability,
  ResourceSpec,
  SessionProfileSnapshot,
  SkillResourceSpec,
} from "@/runtime/protocol/agent-run-spec"

export namespace RuntimeResourceResolver {
  const log = Log.create({ service: "runtime.resource-resolver" })
  const RESOURCE_TEMPLATE_ID = "resource-resolver"
  const emittedToolFailures = Instance.state(() => new Map<string, string>())
  const lastPublishedResolution = Instance.state(() => new Map<string, string>())

  export const Failed = BusEvent.define(
    "runtime.resource.failed",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string().optional(),
      resourceType: z.enum(["mcp", "skill", "tool"]),
      resourceID: z.string(),
      ownerID: z.string().optional(),
      generation: z.number().int().positive().optional(),
      code: z.string().optional(),
      status: z.enum(["degraded", "unavailable", "auth-required"]),
      stage: z.enum(["resolve", "connect", "auth", "load", "execute"]),
      reason: z.string().optional(),
      message: z.string(),
      recoverable: z.boolean(),
      action: z
        .object({
          type: z.enum(["open-settings", "start-auth", "retry", "continue-in-web"]),
          label: z.string(),
        })
        .optional(),
    }),
  )

  export const ResolvedEvent = BusEvent.define(
    "runtime.resources.resolved",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string().optional(),
      declared: z.object({
        mcp: z.array(z.string()),
        skills: z.array(z.string()),
        registeredTools: z.array(z.string()),
      }),
      resolved: z.object({
        mcp: z.array(z.string()),
        skills: z.array(z.string()),
        registeredTools: z.array(z.string()),
      }),
      unavailable: z.array(
        z.object({
          type: z.enum(["mcp", "skill", "tool"]),
          id: z.string(),
          reason: z.string().optional(),
          error: z.string().optional(),
        }),
      ),
      failures: z.number(),
    }),
  )

  export type Resolved = {
    builtinTools: ResourceSpec["builtinTools"]
    registeredTools: {
      declaredTools: string[]
      availableTools: RuntimeToolCatalog.ResolvedReference[]
      availability: Record<string, ResourceAvailability>
    }
    mcp: {
      declaredServers: string[]
      availableServers: string[]
      availability: Record<string, ResourceAvailability>
    }
    skills: {
      declaredSkills: string[]
      availableSkills: SkillInfo[]
      availability: Record<string, ResourceAvailability>
    }
    failures: ResourceFailure[]
    audit: {
      declared: {
        mcp: string[]
        skills: string[]
        registeredTools: string[]
      }
      resolved: {
        mcp: string[]
        skills: string[]
        registeredTools: string[]
      }
      unavailable: Array<{ type: "mcp" | "skill" | "tool"; id: string; reason?: string; error?: string }>
    }
  }

  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  export type ResourceFailure = Omit<z.infer<typeof Failed.properties>, "sessionID" | "turnSnapshotId">
  type SkillInfo = {
    name: string
    description: string
    location: string
  }

  function isMcpConfigured(entry: McpEntry | undefined): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  function uniqueSorted(values: string[]) {
    return [...new Set(values)].sort((a, b) => a.localeCompare(b))
  }

  async function listSkills(options?: { includeDeclaredOnly?: boolean }): Promise<SkillInfo[]> {
    const { Skill } = await import("@/skill")
    return Skill.all(options)
  }

  export function resourceTemplateId() {
    return RESOURCE_TEMPLATE_ID
  }

  export function hasResourceSnapshot(profile: SessionProfileSnapshot) {
    return profile.sourceTemplateIds.includes(RESOURCE_TEMPLATE_ID)
  }

  export function emptyResources(): ResourceSpec {
    return {
      builtinTools: {},
      registeredTools: {
        tools: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      mcp: {
        servers: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      skills: {
        skills: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
    }
  }

  export async function compileProfileResources(): Promise<ResourceSpec> {
    const cfg = await Config.get()
    const mcpServers = uniqueSorted(
      Object.entries(cfg.mcp ?? {})
        .filter(([, entry]) => isMcpConfigured(entry) && entry.enabled !== false)
        .map(([name]) => name),
    )
    const skills = uniqueSorted((await listSkills()).map((skill) => skill.name))

    return {
      builtinTools: {},
      registeredTools: {
        tools: [],
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      mcp: {
        servers: mcpServers,
        lifecycle: "session",
        mergeMode: "additive-only",
      },
      skills: {
        skills,
        lifecycle: "session",
        mergeMode: "additive-only",
      },
    }
  }

  export async function withProfileResources(profile: SessionProfileSnapshot): Promise<SessionProfileSnapshot> {
    if (hasResourceSnapshot(profile)) return profile
    return {
      ...profile,
      sourceTemplateIds: [...profile.sourceTemplateIds, RESOURCE_TEMPLATE_ID],
      resources: await compileProfileResources(),
    }
  }

  export async function resolve(input: {
    sessionID: string
    turnSnapshotId?: string
    profile?: SessionProfileSnapshot
    projectID?: string
    directory?: string
    agent?: string
    templateIds?: string[]
    occupiedToolIDs?: ReadonlySet<string>
    isToolExposureDenied?: (toolID: string) => boolean | Promise<boolean>
    toolAvailabilityBudgetMs?: number
    emitFailures?: boolean
    emitResolved?: boolean
  }): Promise<Resolved> {
    const resources = input.profile?.resources ?? (await compileProfileResources())
    const [mcp, skills, registeredTools] = await Promise.all([
      resolveMcp(resources.mcp),
      resolveSkills(resources.skills),
      resolveRegisteredTools(input, resources),
    ])
    const failures = [...mcp.failures, ...skills.failures, ...registeredTools.failures]

    const result: Resolved = {
      builtinTools: resources.builtinTools,
      registeredTools: {
        declaredTools: registeredTools.declared,
        availableTools: registeredTools.available,
        availability: registeredTools.availability,
      },
      mcp: {
        declaredServers: mcp.declaredServers,
        availableServers: mcp.availableServers,
        availability: mcp.availability,
      },
      skills: {
        declaredSkills: skills.declaredSkills,
        availableSkills: skills.availableSkills,
        availability: skills.availability,
      },
      failures,
      audit: {
        declared: {
          mcp: mcp.declaredServers,
          skills: skills.declaredSkills,
          registeredTools: registeredTools.declared,
        },
        resolved: {
          mcp: mcp.availableServers,
          skills: skills.availableSkills.map((skill) => skill.name),
          registeredTools: registeredTools.available.map((tool) => tool.id),
        },
        unavailable: failures.map((failure) => ({
          type: failure.resourceType,
          id: failure.resourceID,
          reason: failure.reason,
          error: failure.message,
        })),
      },
    }

    const emitFailures = input.emitFailures !== false
    const emitResolved = input.emitResolved !== false
    if (emitFailures && emitResolved) {
      await publishResolution({
        sessionID: input.sessionID,
        turnSnapshotId: input.turnSnapshotId,
        resolved: result,
      })
    } else {
      if (emitFailures) {
        await publishFailures({
          sessionID: input.sessionID,
          turnSnapshotId: input.turnSnapshotId,
          resolved: result,
        })
      }
      if (emitResolved) {
        await publishResolvedEvent({
          sessionID: input.sessionID,
          turnSnapshotId: input.turnSnapshotId,
          resolved: result,
        })
      }
    }

    return result
  }

  export function applyToolConflicts(
    resolved: Resolved,
    occupiedToolIDs: ReadonlySet<string>,
  ): Resolved {
    const conflicts = resolved.registeredTools.availableTools
      .filter((reference) => occupiedToolIDs.has(reference.id))
      .map(toolConflictFailure)
    if (conflicts.length === 0) return resolved

    const conflictIDs = new Set(conflicts.map((failure) => failure.resourceID))
    const availableTools = resolved.registeredTools.availableTools.filter((reference) => !conflictIDs.has(reference.id))
    const availability = { ...resolved.registeredTools.availability }
    for (const failure of conflicts) {
      availability[failure.resourceID] = {
        declared: true,
        status: "unavailable",
        reason: "tool-conflict",
        checkedAt: Date.now(),
      }
    }
    const failures = [...resolved.failures, ...conflicts]
      .sort((left, right) => `${left.resourceType}:${left.resourceID}`.localeCompare(`${right.resourceType}:${right.resourceID}`))
    const unavailable = failures.map((failure) => ({
      type: failure.resourceType,
      id: failure.resourceID,
      reason: failure.reason,
      error: failure.message,
    }))

    return {
      ...resolved,
      registeredTools: {
        ...resolved.registeredTools,
        availableTools,
        availability,
      },
      failures,
      audit: {
        declared: {
          ...resolved.audit.declared,
          registeredTools: [...resolved.audit.declared.registeredTools],
        },
        resolved: {
          ...resolved.audit.resolved,
          registeredTools: availableTools.map((reference) => reference.id),
        },
        unavailable,
      },
    }
  }

  export async function publishResolution(input: {
    sessionID: string
    turnSnapshotId?: string
    resolved: Resolved
  }) {
    if (input.turnSnapshotId) {
      const published = lastPublishedResolution()
      if (published.get(input.sessionID) === input.turnSnapshotId) return false
      published.set(input.sessionID, input.turnSnapshotId)
    }
    await publishFailures(input)
    await publishResolvedEvent(input)
    return true
  }

  async function publishFailures(input: {
    sessionID: string
    turnSnapshotId?: string
    resolved: Resolved
  }) {
    const failedToolIDs = new Set(
      input.resolved.failures
        .filter((failure) => failure.resourceType === "tool")
        .map((failure) => failure.resourceID),
    )
    for (const toolID of input.resolved.registeredTools.declaredTools) {
      if (!failedToolIDs.has(toolID)) clearToolFailure(input.sessionID, toolID)
    }

    for (const failure of input.resolved.failures) {
      if (failure.resourceType === "tool") {
        await publishToolFailure({
          sessionID: input.sessionID,
          turnSnapshotId: input.turnSnapshotId,
          failure,
        })
        continue
      }
      await Bus.publish(Failed, {
        ...failure,
        sessionID: input.sessionID,
        turnSnapshotId: input.turnSnapshotId,
      }).catch((error) => {
        log.warn("failed to publish resource failure event", { error })
      })
    }
  }

  async function publishResolvedEvent(input: {
    sessionID: string
    turnSnapshotId?: string
    resolved: Resolved
  }) {
    await Bus.publish(ResolvedEvent, {
      sessionID: input.sessionID,
      turnSnapshotId: input.turnSnapshotId,
      declared: input.resolved.audit.declared,
      resolved: input.resolved.audit.resolved,
      unavailable: input.resolved.audit.unavailable,
      failures: input.resolved.failures.length,
    }).catch((error) => {
      log.warn("failed to publish resources resolved event", { error })
    })
  }

  function toolConflictFailure(
    reference: RuntimeToolCatalog.ResolvedReference,
  ): ResourceFailure {
    return {
      resourceType: "tool",
      resourceID: reference.id,
      ownerID: reference.ownerID,
      generation: reference.generation,
      code: "tool-conflict",
      status: "unavailable",
      stage: "resolve",
      reason: "tool-conflict",
      message: `Registered tool "${reference.id}" conflicts with an existing runtime tool.`,
      recoverable: false,
    }
  }

  export async function publishToolFailure(input: {
    sessionID: string
    turnSnapshotId?: string
    failure: ResourceFailure
  }) {
    if (input.failure.resourceType !== "tool") {
      throw new Error("publishToolFailure only accepts registered tool failures.")
    }
    const failure = sanitizeToolFailure(input.failure)
    const key = `${input.sessionID}:${failure.resourceID}`
    const signature = failureSignature(failure)
    const emitted = emittedToolFailures()
    const previous = emitted.get(key)
    if (previous === signature) return false
    emitted.set(key, signature)

    try {
      await Bus.publish(Failed, {
        ...failure,
        sessionID: input.sessionID,
        turnSnapshotId: input.turnSnapshotId,
      })
    } catch (error) {
      if (emitted.get(key) === signature) {
        if (previous === undefined) emitted.delete(key)
        else emitted.set(key, previous)
      }
      log.warn("failed to publish registered tool failure event", { error })
      return false
    }
    return true
  }

  export function clearToolFailure(sessionID: string, toolID: string) {
    return emittedToolFailures().delete(`${sessionID}:${toolID}`)
  }

  function failureSignature(failure: ResourceFailure) {
    return [
      failure.ownerID ?? "missing-owner",
      failure.generation ?? 0,
      failure.code ?? failure.reason ?? failure.status,
      failure.status,
    ].join(":")
  }

  function sanitizeToolFailure(failure: ResourceFailure): ResourceFailure {
    return {
      ...failure,
      reason: failure.reason ? sanitizePlatformToolDiagnostic(failure.reason) : undefined,
      message: sanitizePlatformToolDiagnostic(failure.message),
      action: failure.action
        ? {
            ...failure.action,
            label: sanitizePlatformToolDiagnostic(failure.action.label),
          }
        : undefined,
    }
  }

  async function resolveRegisteredTools(
    input: {
      sessionID: string
      profile?: SessionProfileSnapshot
      projectID?: string
      directory?: string
      agent?: string
      templateIds?: string[]
      occupiedToolIDs?: ReadonlySet<string>
      isToolExposureDenied?: (toolID: string) => boolean | Promise<boolean>
      toolAvailabilityBudgetMs?: number
    },
    resources: ResourceSpec,
  ) {
    const declared = uniqueSorted(resources.registeredTools?.tools ?? [])
    if (declared.length === 0) {
      return {
        declared,
        available: [] as RuntimeToolCatalog.ResolvedReference[],
        availability: {} as Record<string, ResourceAvailability>,
        failures: [] as RuntimeToolCatalog.ToolFailure[],
        summaries: [] as RuntimeToolCatalog.ToolSummary[],
      }
    }

    if (!input.profile && (!input.agent || !input.directory || input.templateIds === undefined)) {
      throw new Error("Registered tool resolution requires authoritative agent, directory, and template context.")
    }

    return RuntimeToolCatalog.resolveDeclared({
      ids: declared,
      context: {
        sessionId: input.sessionID,
        projectId: input.projectID ?? Instance.project.id,
        directory: input.directory ?? Instance.directory,
        agent: input.profile?.agent.name ?? input.agent!,
        templateIds: input.profile?.sourceTemplateIds ?? input.templateIds!,
      },
      occupiedToolIDs: input.occupiedToolIDs,
      isExposureDenied: input.isToolExposureDenied,
      budgetMs: input.toolAvailabilityBudgetMs,
    })
  }

  async function resolveMcp(spec: McpResourceSpec) {
    const declaredServers = uniqueSorted(spec.servers)
    const cfg = await Config.get()
    const availableServers: string[] = []
    const availability: Record<string, ResourceAvailability> = {}
    const failures: ResourceFailure[] = []
    const checkedAt = Date.now()

    for (const server of declaredServers) {
      const entry = cfg.mcp?.[server]
      if (!isMcpConfigured(entry) || entry.enabled === false) {
        availability[server] = {
          declared: true,
          status: "unavailable",
          reason: "disabled-by-current-config",
          checkedAt,
          error: `MCP server "${server}" is disabled or missing in the current configuration.`,
        }
        failures.push({
          resourceType: "mcp",
          resourceID: server,
          status: "unavailable",
          stage: "resolve",
          reason: "disabled-by-current-config",
          message: availability[server].error!,
          recoverable: true,
          action: {
            type: "open-settings",
            label: "Open MCP settings",
          },
        })
        continue
      }

      availability[server] = {
        declared: true,
        status: "unknown",
        checkedAt,
      }
      availableServers.push(server)
    }

    return {
      declaredServers,
      availableServers,
      availability,
      failures,
    }
  }

  async function resolveSkills(spec: SkillResourceSpec) {
    const declaredSkills = uniqueSorted(spec.skills)
    const registry = new Map((await listSkills({ includeDeclaredOnly: true })).map((skill) => [skill.name, skill]))
    const availableSkills: SkillInfo[] = []
    const availability: Record<string, ResourceAvailability> = {}
    const failures: ResourceFailure[] = []
    const checkedAt = Date.now()

    for (const name of declaredSkills) {
      const skill = registry.get(name)
      if (!skill) {
        availability[name] = {
          declared: true,
          status: "unavailable",
          reason: "disabled-by-current-config",
          checkedAt,
          error: `Skill "${name}" is disabled or missing in the current registry.`,
        }
        failures.push({
          resourceType: "skill",
          resourceID: name,
          status: "unavailable",
          stage: "resolve",
          reason: "disabled-by-current-config",
          message: availability[name].error!,
          recoverable: true,
          action: {
            type: "open-settings",
            label: "Open skill settings",
          },
        })
        continue
      }
      availability[name] = {
        declared: true,
        status: "available",
        checkedAt,
      }
      availableSkills.push(skill)
    }

    return {
      declaredSkills,
      availableSkills,
      availability,
      failures,
    }
  }
}
