import { describe, expect, test } from 'bun:test'
import { runInNewContext } from 'node:vm'
import { buildFindExpression } from './find'
import { buildResolveRefExpression } from './resolve-ref'
import { buildSnapshotExpression } from './snapshot'

type Rect = { x: number; y: number; width: number; height: number }
type StyleState = { display: string; visibility: string; opacity: string }

class FakeTextNode {
  nodeType = 3 as const

  constructor(public textContent: string) {}
}

class FakeElement {
  nodeType = 1 as const
  tagName: string
  parentElement: FakeElement | null = null
  children: FakeElement[] = []
  childNodes: Array<FakeElement | FakeTextNode> = []
  id = ''
  className = ''
  placeholder = ''
  disabled = false
  value = ''
  name = ''
  type = ''
  href = ''
  private attributes = new Map<string, string>()
  private rect: Rect
  private styleState: StyleState

  constructor(
    tagName: string,
    options: {
      rect?: Rect
      style?: Partial<StyleState>
      text?: string
      id?: string
      className?: string
      placeholder?: string
    } = {},
  ) {
    this.tagName = tagName.toUpperCase()
    this.rect = options.rect ?? { x: 0, y: 0, width: 100, height: 30 }
    this.styleState = {
      display: options.style?.display ?? 'block',
      visibility: options.style?.visibility ?? 'visible',
      opacity: options.style?.opacity ?? '1',
    }
    this.id = options.id ?? ''
    this.className = options.className ?? ''
    this.placeholder = options.placeholder ?? ''

    if (options.text) this.append(options.text)
  }

  append(...nodes: Array<FakeElement | FakeTextNode | string>) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        this.childNodes.push(new FakeTextNode(node))
        continue
      }

      if (node instanceof FakeTextNode) {
        this.childNodes.push(node)
        continue
      }

      node.parentElement = this
      this.children.push(node)
      this.childNodes.push(node)
    }
  }

  get textContent(): string {
    return this.childNodes
      .map((node) => (node instanceof FakeTextNode ? node.textContent : node.textContent))
      .join('')
  }

  set textContent(value: string) {
    this.children = []
    this.childNodes = []
    if (value) this.childNodes.push(new FakeTextNode(value))
  }

  getAttribute(name: string): string | null {
    if (name === 'id') return this.id || null
    if (name === 'class') return this.className || null
    if (name === 'disabled') return this.disabled ? '' : null
    return this.attributes.has(name) ? this.attributes.get(name)! : null
  }

  setAttribute(name: string, value: string) {
    if (name === 'id') {
      this.id = value
      return
    }
    if (name === 'class') {
      this.className = value
      return
    }
    if (name === 'disabled') {
      this.disabled = true
    }
    this.attributes.set(name, value)
  }

  getBoundingClientRect(): Rect {
    return { ...this.rect }
  }

  getComputedStyle(): StyleState {
    return { ...this.styleState }
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = []
    for (const child of this.children) {
      visitElement(child, selector, results)
    }
    return results
  }

  scrollIntoView(_options?: unknown) {}

  focus() {}
}

class FakeHTMLButtonElement extends FakeElement {
  constructor(options: ConstructorParameters<typeof FakeElement>[1] = {}) {
    super('button', options)
  }
}

class FakeHTMLAnchorElement extends FakeElement {
  constructor(options: ConstructorParameters<typeof FakeElement>[1] & { href?: string } = {}) {
    super('a', options)
    this.href = options.href ?? 'https://example.com'
  }
}

class FakeHTMLInputElement extends FakeElement {
  constructor(options: ConstructorParameters<typeof FakeElement>[1] & { type?: string; value?: string; name?: string } = {}) {
    super('input', options)
    this.type = options.type ?? 'text'
    this.value = options.value ?? ''
    this.name = options.name ?? ''
  }
}

class FakeHTMLTextAreaElement extends FakeElement {
  constructor(options: ConstructorParameters<typeof FakeElement>[1] = {}) {
    super('textarea', options)
  }
}

class FakeHTMLSelectElement extends FakeElement {
  options: Array<{ value: string; selected: boolean }> = []

  constructor(options: ConstructorParameters<typeof FakeElement>[1] = {}) {
    super('select', options)
  }
}

class FakeDocument {
  constructor(public body: FakeElement) {}

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const results: FakeElement[] = []
    visitElement(this.body, selector, results)
    return results
  }
}

function visitElement(element: FakeElement, selector: string, results: FakeElement[]) {
  if (matchesSelector(element, selector)) results.push(element)
  for (const child of element.children) {
    visitElement(child, selector, results)
  }
}

