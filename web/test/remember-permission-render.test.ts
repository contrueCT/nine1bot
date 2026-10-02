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
