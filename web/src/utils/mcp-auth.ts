import { mcpApi } from '../api/client'
import type { McpServer } from '../api/client'

type WaitForMcpAuthOptions = {
  timeoutMs?: number
  onUpdate?: (servers: McpServer[]) => void
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function waitForMcpAuth(name: string, options: WaitForMcpAuthOptions = {}) {
  const { timeoutMs = 120000, onUpdate } = options
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const servers = await mcpApi.list()
    onUpdate?.(servers)

    const match = servers.find(server => server.name === name)
    if (!match) {
      throw new Error(`MCP server not found after auth: ${name}`)
    }

    if (match.status === 'connected') {
      return servers
    }

    if (match.status === 'auth_in_progress') {
      await sleep(1000)
      continue
    }

    if (match.status === 'failed') {
      throw new Error(match.error || `MCP auth failed for ${name}`)
    }

    if (match.status === 'needs_auth') {
      throw new Error(`MCP auth was cancelled or denied for ${name}`)
    }

    if (match.status === 'needs_client_registration') {
      throw new Error(match.error || `MCP server ${name} requires a pre-registered clientId`)
    }

    await sleep(1000)
  }

  throw new Error(`Timed out waiting for MCP auth: ${name}`)
}

export async function authenticateMcpWithPopup(name: string, options: WaitForMcpAuthOptions = {}) {
  const { url } = await mcpApi.startAuth(name)
  const popup = window.open(url, '_blank', 'width=700,height=780')

  if (!popup) {
    window.location.href = url
    return
  }

  return waitForMcpAuth(name, options)
}
