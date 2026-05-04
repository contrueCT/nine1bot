export type PlatformCapabilityAuth = 'none' | 'token' | 'oauth' | 'external'

export type PlatformCapabilities = {
  pageContext?: boolean
  templates?: string[]
  resources?: boolean
  browserExtension?: boolean
  auth?: PlatformCapabilityAuth
  settingsPage?: boolean
  statusPage?: boolean
}

export type PlatformDescriptor = {
  id: string
  name: string
  packageName: string
  version: string
  description?: string
  defaultEnabled?: boolean
  capabilities: PlatformCapabilities
  config?: PlatformConfigDescriptor
  detailPage?: PlatformDetailPageDescriptor
  actions?: PlatformActionDescriptor[]
  browser?: {
    safeExports?: string[]
  }
  web?: {
    componentKeys?: string[]
  }
}

export type PlatformConfigDescriptor = {
  sections: PlatformConfigSection[]
}

export type PlatformConfigSection = {
  id: string
  title: string
  description?: string
  fields: PlatformConfigField[]
}

export type PlatformConfigField = {
  key: string
  label: string
  type: 'string' | 'password' | 'boolean' | 'number' | 'select' | 'string-list' | 'json'
  description?: string
  required?: boolean
  options?: string[]
  defaultValue?: unknown
  placeholder?: string
  secret?: boolean
}

export type PlatformDetailPageDescriptor = {
  sections: PlatformDetailPageSection[]
}

export type PlatformDetailPageSection = {
  id: string
  title: string
  type: 'status-cards' | 'settings-form' | 'action-list' | 'event-list' | 'capability-list' | 'custom'
  componentKey?: string
}

export type PlatformActionDescriptor = {
  id: string
  label: string
  description?: string
  kind: 'button' | 'form' | 'link'
  inputSchema?: PlatformConfigDescriptor
  danger?: boolean
}

export type PlatformRuntimeStatus = {
  status: 'available' | 'disabled' | 'missing' | 'auth-required' | 'degraded' | 'error'
  message?: string
  cards?: PlatformStatusCard[]
  recentEvents?: PlatformRecentEvent[]
}

export type PlatformStatusCard = {
  id: string
  label: string
  value: string
  tone?: 'neutral' | 'success' | 'warning' | 'danger'
}

export type PlatformRecentEvent = {
  id: string
  at: string
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  stage?: string
  reason?: string
  data?: Record<string, unknown>
}

export type PlatformSecretProvider = 'nine1bot-local' | 'env' | 'external'

export type PlatformSecretRef = {
  provider: PlatformSecretProvider
  key: string
}

export type PlatformSecretAccess = {
  get(ref: PlatformSecretRef): Promise<string | undefined>
  set(ref: PlatformSecretRef, value: string): Promise<void>
  delete(ref: PlatformSecretRef): Promise<void>
  has(ref: PlatformSecretRef): Promise<boolean>
}

export type PlatformAuditEntry = {
  platformId: string
  level: 'debug' | 'info' | 'warn' | 'error'
  stage: string
  message?: string
  reason?: string
  data?: Record<string, unknown>
  at?: string
}

export type PlatformAuditWriter = {
  write(entry: PlatformAuditEntry): void | Promise<void>
}

export type PlatformAdapterContext = {
  platformId: string
  projectId?: string
  projectDirectory?: string
  enabled: boolean
  settings: unknown
  features: Record<string, boolean>
  env: Record<string, string | undefined>
  secrets: PlatformSecretAccess
  audit: PlatformAuditWriter
}

