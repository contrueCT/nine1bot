/** Page-scoped CDP operations. The relay must resolve/authorize the managed tab first. */
const supportedMethods = new Set([
  'Page.enable',
  'Page.reload',
  'Page.handleJavaScriptDialog',
  'Page.navigate',
  'Page.getLayoutMetrics',
  'Page.captureScreenshot',
  'Runtime.evaluate',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.querySelector',
])

export async function executePageCdpCommand(
  tabId: number | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  ensureDebuggerAttached: (tabId: number) => Promise<void>,
  assertActive: () => void | Promise<void> = () => {},
  releaseOwnedInput?: (method: string, params: Record<string, unknown>) => Promise<void>,
): Promise<unknown> {
  if (method === 'DOM.setFileInputFiles') {
    // Server paths are not paths on the extension host. Never transfer files or
    // resolve arbitrary client-host paths implicitly through this channel.
    throw new Error('File upload is not supported in the user browser. Use browser="bot" with a file on the bot browser host, or select the file manually in the user browser.')
  }
  if (!supportedMethods.has(method)) {
    throw new Error(`Unsupported CDP method in extension relay: ${method}`)
  }
  if (typeof tabId !== 'number' || !Number.isSafeInteger(tabId) || tabId <= 0) {
    throw new Error('A valid managed browser tab is required')
  }

  const target = { tabId }
  await assertActive()
  await ensureDebuggerAttached(tabId)
  await assertActive()
  let commandParams = { ...params }

  if (method === 'Runtime.evaluate') {
    commandParams = { returnByValue: true, awaitPromise: true, ...commandParams }
  }

  if (method === 'Page.captureScreenshot') {
    const { fullPage, ...captureParams } = commandParams
    commandParams = { format: 'png', ...captureParams }
    if (fullPage) {
      const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics') as {
        cssContentSize?: { x?: number; y?: number; width?: number; height?: number }
        contentSize?: { x?: number; y?: number; width?: number; height?: number }
      }
      const size = metrics?.cssContentSize ?? metrics?.contentSize
      const width = size?.width
      const height = size?.height
      if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 ||
          typeof height !== 'number' || !Number.isFinite(height) || height <= 0) {
        throw new Error('Full-page screenshot failed: invalid page layout metrics')
      }
      commandParams = {
        ...commandParams,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: size?.x ?? 0, y: size?.y ?? 0, width, height, scale: 1 },
      }
    }
  }

  // Preserve the original CDP payload, including wheel deltas, modifiers and
  // optional protocol fields. Chrome validates method-specific parameters.
  await assertActive()
  const result = await chrome.debugger.sendCommand(target, method, commandParams) as {
    errorText?: string
    data?: string
  } | undefined
  try {
    await assertActive()
  } catch (error) {
    // A press accepted just before cancellation may otherwise remain held. Only
    // release that specific input if this command still owns the managed target.
    let release: Record<string, unknown> | undefined
    if (method === 'Input.dispatchMouseEvent' && commandParams.type === 'mousePressed') {
      release = { type: 'mouseReleased', x: commandParams.x, y: commandParams.y, button: commandParams.button ?? 'left', clickCount: 0 }
    } else if (method === 'Input.dispatchKeyEvent' && commandParams.type === 'keyDown') {
      const { text: _text, ...keyParams } = commandParams
      release = { ...keyParams, type: 'keyUp' }
    }
    if (release && releaseOwnedInput) {
      try {
        await releaseOwnedInput(method, release)
      } catch {
        // Never expand cleanup to a different connection, group or target owner.
      }
    }
    throw error
  }
  if (method === 'Page.navigate' && result?.errorText) {
    throw new Error(`Navigation failed: ${result.errorText}`)
  }
  if (method === 'Page.captureScreenshot' && !result?.data) {
    throw new Error('Screenshot failed: no data returned')
  }
  return result ?? {}
}
