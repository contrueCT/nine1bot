// @ts-expect-error The app tsconfig omits Bun globals; this file runs only under bun test.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createRenderer, createSSRApp, nextTick, type Component } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { compileScript, compileTemplate, parse as parseSfc } from 'vue/compiler-sfc'
import { createServer, normalizePath, type ViteDevServer } from 'vite'
import type { PlatformDetail, PlatformSummary } from '../../api/client'

const webRoot = fileURLToPath(new URL('../../..', import.meta.url))
const clientModuleId = normalizePath(resolve(webRoot, 'src/components/PlatformManager.client-test.ts'))
let server: ViteDevServer
let PlatformManager: Component
let ClientPlatformManager: Component
let originalFetch: typeof globalThis.fetch
let originalWindow: typeof globalThis.window | undefined

beforeAll(async () => {
  originalFetch = globalThis.fetch
  originalWindow = globalThis.window
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost:5173' } },
  })
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    if (url.includes('/webhooks/gitlab/runs')) return Response.json({ runs: [] })
    if (url.includes('/webhooks/status')) return Response.json({})
    return new Response('not found', { status: 404 })
  }
  server = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
    plugins: [{
      name: 'platform-manager-client-test',
      enforce: 'pre',
      resolveId(id) {
        return id === clientModuleId ? id : undefined
      },
      load(id) {
        return id === clientModuleId ? compilePlatformManagerForClientTest() : undefined
      },
    }],
  })
  PlatformManager = (await server.ssrLoadModule('/src/components/PlatformManager.vue')).default
  ClientPlatformManager = (await server.ssrLoadModule(clientModuleId)).default
}, 30_000)

afterAll(async () => {
  globalThis.fetch = originalFetch
  if (originalWindow) {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
  } else {
    delete (globalThis as { window?: unknown }).window
  }
  await server?.close()
})

describe('PlatformManager GitLab deactivation escape paths', () => {
  test('keeps MVP save available when review is disabled with a stale project binding', async () => {
    const mounted = await mountManager(gitLabPlatform({
      enabled: true,
      reviewEnabled: true,
      profiles: [profile({ nine1botProjectID: 'removed-project' })],
    }), [{ id: 'remaining-project', name: 'Remaining', worktree: 'C:/remaining' }])

    changeCheckbox(fieldCheckbox(mounted.root, 'Enable GitLab review'), false)
    await nextTick()

    expect(mvpSaveButton(mounted.root).props.disabled).not.toBe(true)
    submitMvpForm(mounted.root)
    expect(mounted.updates).toEqual([['gitlab', {
      enabled: true,
      settings: expect.objectContaining({ 'review.enabled': false }),
    }]])
    expect((mounted.updates[0]?.[1] as { settings?: Record<string, unknown> }).settings)
      .not.toHaveProperty('review.projects')
    mounted.unmount()
  })

  test('keeps MVP save available when the platform is disabled and the project list is empty', async () => {
    const mounted = await mountManager(gitLabPlatform({
      enabled: true,
      reviewEnabled: true,
      profiles: [profile({ nine1botProjectID: 'temporarily-unavailable' })],
    }), [])

    changeCheckbox(fieldCheckbox(mounted.root, '已启用'), false)
    await nextTick()

    expect(mvpSaveButton(mounted.root).props.disabled).not.toBe(true)
    submitMvpForm(mounted.root)
    expect(mounted.updates[0]?.[1]).toMatchObject({ enabled: false })
    expect((mounted.updates[0]?.[1] as { settings?: Record<string, unknown> }).settings)
      .not.toHaveProperty('review.projects')
    mounted.unmount()
  })

  test('keeps MVP save available when review is disabled with stored profile diagnostics', async () => {
    const mounted = await mountManager(gitLabPlatform({
      enabled: true,
      reviewEnabled: true,
      profiles: [null],
    }), [])

    changeCheckbox(fieldCheckbox(mounted.root, 'Enable GitLab review'), false)
    await nextTick()

    expect(mvpSaveButton(mounted.root).props.disabled).not.toBe(true)
    submitMvpForm(mounted.root)
    expect(mounted.updates).toHaveLength(1)
    expect((mounted.updates[0]?.[1] as { settings?: Record<string, unknown> }).settings)
      .not.toHaveProperty('review.projects')
    mounted.unmount()
  })

  test('blocks active invalid review settings and shows the reason beside the MVP save action', async () => {
    const html = await renderManager(gitLabPlatform({
      enabled: true,
      reviewEnabled: true,
      profiles: [profile({ nine1botProjectID: 'removed-project' })],
    }), [{ id: 'remaining-project', name: 'Remaining', worktree: 'C:/remaining' }])
    const form = mvpForm(html)

    expect(mvpSaveButtonAttributes(html)).toContain('disabled')
    expect(form).toContain('绑定的 Nine1Bot 项目不存在')
  })
})

