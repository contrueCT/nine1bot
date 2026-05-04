import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { serializeFeishuRouteKey } from '../route'
import type { FeishuIMBindingStore, FeishuIMSessionBinding } from '../store/binding-store'

type FeishuIMBindingsFile = {
  version: 2
  bindings: FeishuIMSessionBinding[]
}

export type FeishuFileIMBindingStoreOptions = {
  filepath?: string
  env?: Record<string, string | undefined>
}

export class FeishuFileIMBindingStore implements FeishuIMBindingStore {
  private loaded = false
  private readonly bindings = new Map<string, FeishuIMSessionBinding>()
  readonly filepath: string

  constructor(options: FeishuFileIMBindingStoreOptions = {}) {
    this.filepath = options.filepath ?? defaultFeishuIMBindingStorePath(options.env)
  }

  async get(routeKey: string): Promise<FeishuIMSessionBinding | undefined> {
    await this.load()
    const binding = this.bindings.get(routeKey)
    return binding ? cloneBinding(binding) : undefined
  }

  async set(routeKey: string, binding: FeishuIMSessionBinding): Promise<void> {
    await this.load()
    this.bindings.set(routeKey, cloneBinding(binding))
    await this.save()
  }

  async delete(routeKey: string): Promise<void> {
    await this.load()
    if (!this.bindings.delete(routeKey)) return
    await this.save()
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    if (!(await fileExists(this.filepath))) {
      this.loaded = true
      return
    }

    try {
      const parsed = JSON.parse(await readFile(this.filepath, 'utf8')) as Partial<FeishuIMBindingsFile>
      const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : []
      for (const binding of bindings) {
        if (!isBinding(binding)) continue
        this.bindings.set(serializeFeishuRouteKey(binding.routeKey), cloneBinding(binding))
      }
    } catch {
      this.bindings.clear()
    }
    this.loaded = true
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filepath), { recursive: true })
    const payload: FeishuIMBindingsFile = {
      version: 2,
      bindings: [...this.bindings.values()],
    }
    await writeFile(this.filepath, JSON.stringify(payload, null, 2), 'utf8')
  }
}

export function defaultFeishuIMBindingStorePath(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.NINE1BOT_DATA_DIR
  const base = explicit && explicit.trim()
    ? explicit.trim()
    : process.platform === 'win32'
      ? env.LOCALAPPDATA
        ? join(env.LOCALAPPDATA, 'nine1bot')
        : join(homedir(), 'AppData', 'Local', 'nine1bot')
      : env.XDG_DATA_HOME
        ? join(env.XDG_DATA_HOME, 'nine1bot')
        : join(homedir(), '.local', 'share', 'nine1bot')
  return join(base, 'feishu-im-bindings-v2.json')
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath)
    return true
  } catch {
    return false
  }
}

function isBinding(input: unknown): input is FeishuIMSessionBinding {
  const record = input && typeof input === 'object' ? input as Partial<FeishuIMSessionBinding> : undefined
  return Boolean(
    record?.routeKey &&
    typeof record.sessionId === 'string' &&
    typeof record.updatedAt === 'string',
  )
}

function cloneBinding(binding: FeishuIMSessionBinding): FeishuIMSessionBinding {
  return {
    ...binding,
    routeKey: { ...binding.routeKey },
  }
}