export type PlatformControllerRequestInit = {
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

export type PlatformControllerBridge = {
  localUrl: string
  authHeader?: string
  requestJson?<T = unknown>(path: string, init?: PlatformControllerRequestInit): Promise<T>
}

export type PlatformBackgroundServiceContext = PlatformAdapterContext & {
  localUrl: string
  authHeader?: string
  controller?: PlatformControllerBridge
  legacySettings?: Record<string, unknown>
}

export type PlatformBackgroundServiceHandle = {
  stop(): Promise<void>
  getStatus?(): PlatformRuntimeStatus
}

export type PlatformBackgroundService = {
  id: string
  start(ctx: PlatformBackgroundServiceContext): Promise<PlatformBackgroundServiceHandle>
}

export type PlatformValidationResult = {
  ok: boolean
  message?: string
  fieldErrors?: Record<string, string>
}

export type PlatformActionResult = {
  status: 'ok' | 'failed' | 'pending' | 'requires-user-action'
  message?: string
  openUrl?: string
  data?: Record<string, unknown>
  updatedStatus?: PlatformRuntimeStatus
  updatedSettings?: unknown
}

export type PlatformRuntimeSourceLifecycle = 'platform-enabled'

export type PlatformSkillSourceDescriptor = {
  id: string
  directory: string
  namespace?: string
  includeNamePrefix?: string
  visibility: 'default' | 'declared-only'
  lifecycle: PlatformRuntimeSourceLifecycle
}

export type PlatformAgentSourceDescriptor = {
  id: string
  directory: string
  namespace?: string
  visibility: 'declared-only' | 'recommendable' | 'user-selectable'
  lifecycle: PlatformRuntimeSourceLifecycle
}

export type PlatformRuntimeSourcesDescriptor = {
  agents?: PlatformAgentSourceDescriptor[]
  skills?: PlatformSkillSourceDescriptor[]
}

export type PlatformRuntimeSourcesProvider =
  | PlatformRuntimeSourcesDescriptor
  | ((ctx: PlatformAdapterContext) => PlatformRuntimeSourcesDescriptor | undefined)

export type PlatformAdapterContribution = {
  descriptor: PlatformDescriptor
  runtime?: {
    createAdapter: (ctx: PlatformAdapterContext) => PlatformRuntimeAdapter
    sources?: PlatformRuntimeSourcesProvider
  }
  backgroundServices?: (ctx: PlatformAdapterContext) => PlatformBackgroundService[]
  getStatus?: (ctx: PlatformAdapterContext) => Promise<PlatformRuntimeStatus>
  validateConfig?: (settings: unknown, ctx: PlatformAdapterContext) => Promise<PlatformValidationResult>
  handleAction?: (
    actionId: string,
    input: unknown,
    ctx: PlatformAdapterContext,
  ) => Promise<PlatformActionResult>
}

export type PlatformPagePayload = {
  platform: string
  url?: string
  pageType?: string
  title?: string
  objectKey?: string
  selection?: string
  visibleSummary?: string
  raw?: Record<string, unknown>
}

export type PlatformTemplateInput = {
  entry?: {
    source?: string
    platform?: string
    mode?: string
    templateIds?: string[]
  }
  page?: PlatformPagePayload
}

export type PlatformRuntimeAdapter = {
  id: string
  matchPage?: (page: PlatformPagePayload) => boolean
  normalizePage?: (page: PlatformPagePayload) => PlatformPagePayload | undefined
  blocksFromPage?: (page: PlatformPagePayload, observedAt: number) => PlatformContextBlock[] | undefined
  inferTemplateIds?: (input: PlatformTemplateInput) => string[]
  templateContextBlocks?: (input: { templateIds: string[]; page?: PlatformPagePayload }) => PlatformContextBlock[]
  resourceContributions?: (input: { templateIds: string[] }) => PlatformResourceContribution | undefined
  recommendedAgent?: (input: { templateIds: string[]; fallback: string }) => string | undefined
}

export type PlatformContextBlock = {
  id: string
  layer: 'base' | 'project' | 'user' | 'business' | 'platform' | 'page' | 'runtime' | 'turn' | 'loop'
  source: string
  enabled: boolean
  priority: number
  lifecycle: 'session' | 'active' | 'turn' | 'loop'
  visibility: 'system-required' | 'developer-toggle' | 'user-toggle'
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

export type PlatformResourceContribution = {
  builtinTools: {
    enabledGroups?: string[]
    enabledTools?: string[]
  }
  mcp: {
    servers: string[]
    tools?: Record<string, string[]>
    lifecycle: 'session'
    mergeMode: 'additive-only'
    availability?: Record<string, PlatformResourceAvailability>
  }
  skills: {
    skills: string[]
    lifecycle: 'session'
    mergeMode: 'additive-only'
    availability?: Record<string, PlatformResourceAvailability>
  }
}

export type PlatformResourceAvailability = {
  declared: boolean
  status: 'unknown' | 'available' | 'degraded' | 'unavailable' | 'auth-required'
  reason?: string
  checkedAt?: number
  error?: string
}
