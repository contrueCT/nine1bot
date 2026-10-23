// The original bug reproductions are now maintained as passing regression tests.
// Run with: bun review-evidence/ui-review-repro.ts
const root = new URL('../', import.meta.url).pathname
const child = Bun.spawn([
  process.execPath, 'test',
  'web/test/projects-page-ownership.test.ts',
  'web/test/office-preview-component.test.ts',
  'web/test/file-url.test.ts',
], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
process.exit(await child.exited)
