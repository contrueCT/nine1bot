import { BrowserServiceClient } from './service-client'

type InProcessBridgeServer = any

let instance: InProcessBridgeServer | null = null
let serviceClient: BrowserServiceClient | null = null

export function setBridgeServer(bridge: InProcessBridgeServer): void {
  instance = bridge
  serviceClient = null
}

export function clearBridgeServer(): void {
  instance = null
  serviceClient = null
}

export function getBridgeServer(): InProcessBridgeServer | BrowserServiceClient | null {
  if (instance) {
    return instance
  }

  const serviceUrl = process.env.BROWSER_SERVICE_URL
  if (!serviceUrl) {
    return null
  }

  if (!serviceClient || serviceClient.baseUrl !== serviceUrl) {
    serviceClient = new BrowserServiceClient(serviceUrl)
  }

  return serviceClient
}
