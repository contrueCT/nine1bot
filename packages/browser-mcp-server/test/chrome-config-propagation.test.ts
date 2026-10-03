import { expect, test, spyOn } from 'bun:test'
import * as chrome from '../src/core/chrome'
import { BridgeServer } from '../src/bridge/server'

test('explicit and automatic launches forward the custom executable (mocked launcher)', async () => {
  const running = spyOn(chrome, 'isChromeRunning').mockResolvedValue(false)
  const launch = spyOn(chrome, 'launchChrome').mockRejectedValue(new Error('fixture prevents process launch'))
  try {
    const bridge = new BridgeServer({ executablePath: '/opt/My Chrome/chrome', cdpPort: 9333, headless: true })
    await expect(bridge.launchBotBrowser()).rejects.toThrow('fixture prevents process launch')
    expect(launch).toHaveBeenLastCalledWith({ executablePath: '/opt/My Chrome/chrome', cdpPort: 9333, headless: true })
    await expect(bridge.navigate('', { action: 'new_tab', url: 'about:blank' }, 'bot')).rejects.toThrow('fixture prevents process launch')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(launch).toHaveBeenLastCalledWith({ executablePath: '/opt/My Chrome/chrome', cdpPort: 9333, headless: true })
  } finally { running.mockRestore(); launch.mockRestore() }
})
