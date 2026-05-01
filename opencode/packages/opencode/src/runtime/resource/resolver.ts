import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Config } from "@/config/config"
import { Log } from "@/util/log"
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

  export const Failed = BusEvent.define(
    "runtime.resource.failed",
    z.object({
      sessionID: z.string(),
      turnSnapshotId: z.string().optional(),
      resourceType: z.enum(["mcp", "skill"]),
      resourceID: z.string(),
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
      }),
      resolved: z.object({
        mcp: z.array(z.string()),
        skills: z.array(z.string()),
      }),
      unavailable: z.array(
        z.object({
          type: z.enum(["mcp", "skill"]),
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
      }
      resolved: {
        mcp: string[]
        skills: string[]
      }
      unavailable: Array<{ type: "mcp" | "skill"; id: string; reason?: string; error?: string }>
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
    emitFailures?: boolean
    emitResolved?: boolean
  }): Promise<Resolved> {
    const resources = input.profile?.resources ?? (await compileProfileResources())
    const mcp = await resolveMcp(resources.mcp)
    const skills = await resolveSkills(resources.skills)
    const failures = [...mcp.failures, ...skills.failures]

    if (input.emitFailures !== false) {
      for (const failure of failures) {
        await Bus.publish(Failed, {
          ...failure,
          sessionID: input.sessionID,
          turnSnapshotId: input.turnSnapshotId,
        }).catch((error) => {
          log.warn("failed to publish resource failure event", { error })
        })
      }
    }

    const result: Resolved = {
      builtinTools: resources.builtinTools,
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
        },
        resolved: {
          mcp: mcp.availableServers,
          skills: skills.availableSkills.map((skill) => skill.name),
        },
        unavailable: failures.map((failure) => ({
          type: failure.resourceType,
          id: failure.resourceID,
          reason: failure.reason,
          error: failure.message,
        })),
      },
    }

    if (input.emitResolved !== false) {
      await Bus.publish(ResolvedEvent, {
        sessionID: input.sessionID,
        turnSnapshotId: input.turnSnapshotId,
        declared: result.audit.declared,
        resolved: result.audit.resolved,
        unavailable: result.audit.unavailable,
        failures: result.failures.length,
      }).catch((error) => {
        log.warn("failed to publish resources resolved event", { error })
      })
    }

    return result
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
