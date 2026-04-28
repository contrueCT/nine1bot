export const AGENT_RUNTIME_PROTOCOL_VERSION = "agent-runtime/v1" as const

export type AgentRunSpec = {
  version: typeof AGENT_RUNTIME_PROTOCOL_VERSION
  capabilities?: CapabilitySpec
  session: SessionSpec
  entry: EntrySpec
  input: InputSpec
  model: ModelSpec
  agent: AgentSpec
  context: ContextSpec
  resources: ResourceSpec
  permissions: PermissionSpec
  orchestration: OrchestrationSpec
  runtime: RuntimeSpec
  audit?: AuditSpec
}

export type CapabilitySpec = {
  client?: {
    agentSelection?: boolean
    modelOverride?: boolean
    pageContext?: boolean
    selectionContext?: boolean
    permissionAsk?: boolean
    debugPanel?: boolean
    orchestrationSelection?: boolean
    resourceFailureEvents?: boolean
  }
  server?: {
    protocolVersions: string[]
    contextEvents?: boolean
    resourceHealthEvents?: boolean
    sessionPermissionGrants?: boolean
    profileSnapshots?: boolean
  }
}

export type SessionSpec = {
  id?: string
  directory?: string
  projectId?: string
  createIfMissing?: boolean
  lifecycle?: "new" | "existing"
  profileSnapshot?: SessionProfileSnapshot
}

export type SessionProfileSnapshot = {
  id: string
  sessionId?: string
  createdAt: number
  source?: "new-session" | "legacy-resumed"
  sourceTemplateIds: string[]
  agent: AgentSpec
  defaultModel: {
    providerID: string
    modelID: string
    source: "default-user-template"
  }
  context: Pick<ContextSpec, "blocks" | "policy">
  resources: ResourceSpec
  permissions: PermissionSpec
  sessionPermissionGrants?: SessionPermissionGrant[]
  orchestration?: OrchestrationSpec
}

export type SessionPermissionGrant = {
  id: string
  permission: string
  patterns: string[]
  metadata?: Record<string, unknown>
  grantedAt: number
  expiresAt?: number
  source: "permission-ask"
}

export type EntrySpec = {
  source: "web" | "feishu" | "browser-extension" | "api" | "webhook"
  platform?: string
  mode?: string
  templateIds: string[]
  traceId?: string
}

export type InputSpec = {
  parts: RuntimeInputPart[]
}

export type RuntimeInputPart = {
  type: string
  [key: string]: unknown
}

export type ModelSpec = {
  providerID: string
  modelID: string
  source: "profile-snapshot" | "session-choice" | "runtime-override"
}

export type AgentSpec = {
  name: string
  source: "default-user-template" | "session-choice" | "internal-runtime"
  recommendedAgent?: string
}

export type ContextSpec = {
  blocks: ContextBlock[]
  policy?: {
    tokenBudget?: number
    debug?: boolean
  }
}

export type ContextBlock = {
  id: string
  layer: "base" | "project" | "user" | "business" | "platform" | "page" | "runtime" | "turn" | "loop"
  source: string
  enabled: boolean
  priority: number
  lifecycle: "session" | "active" | "turn" | "loop"
  visibility: "system-required" | "developer-toggle" | "user-toggle"
  mergeKey?: string
  digest?: string
  observedAt?: number
  staleAfterMs?: number
  content:
    | string
    | {
        resolver: string
        params?: Record<string, unknown>
      }
}

export type ResourceSpec = {
  builtinTools: BuiltinToolSpec
  mcp: McpResourceSpec
  skills: SkillResourceSpec
}

export type BuiltinToolSpec = {
  enabledGroups?: string[]
  enabledTools?: string[]
}

export type McpResourceSpec = {
  servers: string[]
  tools?: Record<string, string[]>
  lifecycle: "session"
  mergeMode: "additive-only"
  availability?: Record<string, ResourceAvailability>
}

export type SkillResourceSpec = {
  skills: string[]
  lifecycle: "session"
  mergeMode: "additive-only"
  availability?: Record<string, ResourceAvailability>
}

export type ResourceAvailability = {
  declared: boolean
  status: "unknown" | "available" | "degraded" | "unavailable" | "auth-required"
  reason?: string
  checkedAt?: number
  error?: string
}

export type PermissionSpec = {
  rules: Record<string, unknown>
  source: string[]
  mergeMode: "strict"
  sessionGrants?: SessionPermissionGrant[]
}

export type OrchestrationSpec =
  | { mode: "single" }
  | { mode: "plan-then-act"; planner?: string; executor?: string }
  | { mode: "parallel-review"; reviewers?: WorkerSpec[] }
  | { mode: "supervisor-workers"; workers?: WorkerSpec[] }

export type WorkerSpec = {
  agent: string
  task: string
  resources?: ResourceSpec
  context?: {
    includeBlocks?: string[]
    excludeBlocks?: string[]
  }
}

export type RuntimeSpec = {
  streaming?: boolean
  noReply?: boolean
  debug?: boolean
  timing?: boolean
  timeoutMs?: number
  turnSnapshotId?: string
}

export type AuditSpec = {
  protocolVersion?: string
  capabilityNegotiation?: CapabilitySpec
  templates: string[]
  modelSource: string
  agentSource: string
  agentOverrideIgnored?: {
    requested: string
    profile: string
  }
  profileSnapshotId?: string
  turnSnapshotId?: string
  contextBlocks: Array<{ id: string; source: string; enabled: boolean }>
  resources: {
    mcp: string[]
    skills: string[]
    builtinTools?: string[]
  }
  permissionSources: string[]
  resourceFailures?: Array<{ type: "mcp" | "skill"; id: string; status: string; error?: string }>
  legacy?: {
    adapter?: string
    promptFields?: string[]
  }
}

export type TurnRuntimeSnapshot = {
  id: string
  createdAt: number
  session: SessionSpec
  entry: EntrySpec
  input: InputSpec
  model: ModelSpec
  agent: AgentSpec
  context: ContextSpec
  resources: ResourceSpec
  permissions: PermissionSpec
  orchestration: OrchestrationSpec
  runtime: RuntimeSpec
  audit?: AuditSpec
  legacy?: {
    messageID?: string
    tools?: Record<string, boolean>
    system?: string
    variant?: string
    context?: {
      blocks?: ContextBlock[]
      page?: {
        platform: string
        url?: string
        pageType?: string
        title?: string
        objectKey?: string
        selection?: string
        visibleSummary?: string
        raw?: Record<string, unknown>
      }
    }
  }
}
