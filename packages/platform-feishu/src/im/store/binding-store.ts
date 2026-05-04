import type { FeishuIMRouteKey } from '../route'

export type FeishuIMSessionBinding = {
  routeKey: FeishuIMRouteKey
  sessionId: string
  projectId?: string
  directory?: string
  allowedAt?: string
  updatedAt: string
}

export interface FeishuIMBindingStore {
  get(routeKey: string): Promise<FeishuIMSessionBinding | undefined>
  set(routeKey: string, binding: FeishuIMSessionBinding): Promise<void>
  delete(routeKey: string): Promise<void>
}

export class MemoryFeishuIMBindingStore implements FeishuIMBindingStore {
  private readonly bindings = new Map<string, FeishuIMSessionBinding>()

  async get(routeKey: string): Promise<FeishuIMSessionBinding | undefined> {
    const binding = this.bindings.get(routeKey)
    return binding ? cloneBinding(binding) : undefined
  }

  async set(routeKey: string, binding: FeishuIMSessionBinding): Promise<void> {
    this.bindings.set(routeKey, cloneBinding(binding))
  }

  async delete(routeKey: string): Promise<void> {
    this.bindings.delete(routeKey)
  }
}

function cloneBinding(binding: FeishuIMSessionBinding): FeishuIMSessionBinding {
  return {
    ...binding,
    routeKey: { ...binding.routeKey },
  }
}