type HostNode = {
  [key: string]: any
  kind: 'element' | 'text' | 'comment'
  tag: string
  text: string
  props: Record<string, any>
  children: HostNode[]
  parent?: HostNode
  style: Record<string, string>
  listeners: Map<string, Array<(event: unknown) => void>>
  addEventListener: (event: string, listener: (event: unknown) => void) => void
}

const memoryRenderer = createRenderer<HostNode, HostNode>({
  patchProp(element, key, _previousValue, nextValue) {
    element.props[key] = nextValue
    if (key === 'style' && nextValue && typeof nextValue === 'object') {
      Object.assign(element.style, nextValue)
    } else {
      element[key] = nextValue
      if (key === 'value') element._value = nextValue
    }
  },
  insert(child, parent, anchor) {
    child.parent = parent
    const anchorIndex = anchor ? parent.children.indexOf(anchor) : -1
    if (anchorIndex >= 0) parent.children.splice(anchorIndex, 0, child)
    else parent.children.push(child)
  },
  remove(child) {
    const parent = child.parent
    if (!parent) return
    const index = parent.children.indexOf(child)
    if (index >= 0) parent.children.splice(index, 1)
    child.parent = undefined
  },
  createElement(type) {
    return hostNode('element', type)
  },
  createText(text) {
    const node = hostNode('text', '#text')
    node.text = text
    return node
  },
  createComment(text) {
    const node = hostNode('comment', '#comment')
    node.text = text
    return node
  },
  setText(node, text) {
    node.text = text
  },
  setElementText(element, text) {
    const node = hostNode('text', '#text')
    node.text = text
    node.parent = element
    element.children = [node]
  },
  parentNode(node) {
    return node.parent ?? null
  },
  nextSibling(node) {
    const parent = node.parent
    if (!parent) return null
    const index = parent.children.indexOf(node)
    return parent.children[index + 1] ?? null
  },
  querySelector() {
    return null
  },
  setScopeId(element, id) {
    element.props[id] = ''
  },
  cloneNode(node) {
    return { ...node, props: { ...node.props }, children: [...node.children], listeners: new Map(node.listeners) }
  },
  insertStaticContent(content, parent, anchor) {
    const node = hostNode('text', '#static')
    node.text = content
    this.insert(node, parent, anchor)
    return [node, node]
  },
})

async function mountManager(
  selectedPlatform: PlatformDetail,
  projects: Array<{ id: string; name?: string; worktree: string }>,
) {
  const root = hostNode('element', 'root')
  const updates: unknown[][] = []
  const app = memoryRenderer.createApp(ClientPlatformManager, {
    ...managerProps(selectedPlatform, projects),
    onUpdate: (...args: unknown[]) => updates.push(args),
  })
  app.mount(root)
  await nextTick()
  await Promise.resolve()
  return {
    root,
    updates,
    unmount: () => app.unmount(),
  }
}

