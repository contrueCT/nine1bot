import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const apiTarget = process.env.NINE1BOT_API_ORIGIN || 'http://127.0.0.1:4096'

const webRoot = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = path.resolve(webRoot, '..')
const packageJsonPath = path.join(projectRoot, 'packages/nine1bot/package.json')
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))

function readGitValue(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || undefined
  } catch {
    return undefined
  }
}

const webProvenance = {
  productName: 'Nine1Bot',
  packageName: 'nine1bot',
  provenanceId: 'nine1bot.provenance.v1',
  version: process.env.NINE1BOT_VERSION || packageJson.version,
  sourceRepository: 'https://github.com/contrueCT/nine1bot',
  license: 'MIT',
  spdxLicenseIdentifier: 'MIT',
  copyright: 'Copyright (c) 2025-2026 contrueCT / Nine1Bot contributors',
  build: {
    commit: process.env.NINE1BOT_COMMIT || readGitValue(['rev-parse', '--short=12', 'HEAD']),
    date: process.env.NINE1BOT_BUILD_DATE || new Date().toISOString(),
  },
}

export default defineConfig({
  plugins: [vue()],
  define: {
    __NINE1BOT_WEB_PROVENANCE__: JSON.stringify(webProvenance),
  },
  server: {
    proxy: {
      '/access-auth': apiTarget,
      '/nine1bot': apiTarget,
      '/schedules': apiTarget,
      '/session': apiTarget,
      '/event': apiTarget,
      '/file': apiTarget,
      '/project': apiTarget,
      '/global': apiTarget,
      '/find': apiTarget,
      '/mcp': apiTarget,
      '/skill': apiTarget,
      '/provider': apiTarget,
      '/config': apiTarget,
      '/auth': apiTarget,
      '/webhooks': apiTarget,
      '/agent-terminal': apiTarget,
      '/browse': apiTarget,
      '/question': apiTarget,
      '/permission': apiTarget,
      '/preferences': apiTarget,
      // 只代理精确的 /path，不吞掉以 /path 开头的其它前端资源
      '^/path(\\?.*)?$': apiTarget,
    }
  }
})
