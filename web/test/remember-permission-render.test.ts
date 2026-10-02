import { expect, test } from 'bun:test'
import { plugin, Transpiler } from 'bun'
import { parse, compileScript } from 'vue/compiler-sfc'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'

// Compile and render the actual SFC, not a copied template or source-text assertion.
plugin({
  name: 'remember-permission-sfc',
  setup(builder) {
    builder.onLoad({ filter: /\/PermissionRequest\.vue$/ }, async ({ path }) => {
      const source = await Bun.file(path).text()
      const { descriptor } = parse(source, { filename: path })
      const compiled = compileScript(descriptor, { id: 'remember-permission-test', inlineTemplate: true })
      return { contents: new Transpiler({ loader: 'ts' }).transformSync(compiled.content), loader: 'js' }
    })
  },
})

const { default: PermissionRequest } = await import('../src/components/PermissionRequest.vue')

function render(metadata: Record<string, unknown>) {
  return renderToString(createSSRApp(PermissionRequest, {
    request: { id: 'permission-test', sessionID: 'session-test', permission: 'remember', patterns: ['project:opaque-id'], metadata },
  }))
}

test('actual permission component shows full scoped preference and readable destination before approval', async () => {
  const content = 'Use strict TypeScript\n<script>Do not execute me</script>\n' + 'x'.repeat(3900) + 'VISIBLE_END'
  const html = await render({ content, scope: 'project', directory: '/projects/readable-name' })
  expect(html).toContain('保存长期偏好')
  expect(html).toContain('仅当前项目')
  expect(html).toContain('/projects/readable-name')
  expect(html).toContain('Use strict TypeScript\n&lt;script&gt;Do not execute me&lt;/script&gt;')
  expect(html).toContain('x'.repeat(3900) + 'VISIBLE_END')
  expect(html).not.toContain('<script>')
  expect(html).not.toContain('opaque-id')
  expect(html).not.toContain('已拒绝')
  expect(html).not.toContain('disabled')
})

test('global preference preview clearly names all projects and incomplete requests cannot be approved', async () => {
  expect(await render({ content: 'concise', scope: 'global', directory: '/projects/active' })).toContain('全局（所有项目）')
  for (const metadata of [{}, { content: 'hidden', scope: 'project' }, { content: 'hidden', scope: 'wrong', directory: '/a' }]) {
    const html = await render(metadata)
    expect(html).toContain('无法核对')
    expect(html.match(/disabled/g)).toHaveLength(2)
    expect(html).toContain('拒绝')
  }
})

test('actual permission SFC visibly escapes bidi and terminal controls in both content and directory', async () => {
  const content = 'plain \u202ehidden-order\u202c \x1b[8mhidden\x1b[0m\r\b\u009b31m\nnext line'
  const directory = '/projects/\u2066target\u2069\u0007\x1b[2J'
  const metadata = { content, scope: 'project', directory }
  const html = await render(metadata)
  expect(html).toContain('plain \\u202ehidden-order\\u202c \\u001b[8mhidden\\u001b[0m\\u000d\\u0008\\u009b31m\nnext line')
  expect(html).toContain('/projects/\\u2066target\\u2069\\u0007\\u001b[2J')
  expect(html).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/)
  expect(metadata).toEqual({ content, scope: 'project', directory })
})
