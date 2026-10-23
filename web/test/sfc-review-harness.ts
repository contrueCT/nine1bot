import * as Vue from 'vue'
import * as Icons from 'lucide-vue-next'
import { compileScript, parse } from 'vue/compiler-sfc'

export async function compileComponent(filename: string, deps: Record<string, unknown> = {}, inlineTemplate = false) {
  const { descriptor } = parse(await Bun.file(new URL(`../src/components/${filename}`, import.meta.url)).text())
  const { content } = compileScript(descriptor, {
    id: 'review-regression', inlineTemplate,
    templateOptions: { compilerOptions: { hoistStatic: false } },
  })
  const compiled = new Bun.Transpiler({ loader: 'ts' }).transformSync(content)
    .replace(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["'];?/g, (_full, imports: string, module: string) => {
      const owner = module === 'vue' ? 'Vue' : module === 'lucide-vue-next' ? 'Icons' : 'deps'
      return `const { ${imports.replace(/\bas\b/g, ':')} } = ${owner};`
    })
    .replace(/import\s+(\w+)\s+from\s*["'][^"']+["'];?/g, (_full, name) => `const ${name}=deps.${name};`)
    .replace(/import\(['"]docx-preview['"]\)/g, 'Promise.resolve(deps.docx)')
    .replace('export default', 'return')
  return new Function('Vue', 'Icons', 'deps', compiled)(Vue, Icons, deps)
}

export type Host = {
  type: string; text: string; props: Record<string, any>; children: Host[]; parent?: Host;
  style: { display: string }; replaceChildren(...children: Host[]): void;
}
export function node(type: string, text = ''): Host {
  const value: Host = { type, text, props: {}, children: [], style: { display: '' },
    replaceChildren(...children) {
      value.children = children
      for (const child of children) child.parent = value
    },
  }
  return Vue.markRaw(value)
}
export const renderer = Vue.createRenderer<Host, Host>({
  createElement: type => node(type), createText: value => node('text', value), createComment: value => node('comment', value),
  setText: (item, value) => { item.text = value }, setElementText: (item, value) => { item.text = value; item.children = [] },
  patchProp: (item, key, _previous, value) => { item.props[key] = value },
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child)
    child.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(child); else parent.children.splice(index, 0, child)
  },
  remove(child) { if (child.parent) child.parent.children = child.parent.children.filter(item => item !== child) },
  parentNode: item => item.parent || null,
  nextSibling: item => item.parent?.children[item.parent.children.indexOf(item) + 1] || null,
})
export function descendants(root: Host): Host[] { return [root, ...root.children.flatMap(descendants)] }
export async function settle() { for (let i = 0; i < 8; i++) { await Promise.resolve(); await Vue.nextTick() } }
export function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
