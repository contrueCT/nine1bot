import { access, mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getGlobalConfigDir } from '../config/loader'
import type { FeishuBindingsFile, FeishuConversationBinding } from './types'

const STORE_FILENAME = 'feishu-conversations.json'

function createEmptyFile(): FeishuBindingsFile {
  return {
    version: 1,
    bindings: [],
  }
}

async function fileExists(filepath: string): Promise<boolean> {
  try {
    await access(filepath)
    return true
  } catch {
    return false
  }
}

export class FeishuBindingStore {
  private loaded = false
  private bindings = new Map<string, FeishuConversationBinding>()

  get filepath(): string {
    return join(getGlobalConfigDir(), STORE_FILENAME)
  }

  private async load(): Promise<void> {
    if (this.loaded) {
      return
    }

    if (!(await fileExists(this.filepath))) {
      this.loaded = true
      return
    }

    try {
      const content = await readFile(this.filepath, 'utf-8')
      const parsed = JSON.parse(content) as Partial<FeishuBindingsFile>
      const bindings = Array.isArray(parsed.bindings) ? parsed.bindings : []
      this.bindings = new Map(
        bindings
          .filter((binding): binding is FeishuConversationBinding => {
            return !!binding?.bindingKey && !!binding.openId && !!binding.sessionId && !!binding.directory && !!binding.projectId
          })
          .map((binding) => [binding.bindingKey, binding]),
      )
    } catch (error) {
      console.warn('[Nine1Bot] Failed to load Feishu bindings:', error)
      this.bindings.clear()
    }

    this.loaded = true
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.filepath), { recursive: true })
    const data: FeishuBindingsFile = {
      version: 1,
      bindings: [...this.bindings.values()],
    }
    await writeFile(this.filepath, JSON.stringify(data, null, 2), 'utf-8')
  }

  async get(bindingKey: string): Promise<FeishuConversationBinding | undefined> {
    await this.load()
    return this.bindings.get(bindingKey)
  }

  async set(binding: FeishuConversationBinding): Promise<void> {
    await this.load()
    this.bindings.set(binding.bindingKey, binding)
    await this.save()
  }

  async delete(bindingKey: string): Promise<void> {
    await this.load()
    if (!this.bindings.delete(bindingKey)) {
      return
    }
    await this.save()
  }

  async list(): Promise<FeishuConversationBinding[]> {
    await this.load()
    return [...this.bindings.values()]
  }

  async clear(): Promise<void> {
    await this.load()
    this.bindings.clear()
    await this.save()
  }
}

export function getFeishuBindingStorePath(): string {
  return join(getGlobalConfigDir(), STORE_FILENAME)
}
