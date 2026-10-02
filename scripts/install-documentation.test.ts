import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

test('installation links target the maintained repository and config instructions match the loader', async () => {
  const documentation = await readFile(new URL('INSTALL.md', root), 'utf8')
  const installer = await readFile(new URL('install.sh', root), 'utf8')
  expect(documentation).not.toContain('github.com/your-username/nine1bot')
  expect(documentation).not.toContain('githubusercontent.com/your-username/nine1bot')
  expect(installer).not.toContain('github.com/your-username/nine1bot')
  expect(documentation).toContain('~/.config/nine1bot/config.jsonc')
  expect(documentation).toContain('nine1bot config set-password')
  expect(documentation).toContain('nine1bot config migrate-auth')
  const configSection = documentation.split('## 配置文件')[1]!.split('## 隧道配置')[0]!
  const example = JSON.parse(configSection.match(/```json\n([\s\S]*?)\n```/)![1]!)
  expect(example.auth.password).toBeUndefined()
  expect(example.tunnel.enabled).toBe(false)
  expect(example.model).toBeUndefined()
})
