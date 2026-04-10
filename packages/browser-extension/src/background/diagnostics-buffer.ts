let listenersInstalled = false

export function setupDiagnosticsListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true

  self.addEventListener('error', (event) => {
    console.warn('[Relay Client] Unhandled background error:', event.message)
  })

  self.addEventListener('unhandledrejection', (event) => {
    console.warn('[Relay Client] Unhandled background rejection:', event.reason)
  })
}