function hostNode(kind: HostNode['kind'], type: string): HostNode {
  const listeners = new Map<string, Array<(event: unknown) => void>>()
  return {
    kind,
    tag: type,
    text: '',
    props: {},
    children: [],
    style: {},
    listeners,
    addEventListener(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
  }
}

function fieldCheckbox(root: HostNode, label: string) {
  const field = descendants(root).find((node) => (
    node.tag === 'label'
    && nodeText(node).includes(label)
    && descendants(node).some((candidate) => candidate.tag === 'input' && candidate.props.type === 'checkbox')
  ))
  const checkbox = field && descendants(field).find((node) => node.tag === 'input' && node.props.type === 'checkbox')
  if (!checkbox) throw new Error(`Checkbox was not rendered: ${label}`)
  return checkbox
}

function changeCheckbox(checkbox: HostNode, checked: boolean) {
  checkbox.checked = checked
  for (const listener of checkbox.listeners.get('change') ?? []) listener({ target: checkbox })
}

function mvpSaveButton(root: HostNode) {
  const button = descendants(root).find((node) => node.tag === 'button' && nodeText(node).includes('保存 MVP 配置'))
  if (!button) throw new Error('MVP save button was not rendered')
  return button
}

function submitMvpForm(root: HostNode) {
  const form = descendants(root).find((node) => (
    node.tag === 'form'
    && String(node.props.class ?? '').split(/\s+/).includes('gitlab-mvp-form')
  ))
  const submit = form?.props.onSubmit
  if (typeof submit !== 'function') throw new Error('MVP form submit handler was not rendered')
  submit({ preventDefault() {} })
}

function descendants(node: HostNode): HostNode[] {
  return [node, ...node.children.flatMap(descendants)]
}

function nodeText(node: HostNode): string {
  return node.kind === 'text' ? node.text : node.children.map(nodeText).join('')
}

function compilePlatformManagerForClientTest() {
  const filename = resolve(webRoot, 'src/components/PlatformManager.vue')
  const parsed = parseSfc(readFileSync(filename, 'utf8'), { filename })
  if (parsed.errors.length > 0) throw new Error(parsed.errors.map(String).join('\n'))
  const script = compileScript(parsed.descriptor, {
    id: 'data-v-platform-manager-test',
    genDefaultAs: '__sfc__',
  })
  const template = compileTemplate({
    id: 'data-v-platform-manager-test',
    filename,
    source: parsed.descriptor.template?.content ?? '',
    scoped: parsed.descriptor.styles.some((style) => style.scoped),
    compilerOptions: { bindingMetadata: script.bindings },
  })
  if (template.errors.length > 0) throw new Error(template.errors.map(String).join('\n'))
  return [
    script.content,
    template.code.replace('export function render', 'function render'),
    '__sfc__.render = render',
    "__sfc__.__scopeId = 'data-v-platform-manager-test'",
    'export default __sfc__',
  ].join('\n')
}

async function renderManager(
  selectedPlatform: PlatformDetail,
  projects: Array<{ id: string; name?: string; worktree: string }>,
) {
  const app = createSSRApp(PlatformManager, managerProps(selectedPlatform, projects))
  return await renderToString(app)
}

function managerProps(
  selectedPlatform: PlatformDetail,
  projects: Array<{ id: string; name?: string; worktree: string }>,
) {
  return {
    platforms: [summary(selectedPlatform)],
    selectedPlatform,
    selectedPlatformId: selectedPlatform.id,
    loading: false,
    saving: false,
    actionRunning: '',
    error: '',
    actionResult: null,
    providers: [],
    projects,
  }
}

function gitLabPlatform(input: {
  enabled: boolean
  reviewEnabled: boolean
  profiles: unknown[]
}): PlatformDetail {
  const fields = [
    { key: 'review.baseUrl', type: 'string' as const, label: 'GitLab base URL' },
    { key: 'review.tokenSecretRef', type: 'password' as const, label: 'GitLab API token', secret: true },
    { key: 'review.webhookSecretRef', type: 'password' as const, label: 'Webhook secret', secret: true },
    { key: 'review.enabled', type: 'boolean' as const, label: 'Enable GitLab review' },
    { key: 'review.dryRun', type: 'boolean' as const, label: 'Dry run' },
    { key: 'review.modelProviderId', type: 'string' as const, label: 'Model provider' },
    { key: 'review.modelId', type: 'string' as const, label: 'Review model' },
    { key: 'review.projects', type: 'json' as const, label: 'Project profiles' },
  ]
  const config = { sections: [{ id: 'gitlab', title: 'GitLab', fields }] }
  return {
    id: 'gitlab',
    name: 'GitLab',
    packageName: '@nine1bot/platform-gitlab',
    version: '0.1.0',
    installed: true,
    builtIn: true,
    enabled: input.enabled,
    registered: input.enabled,
    lifecycleStatus: input.enabled ? 'enabled' : 'disabled',
    status: input.enabled ? 'available' : 'disabled',
    capabilities: { pageContext: true, settingsPage: true },
    desiredConfigRevision: 1,
    appliedConfigRevision: 1,
    descriptor: {
      id: 'gitlab',
      name: 'GitLab',
      packageName: '@nine1bot/platform-gitlab',
      version: '0.1.0',
      capabilities: { pageContext: true, settingsPage: true },
      config,
      actions: [],
    },
    config,
    actions: [],
    features: {},
    settings: {
      'review.enabled': input.reviewEnabled,
      'review.dryRun': true,
      'review.projects': input.profiles,
    },
    runtimeStatus: {
      status: input.enabled ? 'available' : 'disabled',
      cards: [],
    },
  }
}

function summary(platform: PlatformDetail): PlatformSummary {
  const {
    descriptor: _descriptor,
    config: _config,
    detailPage: _detailPage,
    actions: _actions,
    features: _features,
    settings: _settings,
    runtimeStatus: _runtimeStatus,
    runtimeSources: _runtimeSources,
    runtimeTools: _runtimeTools,
    ...value
  } = platform
  return value
}

function profile(patch: Record<string, unknown> = {}) {
  return {
    id: 'company-project',
    host: 'code.company.example',
    projectId: 42,
    nine1botProjectID: 'project-company',
    pathWithNamespace: 'group/project',
    enabled: true,
    reviewFocus: [],
    includePathPrefixes: [],
    excludePathPatterns: [],
    ci: {
      maxJobLogs: 3,
      maxJobLogBytes: 8_000,
    },
    ...patch,
  }
}

function mvpForm(html: string) {
  const match = html.match(/<form class="gitlab-mvp-form"[\s\S]*?<\/form>/)
  if (!match) throw new Error('MVP form was not rendered')
  return match[0]
}

function mvpSaveButtonAttributes(html: string) {
  const match = mvpForm(html).match(/<button class="btn btn-primary btn-sm" type="submit"([^>]*)>/)
  if (!match) throw new Error('MVP save button was not rendered')
  return match[1] ?? ''
}