function matchesSelector(element: FakeElement, selector: string): boolean {
  if (selector === '*') return true

  const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/)
  if (attrMatch) {
    const [, attrName, attrValue] = attrMatch
    const actual = element.getAttribute(attrName)
    if (attrValue === undefined) return actual !== null
    return actual === attrValue
  }

  return false
}

function evaluateExpression(expression: string, body: FakeElement): string {
  const document = new FakeDocument(body)
  const window = {
    getComputedStyle(element: FakeElement) {
      return element.getComputedStyle()
    },
  }

  return String(
    runInNewContext(expression, {
      document,
      window,
      HTMLInputElement: FakeHTMLInputElement,
      HTMLAnchorElement: FakeHTMLAnchorElement,
      HTMLButtonElement: FakeHTMLButtonElement,
      HTMLTextAreaElement: FakeHTMLTextAreaElement,
      HTMLSelectElement: FakeHTMLSelectElement,
      Math,
      JSON,
    }),
  )
}

function findNodeByTag(snapshot: Record<string, unknown>, tag: string): Record<string, unknown> | undefined {
  if (snapshot.tag === tag) return snapshot
  const children = Array.isArray(snapshot.children) ? snapshot.children : []
  for (const child of children) {
    if (child && typeof child === 'object') {
      const found = findNodeByTag(child as Record<string, unknown>, tag)
      if (found) return found
    }
  }
  return undefined
}

describe('browser page scripts', () => {
  test('snapshot keeps the same ref across repeated reads', () => {
    const body = new FakeElement('body')
    const button = new FakeHTMLButtonElement({
      text: '进入选课',
      rect: { x: 120, y: 40, width: 90, height: 32 },
    })
    body.append(button)

    const firstSnapshot = JSON.parse(evaluateExpression(buildSnapshotExpression(), body)) as Record<string, unknown>
    const secondSnapshot = JSON.parse(evaluateExpression(buildSnapshotExpression(), body)) as Record<string, unknown>

    const firstButton = findNodeByTag(firstSnapshot, 'button')
    const secondButton = findNodeByTag(secondSnapshot, 'button')

    expect(firstButton?.ref).toBeDefined()
    expect(secondButton?.ref).toBe(firstButton?.ref)
  })

  test('find preserves refs that were already assigned by snapshot', () => {
    const body = new FakeElement('body')
    const button = new FakeHTMLButtonElement({
      text: '进入选课',
      rect: { x: 160, y: 56, width: 96, height: 32 },
    })
    body.append(button)

    const snapshot = JSON.parse(evaluateExpression(buildSnapshotExpression(), body)) as Record<string, unknown>
    const buttonNode = findNodeByTag(snapshot, 'button')
    const originalRef = String(buttonNode?.ref)

    const matches = JSON.parse(evaluateExpression(buildFindExpression('进入选课'), body)) as Array<{ ref: string; tag: string }>

    expect(matches[0]?.tag).toBe('button')
    expect(matches[0]?.ref).toBe(originalRef)
  })

  test('resolve-ref prefers a clickable descendant over a container cell', () => {
    const body = new FakeElement('body')
    const cell = new FakeElement('td', {
      rect: { x: 20, y: 20, width: 240, height: 60 },
    })
    const label = new FakeElement('span', { text: '进入选课' })
    const button = new FakeHTMLButtonElement({
      text: '进入选课',
      rect: { x: 180, y: 28, width: 72, height: 28 },
    })

    cell.setAttribute('data-mcp-ref', 'ref_cell')
    cell.append(label, button)
    body.append(cell)

    const resolved = JSON.parse(evaluateExpression(buildResolveRefExpression('ref_cell'), body)) as {
      found: boolean
      tagName: string
      resolution: string
      centerX: number
      centerY: number
    }

    expect(resolved.found).toBe(true)
    expect(resolved.tagName).toBe('button')
    expect(resolved.resolution).toBe('descendant')
    expect(resolved.centerX).toBe(216)
    expect(resolved.centerY).toBe(42)
  })

  test('resolve-ref returns a stale-ref diagnostic when other refs still exist', () => {
    const body = new FakeElement('body')
    const button = new FakeHTMLButtonElement({ text: '提交' })
    button.setAttribute('data-mcp-ref', 'ref_existing')
    body.append(button)

    const resolved = JSON.parse(evaluateExpression(buildResolveRefExpression('ref_missing'), body)) as {
      found: boolean
      reason: string
      message: string
    }

    expect(resolved.found).toBe(false)
    expect(resolved.reason).toBe('stale_ref')
    expect(resolved.message).toContain('likely stale')
  })
})
