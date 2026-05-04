import type {
  PlatformActionDescriptor,
  PlatformActionResult,
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformAuditEntry,
  PlatformAuditWriter,
  PlatformConfigDescriptor,
  PlatformConfigField,
  PlatformDescriptor,
  PlatformRuntimeSourcesDescriptor,
  PlatformRuntimeSourcesProvider,
  PlatformRuntimeStatus,
  PlatformSecretAccess,
  PlatformSecretRef,
  PlatformValidationResult,
} from '@nine1bot/platform-protocol'
import { normalize as normalizePath, posix as posixPath, win32 as win32Path } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'
import { RuntimeSourceRegistry } from '../../../../opencode/packages/opencode/src/runtime/source/registry'

export type PlatformLifecycleStatus =
  | 'discovered'
  | 'configured'
  | 'disabled'
  | 'enabled'
  | 'registered'
  | 'healthy'
  | 'degraded'
  | 'error'

export type PlatformConfigEntry = {
  enabled?: boolean
  features?: Record<string, boolean>
  settings?: Record<string, unknown>
}

export type PlatformManagerConfig = Record<string, PlatformConfigEntry | undefined>

export type PlatformManagerRecord = {
  id: string
  descriptor: PlatformDescriptor
  installed: boolean
  builtIn: boolean
  enabled: boolean
  registered: boolean
  lifecycleStatus: PlatformLifecycleStatus
  runtimeStatus: PlatformRuntimeStatus
  features: Record<string, boolean>
  settings: Record<string, unknown>
  error?: string
  errorAt?: string
}

export type PlatformManagerSummary = {
  id: string
  name: string
  packageName: string
  version?: string
  installed: boolean
  builtIn: boolean
  enabled: boolean
  registered: boolean
  lifecycleStatus: PlatformLifecycleStatus
  status: PlatformRuntimeStatus['status']
  capabilities: PlatformDescriptor['capabilities']
  lastError?: {
    code: string
    message: string
    at: string
  }
}

export type PlatformManagerDetail = PlatformManagerSummary & {
  descriptor: PlatformDescriptor
  config?: PlatformConfigDescriptor
  detailPage?: PlatformDescriptor['detailPage']
  actions: PlatformActionDescriptor[]
  features: Record<string, boolean>
  settings: Record<string, unknown>
  runtimeStatus: PlatformRuntimeStatus
  runtimeSources?: PlatformRuntimeSourcesSummary
}

export type PlatformRuntimeSourceSummary = {
  id: string
  directory: string
  namespace?: string
  includeNamePrefix?: string
  visibility: string
  status: 'registered' | 'disabled' | 'error'
  error?: string
}

export type PlatformRuntimeSourcesSummary = {
  agents: PlatformRuntimeSourceSummary[]
  skills: PlatformRuntimeSourceSummary[]
}

export type PlatformConfigPatch = {
  enabled?: boolean
  features?: Record<string, boolean>
  settings?: Record<string, unknown>
}

export type PlatformActionInput = {
  input?: unknown
  confirm?: boolean
}

export type PlatformRedactedSecretField = {
  redacted: true
  hasValue: boolean
  provider?: PlatformSecretRef['provider']
}

export type PlatformAdapterManagerOptions = {
  contributions: PlatformAdapterContribution[]
  config?: PlatformManagerConfig
  secrets?: PlatformSecretAccess
  audit?: PlatformAuditWriter
  env?: Record<string, string | undefined>
}

export class PlatformNotFoundError extends Error {
  constructor(readonly platformId: string) {
    super(`Platform not found: ${platformId}`)
    this.name = 'PlatformNotFoundError'
  }
}

export class PlatformValidationError extends Error {
  constructor(
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message)
    this.name = 'PlatformValidationError'
  }
}

export class PlatformActionNotFoundError extends Error {
  constructor(
    readonly platformId: string,
    readonly actionId: string,
  ) {
    super(`Platform action not found: ${platformId}/${actionId}`)
    this.name = 'PlatformActionNotFoundError'
  }
}

export class PlatformActionConfirmationError extends Error {
  constructor(
    readonly platformId: string,
    readonly actionId: string,
  ) {
    super(`Platform action requires confirmation: ${platformId}/${actionId}`)
    this.name = 'PlatformActionConfirmationError'
  }
}

