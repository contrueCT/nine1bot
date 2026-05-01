import type {
  PlatformAdapterContext,
  PlatformAdapterContribution,
  PlatformAuditEntry,
  PlatformAuditWriter,
  PlatformDescriptor,
  PlatformRuntimeStatus,
  PlatformSecretAccess,
} from '@nine1bot/platform-protocol'
import { RuntimePlatformAdapterRegistry } from '../../../../opencode/packages/opencode/src/runtime/platform/adapter'

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
  settings?: unknown
}

export type PlatformManagerConfig = Record<string, PlatformConfigEntry | undefined>

export type PlatformManagerRecord = {
  id: string
  descriptor: PlatformDescriptor
  enabled: boolean
  registered: boolean
  lifecycleStatus: PlatformLifecycleStatus
  runtimeStatus: PlatformRuntimeStatus
  features: Record<string, boolean>
  settings: unknown
  error?: string
}

export type PlatformAdapterManagerOptions = {
  contributions: PlatformAdapterContribution[]
  config?: PlatformManagerConfig
  secrets?: PlatformSecretAccess
  audit?: PlatformAuditWriter
  env?: Record<string, string | undefined>
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
    this.config = options.config ?? {}
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
    this.config = config
    this.rebuildRecords()
  }

  list(): PlatformManagerRecord[] {
    return Array.from(this.records.values()).map((record) => ({ ...record }))
  }

  get(id: string): PlatformManagerRecord | undefined {
    const record = this.records.get(id)
    return record ? { ...record } : undefined
  }

  registerRuntimeAdapters(): PlatformManagerRecord[] {
    for (const contribution of this.contributions.values()) {
      const record = this.records.get(contribution.descriptor.id)
      if (!record || !record.enabled || record.registered) continue
      if (!contribution.runtime?.createAdapter) {
        this.markHealthy(record.id)
        continue
      }

      try {
        const adapter = contribution.runtime.createAdapter(this.createContext(record))
        RuntimePlatformAdapterRegistry.register(adapter)
        this.records.set(record.id, {
          ...record,
          registered: true,
          lifecycleStatus: 'healthy',
          runtimeStatus: { status: 'available' },
          error: undefined,
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
      this.records.set(record.id, {
        ...record,
        registered: false,
        lifecycleStatus: record.enabled ? 'enabled' : 'disabled',
        runtimeStatus: record.enabled ? { status: 'available' } : { status: 'disabled' },
      })
    }
    return this.list()
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
        enabled,
        registered: previous?.registered && previous.enabled === enabled ? previous.registered : false,
        lifecycleStatus: enabled ? 'enabled' : 'disabled',
        runtimeStatus: enabled ? { status: 'available' } : { status: 'disabled' },
        features: config.features ?? {},
        settings: config.settings ?? {},
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

  private writeAudit(entry: PlatformAuditEntry) {
    try {
      void this.audit.write({
        ...entry,
        at: entry.at ?? new Date().toISOString(),
      })
    } catch {
      // Audit is best-effort in Phase 1.
    }
  }
}
