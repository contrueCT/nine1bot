export namespace RuntimeSourceRegistry {
  export type SourceOwner = {
    id: string
    kind: "platform" | "capability" | "core"
    enabled: boolean
  }

  export type AgentSourceVisibility = "declared-only" | "recommendable" | "user-selectable"
  export type SkillSourceVisibility = "default" | "declared-only"
  export type SourceLifecycle = "platform-enabled"

  export type AgentSourceInput = {
    id: string
    directory: string
    namespace?: string
    visibility: AgentSourceVisibility
    lifecycle: SourceLifecycle
  }

  export type SkillSourceInput = {
    id: string
    directory: string
    namespace?: string
    visibility: SkillSourceVisibility
    lifecycle: SourceLifecycle
  }

  export type RuntimeSourcesInput = {
    agents?: AgentSourceInput[]
    skills?: SkillSourceInput[]
  }

  export type AgentSource = AgentSourceInput & {
    owner: SourceOwner
  }

  export type SkillSource = SkillSourceInput & {
    owner: SourceOwner
  }

  export type OwnerSources = {
    owner?: SourceOwner
    agents: AgentSource[]
    skills: SkillSource[]
  }

  const owners = new Map<string, OwnerSources>()
  let revision = 0

  export function registerOwner(input: {
    owner: SourceOwner
    sources?: RuntimeSourcesInput
  }) {
    const owner = { ...input.owner }
    owners.set(owner.id, {
      owner,
      agents: normalizeSources(input.sources?.agents ?? []).map((source) => ({
        ...source,
        owner,
      })),
      skills: normalizeSources(input.sources?.skills ?? []).map((source) => ({
        ...source,
        owner,
      })),
    })
    revision++
  }

  export function unregisterOwner(ownerID: string) {
    if (owners.delete(ownerID)) {
      revision++
    }
  }

  export function version() {
    return revision
  }

  export function list(): OwnerSources {
    return {
      agents: Array.from(owners.values()).flatMap((entry) => entry.agents.map(cloneAgentSource)),
      skills: Array.from(owners.values()).flatMap((entry) => entry.skills.map(cloneSkillSource)),
    }
  }

  export function listOwner(ownerID: string): OwnerSources {
    const entry = owners.get(ownerID)
    return {
      owner: entry?.owner ? { ...entry.owner } : undefined,
      agents: entry?.agents.map(cloneAgentSource) ?? [],
      skills: entry?.skills.map(cloneSkillSource) ?? [],
    }
  }

  export function clearForTesting() {
    if (owners.size > 0) {
      owners.clear()
      revision++
    }
  }

  function normalizeSources<T extends { id: string }>(sources: T[]) {
    const seen = new Set<string>()
    const result: T[] = []
    for (const source of sources) {
      if (!source.id.trim()) continue
      const key = source.id.trim()
      if (seen.has(key)) continue
      seen.add(key)
      result.push({
        ...source,
        id: key,
      })
    }
    return result
  }

  function cloneAgentSource(source: AgentSource): AgentSource {
    return {
      ...source,
      owner: { ...source.owner },
    }
  }

  function cloneSkillSource(source: SkillSource): SkillSource {
    return {
      ...source,
      owner: { ...source.owner },
    }
  }
}