const noopSecrets: PlatformSecretAccess = {
  async get() {
    return undefined
  },
  async set() {},
  async delete() {},
  async has() {
    return false
  },
}

const noopAudit: PlatformAuditWriter = {
  write() {},
}

export class PlatformAdapterManager {
  private readonly contributions = new Map<string, PlatformAdapterContribution>()
  private readonly records = new Map<string, PlatformManagerRecord>()
  private readonly secrets: PlatformSecretAccess
  private readonly audit: PlatformAuditWriter
  private readonly env: Record<string, string | undefined>
  private config: PlatformManagerConfig

  constructor(options: PlatformAdapterManagerOptions) {
    this.config = normalizeConfig(options.config ?? {})
    this.secrets = options.secrets ?? noopSecrets
    this.audit = options.audit ?? noopAudit
    this.env = options.env ?? { ...process.env }

    for (const contribution of options.contributions) {
      this.contributions.set(contribution.descriptor.id, contribution)
    }
    this.rebuildRecords()
  }

  configure(config: PlatformManagerConfig) {
    this.unregisterRuntimeAdapters()
    this.config = normalizeConfig(config)
    this.rebuildRecords()
  }

  configSnapshot(): PlatformManagerConfig {
    return cloneJson(this.config)
  }

  list(): PlatformManagerRecord[] {
    return Array.from(this.records.values()).map((record) => cloneRecord(record))
  }

  listSummaries(): PlatformManagerSummary[] {
    return this.list().map((record) => this.summaryFromRecord(record))
  }

  get(id: string): PlatformManagerRecord | undefined {
    const record = this.records.get(id)
    return record ? cloneRecord(record) : undefined
  }

  async getDetail(id: string): Promise<PlatformManagerDetail | undefined> {
    const record = this.records.get(id)
    if (!record) return undefined
    return {
      ...this.summaryFromRecord(record),
      descriptor: record.descriptor,
      config: record.descriptor.config,
      detailPage: record.descriptor.detailPage,
      actions: record.descriptor.actions ?? [],
      features: { ...record.features },
      settings: await this.redactSettings(record),
      runtimeStatus: cloneJson(record.runtimeStatus),
      runtimeSources: this.runtimeSourcesForRecord(record),
    }
  }

