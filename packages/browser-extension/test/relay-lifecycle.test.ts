import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

for (const scenario of ['blank', 'scope', 'stale', 'bootstrap', 'pending', 'reconnect', 'protocol', 'pending_page', 'bridge', 'reconnect_superseded', 'real_tool_cancel', 'native_target_cancel', 'native_explicit_cancel', 'target_revalidation', 'cancel_during_resolution', 'cancel_between_inputs', 'native_timeout', 'user_stop_during_resolution', 'owned_input_cleanup', 'cleanup_target_boundary', 'native_owned_cleanup']) {
  test(`real relay module: ${scenario}`, async () => {
    const home = await mkdtemp(join(tmpdir(), 'nine1-relay-test-'))
    try {
      const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/relay-lifecycle.ts'), scenario], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TMPDIR: home },
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
      expect({ exit, stderr: exit ? stderr : '' }).toEqual({ exit: 0, stderr: '' })
      expect(stdout).toContain(`PASS ${scenario}`)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
}
