import { test } from 'bun:test'

// Import the actual runner only when explicitly enabled. Ordinary CI must neither
// launch Chrome nor label skipped integration coverage as a real-browser pass.
const enabled = process.env.RUN_REAL_CHROME === '1'
if (!enabled) console.info('[real-chrome] SKIPPED: set RUN_REAL_CHROME=1 and CHROME_PATH; harness unit tests are synthetic')

test.skipIf(!enabled)('REAL Chrome: bot CDP and installed MV3 extension regression', async () => {
  const { runRealChromeRegression } = await import('./run')
  await runRealChromeRegression()
}, 180000)