  registerRuntimeAdapters(): PlatformManagerRecord[] {
    for (const contribution of this.contributions.values()) {
      const record = this.records.get(contribution.descriptor.id)
      if (!record) continue
      if (!record.enabled) {
        RuntimePlatformAdapterRegistry.markDisabled({
          id: record.id,
          templateIds: record.descriptor.capabilities.templates,
          reason: 'platform-disabled-by-current-config',
          message: `Platform "${record.descriptor.name}" is disabled by the current configuration.`,
        })
        RuntimeSourceRegistry.unregisterOwner(record.id)
        continue
      }
      if (record.registered) continue
      RuntimePlatformAdapterRegistry.unmarkDisabled(record.id)
      if (!contribution.runtime?.createAdapter) {
        this.markHealthy(record.id)
        continue
      }

      try {
        const adapter = contribution.runtime.createAdapter(this.createContext(record))
        RuntimePlatformAdapterRegistry.register(adapter)
        this.registerRuntimeSources(record, contribution.runtime.sources)
        this.records.set(record.id, {
          ...record,
          registered: true,
          lifecycleStatus: 'healthy',
          runtimeStatus: { status: 'available' },
          error: undefined,
          errorAt: undefined,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.records.set(record.id, {
          ...record,
          registered: false,
          lifecycleStatus: 'error',
          runtimeStatus: {
            status: 'error',
            message,
          },
          error: message,
          errorAt: new Date().toISOString(),
        })
        this.writeAudit({
          platformId: record.id,
          level: 'error',
          stage: 'runtime-register',
          message,
          reason: 'adapter-create-failed',
        })
      }
    }
    return this.list()
  }

  unregisterRuntimeAdapters(): PlatformManagerRecord[] {
    for (const record of this.records.values()) {
      if (record.registered) {
        RuntimePlatformAdapterRegistry.unregister(record.id)
      }
      RuntimeSourceRegistry.unregisterOwner(record.id)
      RuntimePlatformAdapterRegistry.unmarkDisabled(record.id)
      const nextStatus: PlatformRuntimeStatus = !record.installed
        ? { status: 'missing', message: `Platform package is not installed: ${record.id}` }
        : record.enabled
          ? { status: 'available' }
          : { status: 'disabled' }
      this.records.set(record.id, {
        ...record,
        registered: false,
        lifecycleStatus: record.enabled ? 'enabled' : 'disabled',
        runtimeStatus: nextStatus,
      })
    }
    return this.list()
  }

  async updateConfig(id: string, patch: PlatformConfigPatch): Promise<PlatformManagerRecord> {
    const record = this.records.get(id)
    if (!record) throw new PlatformNotFoundError(id)
    if (!record.installed) throw new PlatformValidationError(`Platform is not installed: ${id}`)

    const previousEntry = this.config[id] ?? {}
    const nextEntry = await this.prepareConfigEntry(record, previousEntry, patch)
    const validation = await this.validateConfigEntry(record, nextEntry)
    if (!validation.ok) {
      throw new PlatformValidationError(validation.message ?? 'Invalid platform config', validation.fieldErrors ?? {})
    }

    const nextConfig = {
      ...this.config,
      [id]: nextEntry,
    }
    this.configure(nextConfig)
    this.registerRuntimeAdapters()
    const updated = this.records.get(id)
    if (!updated) throw new PlatformNotFoundError(id)
    return cloneRecord(updated)
  }

  async refreshStatus(id: string): Promise<PlatformRuntimeStatus> {
    const record = this.records.get(id)
    if (!record) throw new PlatformNotFoundError(id)

    if (!record.installed) return record.runtimeStatus
    if (!record.enabled) {
      const disabled = { status: 'disabled' as const }
      this.records.set(id, {
        ...record,
        lifecycleStatus: 'disabled',
        runtimeStatus: disabled,
      })
      return disabled
    }

    const contribution = this.contributions.get(id)
    if (!contribution?.getStatus) return record.runtimeStatus

    try {
      const runtimeStatus = await contribution.getStatus(this.createContext(record))
      this.records.set(id, {
        ...record,
        lifecycleStatus: lifecycleStatusFromRuntime(runtimeStatus.status),
        runtimeStatus,
        error: runtimeStatus.status === 'error' ? runtimeStatus.message : undefined,
        errorAt: runtimeStatus.status === 'error' ? new Date().toISOString() : undefined,
      })
      return runtimeStatus
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const runtimeStatus: PlatformRuntimeStatus = {
        status: 'error',
        message,
      }
      this.records.set(id, {
        ...record,
        lifecycleStatus: 'error',
        runtimeStatus,
        error: message,
        errorAt: new Date().toISOString(),
      })
      this.writeAudit({
        platformId: id,
        level: 'error',
        stage: 'status',
        message,
        reason: 'status-handler-failed',
      })
      return runtimeStatus
    }
  }

  async executeAction(id: string, actionId: string, input: PlatformActionInput = {}): Promise<PlatformActionResult> {
    const record = this.records.get(id)
    if (!record) throw new PlatformNotFoundError(id)
    const action = record.descriptor.actions?.find((candidate) => candidate.id === actionId)
    if (!action) throw new PlatformActionNotFoundError(id, actionId)
    if (action.danger && input.confirm !== true) throw new PlatformActionConfirmationError(id, actionId)

    const inputValidation = validateInputSchema(action.inputSchema, input.input)
    if (!inputValidation.ok) {
      throw new PlatformValidationError(inputValidation.message ?? 'Invalid action input', inputValidation.fieldErrors ?? {})
    }

    const contribution = this.contributions.get(id)
    if (!record.enabled || !record.installed) {
      return {
        status: 'failed',
        message: `Platform is ${record.runtimeStatus.status}`,
        updatedStatus: record.runtimeStatus,
      }
    }
    if (!contribution?.handleAction) {
      return {
        status: 'failed',
        message: `Action is not implemented: ${actionId}`,
        updatedStatus: record.runtimeStatus,
      }
    }

    this.writeAudit({
      platformId: id,
      level: 'info',
      stage: 'action',
      message: `Executing platform action: ${actionId}`,
      data: {
        actionId,
        input: redactActionInput(action, input.input),
      },
    })

    try {
      const result = await contribution.handleAction(actionId, input.input, this.createContext(record))
      if (result.openUrl && !isSafeOpenUrl(result.openUrl)) {
        return {
          status: 'failed',
          message: 'Action returned an unsafe URL',
          updatedStatus: record.runtimeStatus,
        }
      }
      let currentRecord = record
      if (result.updatedSettings !== undefined) {
        const previousEntry = this.config[id] ?? {}
        const nextEntry = await this.prepareConfigEntry(record, previousEntry, {
          settings: settingsRecord(result.updatedSettings),
        })
        const validation = await this.validateConfigEntry(record, nextEntry)
        if (!validation.ok) {
          throw new PlatformValidationError(validation.message ?? 'Invalid platform config', validation.fieldErrors ?? {})
        }
        this.configure({
          ...this.config,
          [id]: nextEntry,
        })
        this.registerRuntimeAdapters()
        currentRecord = this.records.get(id) ?? currentRecord
      }
      if (result.updatedStatus) {
        this.records.set(id, {
          ...currentRecord,
          lifecycleStatus: lifecycleStatusFromRuntime(result.updatedStatus.status),
          runtimeStatus: result.updatedStatus,
          error: result.updatedStatus.status === 'error' ? result.updatedStatus.message : undefined,
          errorAt: result.updatedStatus.status === 'error' ? new Date().toISOString() : undefined,
        })
      }
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const runtimeStatus: PlatformRuntimeStatus = {
        status: 'error',
        message,
      }
      this.records.set(id, {
        ...record,
        lifecycleStatus: 'error',
        runtimeStatus,
        error: message,
        errorAt: new Date().toISOString(),
      })
      this.writeAudit({
        platformId: id,
        level: 'error',
        stage: 'action',
        message,
        reason: 'action-handler-failed',
        data: {
          actionId,
        },
      })
      return {
        status: 'failed',
        message,
        updatedStatus: runtimeStatus,
      }
    }
  }

  private rebuildRecords() {
    const next = new Map<string, PlatformManagerRecord>()
    for (const contribution of this.contributions.values()) {
      const descriptor = contribution.descriptor
      const config = this.config[descriptor.id] ?? {}
      const enabled = config.enabled ?? (descriptor.defaultEnabled !== false)
      const previous = this.records.get(descriptor.id)
      next.set(descriptor.id, {
        id: descriptor.id,
        descriptor,
        installed: true,
        builtIn: true,
        enabled,
        registered: previous?.registered && previous.enabled === enabled ? previous.registered : false,
        lifecycleStatus: enabled ? 'enabled' : 'disabled',
        runtimeStatus: enabled ? { status: 'available' } : { status: 'disabled' },
        features: config.features ?? {},
        settings: settingsRecord(config.settings),
      })
    }

    for (const [id, config] of Object.entries(this.config)) {
      if (next.has(id)) continue
      const enabled = config?.enabled ?? false
      next.set(id, {
        id,
        descriptor: missingDescriptor(id),
        installed: false,
        builtIn: false,
        enabled,
        registered: false,
        lifecycleStatus: 'discovered',
        runtimeStatus: {
          status: 'missing',
          message: `Platform package is not installed: ${id}`,
        },
        features: config?.features ?? {},
        settings: settingsRecord(config?.settings),
      })
    }

    this.records.clear()
    for (const [id, record] of next) {
      this.records.set(id, record)
    }
  }

  private markHealthy(id: string) {
    const record = this.records.get(id)
    if (!record) return
    this.records.set(id, {
      ...record,
      lifecycleStatus: 'healthy',
      runtimeStatus: { status: 'available' },
      error: undefined,
      errorAt: undefined,
    })
  }

  private createContext(record: PlatformManagerRecord): PlatformAdapterContext {
    return {
      platformId: record.id,
      enabled: record.enabled,
      settings: record.settings,
      features: record.features,
      env: this.env,
      secrets: this.secrets,
      audit: this.audit,
    }
  }

  private registerRuntimeSources(record: PlatformManagerRecord, sources?: PlatformRuntimeSourcesProvider) {
    RuntimeSourceRegistry.registerOwner({
      owner: {
        id: record.id,
        kind: 'platform',
        enabled: record.enabled,
      },
      sources: normalizeRuntimeSources(this.resolveRuntimeSources(record, sources)),
    })
  }

  private runtimeSourcesForRecord(record: PlatformManagerRecord): PlatformRuntimeSourcesSummary | undefined {
    const contribution = this.contributions.get(record.id)
    const sources = this.resolveRuntimeSources(record, contribution?.runtime?.sources)
    if (!sources?.agents?.length && !sources?.skills?.length) return undefined

    const normalizedSources = normalizeRuntimeSources(sources) ?? {}
    const registered = RuntimeSourceRegistry.listOwner(record.id)
    const status = runtimeSourceStatus(record)
    const registeredAgents = new Set(registered.agents.map((source) => source.id))
    const registeredSkills = new Set(registered.skills.map((source) => source.id))

    return {
      agents: (normalizedSources.agents ?? []).map((source) => ({
        id: source.id,
        directory: source.directory,
        namespace: source.namespace,
        visibility: source.visibility,
        status: registeredAgents.has(source.id) ? 'registered' : status,
        error: runtimeSourceError(record, source.id, status),
      })),
      skills: (normalizedSources.skills ?? []).map((source) => ({
        id: source.id,
        directory: source.directory,
        namespace: source.namespace,
        includeNamePrefix: source.includeNamePrefix,
        visibility: source.visibility,
        status: registeredSkills.has(source.id) ? 'registered' : status,
        error: runtimeSourceError(record, source.id, status),
      })),
    }
  }

  private resolveRuntimeSources(
    record: PlatformManagerRecord,
    sources?: PlatformRuntimeSourcesProvider,
  ): PlatformRuntimeSourcesDescriptor | undefined {
    return typeof sources === 'function' ? sources(this.createContext(record)) : sources
  }

  private async prepareConfigEntry(
    record: PlatformManagerRecord,
    previousEntry: PlatformConfigEntry,
    patch: PlatformConfigPatch,
  ): Promise<PlatformConfigEntry> {
    const previousSettings = settingsRecord(previousEntry.settings)
    const incomingSettings = patch.settings === undefined ? undefined : settingsRecord(patch.settings)
    const nextSettings = incomingSettings === undefined
      ? previousSettings
      : {
          ...previousSettings,
          ...incomingSettings,
        }

    if (incomingSettings) {
      for (const field of secretFields(record.descriptor.config)) {
        if (!hasOwn(incomingSettings, field.key)) continue
        const value = incomingSettings[field.key]
        const previousValue = previousSettings[field.key]
        const ref = isPlatformSecretRef(previousValue)
          ? previousValue
          : defaultSecretRef(record.id, field.key)

        if (value === null) {
          await this.secrets.delete(ref).catch(() => {})
          delete nextSettings[field.key]
        } else if (typeof value === 'string') {
          if (value.length > 0) {
            await this.secrets.set(ref, value)
            nextSettings[field.key] = ref
          } else if (previousValue !== undefined) {
            nextSettings[field.key] = previousValue
          } else {
            delete nextSettings[field.key]
          }
        } else if (isPlatformSecretRef(value)) {
          nextSettings[field.key] = value
        } else if (isRedactedSecretField(value)) {
          if (previousValue !== undefined) {
            nextSettings[field.key] = previousValue
          } else {
            delete nextSettings[field.key]
          }
        } else {
          throw new PlatformValidationError(`Invalid secret value for ${field.key}`, {
            [field.key]: 'Secret fields must be string, null, or PlatformSecretRef',
          })
        }
      }

      for (const [key, value] of Object.entries(incomingSettings)) {
        if (value === null) delete nextSettings[key]
      }
    }

    return {
      enabled: patch.enabled ?? previousEntry.enabled,
      features: patch.features
        ? {
            ...(previousEntry.features ?? {}),
            ...patch.features,
          }
        : previousEntry.features ?? {},
      settings: nextSettings,
    }
  }

  private async validateConfigEntry(
    record: PlatformManagerRecord,
    entry: PlatformConfigEntry,
  ): Promise<PlatformValidationResult> {
    const descriptorValidation = validateSettingsDescriptor(record.descriptor.config, entry.settings ?? {})
    if (!descriptorValidation.ok) return descriptorValidation

    const contribution = this.contributions.get(record.id)
    if (!contribution?.validateConfig) return { ok: true }
    const validation = await contribution.validateConfig(entry.settings ?? {}, this.createContext({
      ...record,
      enabled: entry.enabled ?? record.enabled,
      features: entry.features ?? {},
      settings: entry.settings ?? {},
    }))
    return validation
  }

  private async redactSettings(record: PlatformManagerRecord): Promise<Record<string, unknown>> {
    const settings = settingsRecord(record.settings)
    const redacted = { ...settings }

    for (const field of secretFields(record.descriptor.config)) {
      const value = settings[field.key]
      if (isPlatformSecretRef(value)) {
        redacted[field.key] = {
          redacted: true,
          hasValue: await this.secrets.has(value),
          provider: value.provider,
        } satisfies PlatformRedactedSecretField
      } else if (value !== undefined) {
        redacted[field.key] = {
          redacted: true,
          hasValue: true,
        } satisfies PlatformRedactedSecretField
      } else {
        redacted[field.key] = {
          redacted: true,
          hasValue: false,
        } satisfies PlatformRedactedSecretField
      }
    }

    return redacted
  }

  private summaryFromRecord(record: PlatformManagerRecord): PlatformManagerSummary {
    return {
      id: record.id,
      name: record.descriptor.name,
      packageName: record.descriptor.packageName,
      version: record.descriptor.version,
      installed: record.installed,
      builtIn: record.builtIn,
      enabled: record.enabled,
      registered: record.registered,
      lifecycleStatus: record.lifecycleStatus,
      status: record.runtimeStatus.status,
      capabilities: record.descriptor.capabilities,
      lastError: record.error
        ? {
            code: record.runtimeStatus.status,
            message: record.error,
            at: record.errorAt ?? new Date(0).toISOString(),
          }
        : undefined,
    }
  }

  private writeAudit(entry: PlatformAuditEntry) {
    try {
      void this.audit.write({
        ...entry,
        at: entry.at ?? new Date().toISOString(),
      })
    } catch {
      // Audit is best-effort for the platform manager.
    }
  }
}

function normalizeConfig(config: PlatformManagerConfig): PlatformManagerConfig {
  return Object.fromEntries(
    Object.entries(config).map(([id, entry]) => [
      id,
      {
        enabled: entry?.enabled,
        features: entry?.features ?? {},
        settings: settingsRecord(entry?.settings),
      },
    ]),
  )
}

function cloneRecord(record: PlatformManagerRecord): PlatformManagerRecord {
  return {
    ...record,
    features: { ...record.features },
    settings: settingsRecord(record.settings),
    runtimeStatus: cloneJson(record.runtimeStatus),
  }
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function settingsRecord(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return { ...(input as Record<string, unknown>) }
}

function missingDescriptor(id: string): PlatformDescriptor {
  return {
    id,
    name: id,
    packageName: '',
    version: '',
    defaultEnabled: false,
    capabilities: {},
  }
}

function lifecycleStatusFromRuntime(status: PlatformRuntimeStatus['status']): PlatformLifecycleStatus {
  if (status === 'available') return 'healthy'
  if (status === 'disabled') return 'disabled'
  if (status === 'error') return 'error'
  return 'degraded'
}

function runtimeSourceStatus(record: PlatformManagerRecord): PlatformRuntimeSourceSummary['status'] {
  if (!record.enabled) return 'disabled'
  if (record.lifecycleStatus === 'error') return 'error'
  if (!record.registered) return 'disabled'
  return 'error'
}

function normalizeRuntimeSources(sources?: PlatformRuntimeSourcesDescriptor): PlatformRuntimeSourcesDescriptor | undefined {
  if (!sources) return undefined
  return {
    agents: sources.agents?.map((source) => normalizeRuntimeSource(source)),
    skills: sources.skills?.map((source) => normalizeRuntimeSource(source)),
  }
}

function normalizeRuntimeSource<T extends { directory: string }>(source: T): T {
  return {
    ...source,
    directory: normalizeRuntimeSourceDirectory(source.directory),
  }
}

function normalizeRuntimeSourceDirectory(directory: string): string {
  const resolved = directory.startsWith('file://') ? fileURLToPath(directory) : directory

  if (/^\/[A-Za-z]:[\\/]/.test(resolved)) {
    return win32Path.normalize(resolved.slice(1))
  }
  if (/^[A-Za-z]:[\\/]/.test(resolved) || resolved.startsWith('\\\\')) {
    return win32Path.normalize(resolved)
  }
  if (resolved.startsWith('/')) {
    return posixPath.normalize(resolved)
  }
  return normalizePath(resolved)
}

function runtimeSourceError(
  record: PlatformManagerRecord,
  sourceID: string,
  status: PlatformRuntimeSourceSummary['status'],
): string | undefined {
  if (status !== 'error') return undefined
  return record.error ?? `Runtime source "${sourceID}" was declared but not registered.`
}

function secretFields(config?: PlatformConfigDescriptor): PlatformConfigField[] {
  return config?.sections.flatMap((section) => section.fields).filter((field) => field.secret || field.type === 'password') ?? []
}

function allFields(config?: PlatformConfigDescriptor): PlatformConfigField[] {
  return config?.sections.flatMap((section) => section.fields) ?? []
}

function validateSettingsDescriptor(config: PlatformConfigDescriptor | undefined, settings: Record<string, unknown>): PlatformValidationResult {
  return validateFields(allFields(config), settings)
}

function validateInputSchema(config: PlatformConfigDescriptor | undefined, input: unknown): PlatformValidationResult {
  if (!config) return { ok: true }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, message: 'Action input must be an object' }
  }
  return validateFields(allFields(config), input as Record<string, unknown>)
}

function validateFields(fields: PlatformConfigField[], values: Record<string, unknown>): PlatformValidationResult {
  const fieldErrors: Record<string, string> = {}

  for (const field of fields) {
    const value = values[field.key]
    if (field.required && (value === undefined || value === null || value === '')) {
      fieldErrors[field.key] = 'Required'
      continue
    }
    if (value === undefined || value === null) continue
    if ((field.secret || field.type === 'password') && (isPlatformSecretRef(value) || isRedactedSecretField(value))) {
      continue
    }

    if (field.type === 'string' || field.type === 'password') {
      if (typeof value !== 'string') fieldErrors[field.key] = 'Must be a string'
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') fieldErrors[field.key] = 'Must be a boolean'
    } else if (field.type === 'number') {
      if (typeof value !== 'number') fieldErrors[field.key] = 'Must be a number'
    } else if (field.type === 'select') {
      if (typeof value !== 'string') {
        fieldErrors[field.key] = 'Must be a string'
      } else if (field.options && !field.options.includes(value)) {
        fieldErrors[field.key] = `Must be one of: ${field.options.join(', ')}`
      }
    } else if (field.type === 'string-list') {
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
        fieldErrors[field.key] = 'Must be a string array'
      }
    } else if (field.type === 'json') {
      if (typeof value === 'function' || typeof value === 'symbol') {
        fieldErrors[field.key] = 'Must be JSON-compatible'
      }
    }
  }

