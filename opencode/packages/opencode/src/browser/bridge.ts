/**
 * BridgeServer singleton for process-level access.
 *
 * Nine1Bot's server.ts calls setBridgeServer() at startup,
 * then AI tools and routes access it via getBridgeServer().
 */

import type { Hono } from "hono"

export type BridgeServer = {
  getRoutes(): Hono
  getStatus(): Promise<any>
  launchBotBrowser(options?: any): Promise<any>
  snapshot(...args: any[]): Promise<any>
  screenshot(...args: any[]): Promise<any>
  navigate(...args: any[]): Promise<any>
  clickElement(...args: any[]): Promise<any>
  fillForm(...args: any[]): Promise<any>
  pressKey(...args: any[]): Promise<any>
  scroll(...args: any[]): Promise<any>
  waitForText(...args: any[]): Promise<any>
  handleDialog(...args: any[]): Promise<any>
  findElements(...args: any[]): Promise<any>
  uploadFile(...args: any[]): Promise<any>
  evaluate(...args: any[]): Promise<any>
  readConsoleMessages(...args: any[]): Promise<any>
  readNetworkRequests(...args: any[]): Promise<any>
}

let instance: BridgeServer | null = null

export function setBridgeServer(bridge: BridgeServer): void {
  instance = bridge
}

export function getBridgeServer(): BridgeServer | null {
  return instance
}
