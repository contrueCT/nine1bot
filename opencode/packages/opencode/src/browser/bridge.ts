/**
 * BridgeServer singleton for process-level access.
 *
 * Nine1Bot's server.ts calls setBridgeServer() at startup,
 * then AI tools and routes access it via getBridgeServer().
 */

import type { BridgeServer } from '../../../../packages/browser-mcp-server/src/bridge/server'

let instance: BridgeServer | null = null

export function setBridgeServer(bridge: BridgeServer): void {
  instance = bridge
}

export function getBridgeServer(): BridgeServer | null {
  return instance
}