  return Object.keys(fieldErrors).length > 0
    ? {
        ok: false,
        message: 'Invalid platform config',
        fieldErrors,
      }
    : { ok: true }
}

function defaultSecretRef(platformId: string, fieldKey: string): PlatformSecretRef {
  return {
    provider: 'nine1bot-local',
    key: `platform:${platformId}:default:${fieldKey}`,
  }
}

function isPlatformSecretRef(input: unknown): input is PlatformSecretRef {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return (
    (record.provider === 'nine1bot-local' || record.provider === 'env' || record.provider === 'external') &&
    typeof record.key === 'string'
  )
}

function isRedactedSecretField(input: unknown): input is PlatformRedactedSecretField {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false
  const record = input as Record<string, unknown>
  return record.redacted === true
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key)
}

function redactActionInput(action: PlatformActionDescriptor, input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input
  const record = { ...(input as Record<string, unknown>) }
  for (const field of secretFields(action.inputSchema)) {
    if (hasOwn(record, field.key)) {
      record[field.key] = {
        redacted: true,
        hasValue: record[field.key] !== undefined && record[field.key] !== null && record[field.key] !== '',
      } satisfies PlatformRedactedSecretField
    }
  }
  return record
}

function isSafeOpenUrl(input: string): boolean {
  try {
    const url = new URL(input)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
