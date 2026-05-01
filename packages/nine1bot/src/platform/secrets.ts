import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname } from 'path'
import type { PlatformSecretAccess, PlatformSecretRef } from '@nine1bot/platform-protocol'
import { getPlatformSecretsPath } from '../config/loader'

type PlatformSecretFile = {
  version: 1
  secrets: Record<string, string>
}

export class FilePlatformSecretStore implements PlatformSecretAccess {
  constructor(private readonly filePath: string = getPlatformSecretsPath()) {}

  async get(ref: PlatformSecretRef): Promise<string | undefined> {
    if (ref.provider === 'env') return process.env[ref.key]
    if (ref.provider === 'external') return undefined
    const store = await this.readStore()
    return store.secrets[ref.key]
  }

  async set(ref: PlatformSecretRef, value: string): Promise<void> {
    this.assertWritable(ref)
    const store = await this.readStore()
    store.secrets[ref.key] = value
    await this.writeStore(store)
  }

  async delete(ref: PlatformSecretRef): Promise<void> {
    this.assertWritable(ref)
    const store = await this.readStore()
    delete store.secrets[ref.key]
    await this.writeStore(store)
  }

  async has(ref: PlatformSecretRef): Promise<boolean> {
    if (ref.provider === 'env') return Boolean(process.env[ref.key])
    if (ref.provider === 'external') return false
    const store = await this.readStore()
    return Object.prototype.hasOwnProperty.call(store.secrets, ref.key)
  }

  private assertWritable(ref: PlatformSecretRef) {
    if (ref.provider === 'env') {
      throw new Error('Environment-backed platform secrets are read-only')
    }
    if (ref.provider === 'external') {
      throw new Error('External platform secrets are managed outside Nine1Bot')
    }
  }

  private async readStore(): Promise<PlatformSecretFile> {
    try {
      const content = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(content) as Partial<PlatformSecretFile>
      if (parsed && typeof parsed === 'object' && parsed.secrets && typeof parsed.secrets === 'object') {
        return {
          version: 1,
          secrets: Object.fromEntries(
            Object.entries(parsed.secrets).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
          ),
        }
      }
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error
    }
    return {
      version: 1,
      secrets: {},
    }
  }

  private async writeStore(store: PlatformSecretFile) {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
    await writeFile(this.filePath, `${JSON.stringify(store, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    })
  }
}
