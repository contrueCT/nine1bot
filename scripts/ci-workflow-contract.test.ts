import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

async function readCIWorkflow() {
  return (await readFile(join(root, '.github', 'workflows', 'ci.yml'), 'utf8'))
    .replaceAll('\r\n', '\n')
}

async function readRootPackageScripts(): Promise<Record<string, string>> {
  const packageJSON = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>
  }
  return packageJSON.scripts ?? {}
}

describe('CI workflow contract', () => {
  test('keeps the existing four-platform build and startup smoke coverage', async () => {
    const workflow = await readCIWorkflow()

    expect(workflow).toContain('platform: linux\n            arch: x64')
    expect(workflow).toContain('platform: linux\n            arch: arm64')
    expect(workflow).toContain('platform: darwin\n            arch: arm64')
    expect(workflow).toContain('platform: windows\n            arch: x64')
    expect(workflow).toContain('bun run scripts/build.ts --platform=${{ matrix.platform }} --arch=${{ matrix.arch }}')
    expect(workflow).toContain('./scripts/test-startup.sh ${{ matrix.platform }} ${{ matrix.arch }}')
  })

  test('runs strict owned typechecks and every maintained test area', async () => {
    const workflow = await readCIWorkflow()
    const scripts = await readRootPackageScripts()
    const qualityJob = workflow.slice(
      workflow.indexOf('  typecheck:'),
      workflow.indexOf('\n  build:'),
    )

    expect(qualityJob).toContain('bun install --frozen-lockfile')
    expect(qualityJob).not.toContain('|| bun install')
    expect(qualityJob).toContain('bun install --cwd opencode --frozen-lockfile')
    expect(qualityJob).toContain('bun install --cwd packages/nine1bot --frozen-lockfile')
    expect(qualityJob).toContain('bun install --cwd web --frozen-lockfile')
    expect(qualityJob).toContain('bun install --cwd packages/browser-extension --frozen-lockfile')
    expect(qualityJob).toContain('bun run ci:typecheck')
    expect(qualityJob).toContain('bun run ci:test')
    expect(qualityJob).toContain('bun run ci:test:opencode-runtime')
    expect(qualityJob).not.toContain('Typecheck completed with warnings')

    expect(scripts['ci:typecheck']).toContain('packages/platform-protocol')
    expect(scripts['ci:typecheck']).toContain('packages/platform-feishu')
    expect(scripts['ci:typecheck']).toContain('packages/platform-gitlab')
    expect(scripts['ci:typecheck']).toContain('packages/nine1bot')
    expect(scripts['ci:typecheck']).toContain('packages/browser-extension')
    expect(scripts['ci:typecheck']).toContain('packages/browser-mcp-server')
    expect(scripts['ci:typecheck']).toContain('web')

    expect(scripts['ci:test']).toContain('packages/nine1bot/src')
    expect(scripts['ci:test']).toContain('packages/platform-feishu/test')
    expect(scripts['ci:test']).toContain('packages/platform-gitlab/test')
    expect(scripts['ci:test']).toContain('packages/browser-extension/test')
    expect(scripts['ci:test']).toContain('packages/browser-mcp-server/test')
    expect(scripts['ci:test']).toContain('web/test')
    expect(scripts['ci:test']).toContain('scripts')

    expect(scripts['ci:test:opencode-runtime']).toContain('--cwd opencode/packages/opencode')
    expect(scripts['ci:test:opencode-runtime']).toContain('test/platform')
    expect(scripts['ci:test:opencode-runtime']).toContain('test/resource/resource-resolver.test.ts')
    expect(scripts['ci:test:opencode-runtime']).toContain('test/tool/platform-tool-executor.test.ts')
    expect(scripts['ci:test:opencode-runtime']).toContain('test/server/config-routes.test.ts')
    expect(scripts['ci:test:opencode-runtime']).toContain('test/server/nine1bot-platforms.test.ts')
  })
})
